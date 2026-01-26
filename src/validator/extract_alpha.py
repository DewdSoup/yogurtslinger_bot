#!/usr/bin/env python3
"""
extract_alpha_v2.py

Refined alpha extraction - fixes Jupiter aggregator false positives,
focuses on same-token/different-venue/same-slot price divergence.

Key insight: Jupiter routes THROUGH other DEXes, so Jupiter "price" 
is not a separate venue price - it's an aggregated route.

Real alpha:
1. Same token on PumpSwap vs Raydium (native venues, not aggregators)
2. Jito bundle patterns (0 priority fee = bundle submission)
3. Sandwich profitability by venue
4. Large trade front-running opportunities
"""

import json
import sys
from collections import Counter, defaultdict
from typing import Dict, List, Optional
from dataclasses import dataclass
import statistics

# Native DEX programs (NOT aggregators)
NATIVE_DEXES = {
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium_V4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium_CLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora_DLMM",
}

# Aggregators - exclude from cross-venue arb detection
AGGREGATORS = {
    "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter_V4",
    "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB": "Jupiter_V3",
}

WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"

STABLES = {USDC, USDT}


@dataclass
class SwapEvent:
    signature: str
    slot: int
    block_time: int
    program: str
    venue: str
    fee_payer: str
    fee_lamports: int
    priority_fee: int
    # Token side of the swap (non-SOL, non-stable)
    token_mint: str
    token_delta: float  # Positive = buy, negative = sell
    # Quote side (SOL or stable)
    quote_mint: str
    quote_delta: float
    # Implied price: quote per token
    implied_price: float
    is_native_dex: bool


def safe_float(v) -> float:
    try:
        f = float(v)
        return 0.0 if f != f else f
    except:
        return 0.0


def load_ndjson(path):
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    yield json.loads(line)
                except:
                    pass


def extract_balance_deltas(meta: dict) -> Dict[str, Dict[str, float]]:
    """Extract token balance changes: {mint: {owner: delta}}"""
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []

    pre_map = {}
    post_map = {}

    for b in pre:
        key = (b.get("accountIndex"), b.get("mint"))
        owner = b.get("owner", "")
        amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        pre_map[key] = (amt, owner)

    for b in post:
        key = (b.get("accountIndex"), b.get("mint"))
        owner = b.get("owner", "")
        amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        post_map[key] = (amt, owner)

    deltas = defaultdict(lambda: defaultdict(float))
    for key in set(pre_map.keys()) | set(post_map.keys()):
        idx, mint = key
        pre_amt, pre_owner = pre_map.get(key, (0.0, ""))
        post_amt, post_owner = post_map.get(key, (0.0, pre_owner))
        owner = post_owner or pre_owner
        delta = post_amt - pre_amt
        if abs(delta) > 1e-12:
            deltas[mint][owner] += delta

    return dict(deltas)


def get_fee_payer(tx_data: dict) -> str:
    msg = tx_data.get("transaction", {}).get("message", {})
    keys = msg.get("accountKeys", [])
    if not keys:
        return "UNKNOWN"
    first = keys[0]
    if isinstance(first, dict):
        return first.get("pubkey", "UNKNOWN")
    return first


def parse_swap_event(rec: dict) -> Optional[SwapEvent]:
    """Parse a transaction into a normalized swap event."""
    tx = rec.get("tx", {})
    meta = tx.get("meta", {})

    if meta.get("err"):
        return None

    program = rec.get("program", "")
    is_native = program in NATIVE_DEXES
    venue = NATIVE_DEXES.get(program) or AGGREGATORS.get(program, program[:8])

    slot = tx.get("slot", 0)
    block_time = tx.get("blockTime", 0)
    signature = rec.get("signature", "")

    fee_payer = get_fee_payer(tx)
    fee_lamports = meta.get("fee", 0)
    priority_fee = max(0, fee_lamports - 5000)

    deltas = extract_balance_deltas(meta)
    if not deltas:
        return None

    # Find the token and quote sides
    # Quote = WSOL or stablecoin
    # Token = everything else
    token_mint = None
    token_delta = 0.0
    quote_mint = None
    quote_delta = 0.0

    for mint, owners in deltas.items():
        total = sum(owners.values())
        if mint == WSOL or mint in STABLES:
            if quote_mint is None or mint == WSOL:  # Prefer WSOL as quote
                quote_mint = mint
                quote_delta = total
        else:
            # Take the token with largest absolute delta
            if token_mint is None or abs(total) > abs(token_delta):
                token_mint = mint
                token_delta = total

    if not token_mint or not quote_mint:
        return None

    if token_delta == 0 or quote_delta == 0:
        return None

    # Calculate implied price (quote per token)
    # If buying tokens (token_delta > 0), we spent quote (quote_delta < 0)
    # Price = abs(quote_delta) / abs(token_delta)
    implied_price = abs(quote_delta / token_delta)

    return SwapEvent(
        signature=signature,
        slot=slot,
        block_time=block_time,
        program=program,
        venue=venue,
        fee_payer=fee_payer,
        fee_lamports=fee_lamports,
        priority_fee=priority_fee,
        token_mint=token_mint,
        token_delta=token_delta,
        quote_mint=quote_mint,
        quote_delta=quote_delta,
        implied_price=implied_price,
        is_native_dex=is_native,
    )


def find_real_cross_venue_arb(events: List[SwapEvent]) -> List[dict]:
    """
    Find price discrepancies between NATIVE DEXes only (no aggregators).
    Same token, same slot range (±2 slots), different native venues.
    """
    # Group by (token_mint, slot_bucket) - bucket by 3 slots
    slot_token_events = defaultdict(list)

    for e in events:
        if not e.is_native_dex:
            continue
        bucket = e.slot // 3
        slot_token_events[(e.token_mint, bucket)].append(e)

    opportunities = []

    for (token, bucket), group in slot_token_events.items():
        # Need events from at least 2 different native venues
        venues = set(e.venue for e in group)
        if len(venues) < 2:
            continue

        # Group by venue and get avg price
        venue_prices = defaultdict(list)
        for e in group:
            venue_prices[e.venue].append(e.implied_price)

        venue_avg = {}
        for v, prices in venue_prices.items():
            # Filter outliers (prices within 2x of median)
            if len(prices) >= 1:
                med = statistics.median(prices)
                filtered = [p for p in prices if 0.5 * med <= p <= 2 * med]
                if filtered:
                    venue_avg[v] = statistics.mean(filtered)

        if len(venue_avg) < 2:
            continue

        # Find spread between venues
        sorted_venues = sorted(venue_avg.items(), key=lambda x: x[1])
        low_venue, low_price = sorted_venues[0]
        high_venue, high_price = sorted_venues[-1]

        if low_price <= 0:
            continue

        spread_pct = (high_price - low_price) / low_price * 100

        # Only report meaningful spreads (0.1% to 50%)
        if 0.1 <= spread_pct <= 50:
            opportunities.append({
                "token": token,
                "slot_bucket": bucket * 3,
                "low_venue": low_venue,
                "low_price": low_price,
                "high_venue": high_venue,
                "high_price": high_price,
                "spread_pct": spread_pct,
                "sample_count": len(group),
            })

    return sorted(opportunities, key=lambda x: x["spread_pct"], reverse=True)


def analyze_jito_bundle_patterns(events: List[SwapEvent]) -> dict:
    """
    Identify Jito bundle users (0 priority fee = not competing in mempool).
    """
    zero_fee_signers = defaultdict(lambda: {
        "tx_count": 0,
        "total_quote_volume": 0.0,
        "venues": Counter(),
        "tokens": set(),
        "slots": [],
    })

    for e in events:
        if e.priority_fee == 0:
            stats = zero_fee_signers[e.fee_payer]
            stats["tx_count"] += 1
            stats["total_quote_volume"] += abs(e.quote_delta)
            stats["venues"][e.venue] += 1
            stats["tokens"].add(e.token_mint)
            stats["slots"].append(e.slot)

    results = []
    for signer, stats in zero_fee_signers.items():
        if stats["tx_count"] < 3:
            continue

        # Calculate slot clustering (are txs happening in bursts?)
        slots = sorted(stats["slots"])
        gaps = [slots[i+1] - slots[i] for i in range(len(slots)-1)]
        avg_gap = statistics.mean(gaps) if gaps else 0

        results.append({
            "signer": signer,
            "tx_count": stats["tx_count"],
            "quote_volume": stats["total_quote_volume"],
            "primary_venue": stats["venues"].most_common(1)[0][0],
            "venue_dist": dict(stats["venues"]),
            "unique_tokens": len(stats["tokens"]),
            "avg_slot_gap": avg_gap,
            "likely_jito": avg_gap < 10,  # Clustered txs = likely bundles
        })

    return {
        "total_zero_fee_signers": len(results),
        "likely_jito_users": [r for r in results if r["likely_jito"]],
        "by_volume": sorted(results, key=lambda x: x["quote_volume"], reverse=True)[:30],
    }


def analyze_large_trade_patterns(events: List[SwapEvent]) -> dict:
    """
    Find large trades that could be front-run or sandwiched.
    """
    large_trades = []

    for e in events:
        # >5 SOL trades (or equivalent in stables)
        if abs(e.quote_delta) > 5.0:
            large_trades.append({
                "signature": e.signature,
                "slot": e.slot,
                "venue": e.venue,
                "token": e.token_mint,
                "direction": "BUY" if e.token_delta > 0 else "SELL",
                "quote_amount": abs(e.quote_delta),
                "token_amount": abs(e.token_delta),
                "price": e.implied_price,
                "fee_payer": e.fee_payer,
                "priority_fee": e.priority_fee,
            })

    # Group by token to find frequently traded large-cap tokens
    token_large_trades = defaultdict(list)
    for t in large_trades:
        token_large_trades[t["token"]].append(t)

    frequent_large_tokens = []
    for token, trades in token_large_trades.items():
        if len(trades) >= 3:
            total_volume = sum(t["quote_amount"] for t in trades)
            frequent_large_tokens.append({
                "token": token,
                "trade_count": len(trades),
                "total_volume": total_volume,
                "venues": list(set(t["venue"] for t in trades)),
                "avg_size": total_volume / len(trades),
            })

    return {
        "total_large_trades": len(large_trades),
        "top_trades": sorted(large_trades, key=lambda x: x["quote_amount"], reverse=True)[:30],
        "frequent_large_tokens": sorted(frequent_large_tokens, key=lambda x: x["total_volume"], reverse=True)[:20],
    }


def analyze_venue_competition(events: List[SwapEvent]) -> dict:
    """
    Detailed priority fee analysis by venue - your competitive edge.
    """
    venue_data = defaultdict(lambda: {
        "fees": [],
        "zero_fee_count": 0,
        "total_count": 0,
    })

    for e in events:
        if not e.is_native_dex:
            continue
        venue_data[e.venue]["fees"].append(e.priority_fee)
        venue_data[e.venue]["total_count"] += 1
        if e.priority_fee == 0:
            venue_data[e.venue]["zero_fee_count"] += 1

    results = {}
    for venue, data in venue_data.items():
        fees = sorted(data["fees"])
        n = len(fees)
        if n < 10:
            continue

        results[venue] = {
            "total_txs": n,
            "zero_fee_pct": data["zero_fee_count"] / n * 100,
            "p50": fees[n // 2],
            "p75": fees[int(n * 0.75)],
            "p90": fees[int(n * 0.90)],
            "p95": fees[int(n * 0.95)],
            "p99": fees[int(n * 0.99)],
            "max": fees[-1],
            # Effective competition: what you need to beat
            "beat_50pct": fees[n // 2] + 1000,
            "beat_90pct": fees[int(n * 0.90)] + 1000,
            "beat_99pct": fees[int(n * 0.99)] + 1000,
        }

    return results


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 extract_alpha_v2.py <ndjson_path>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    print(f"Loading {path}...", file=sys.stderr)

    events = []
    skipped = 0
    for rec in load_ndjson(path):
        e = parse_swap_event(rec)
        if e:
            events.append(e)
        else:
            skipped += 1

    print(f"Parsed {len(events)} swap events, skipped {skipped}", file=sys.stderr)

    # Run analyses
    arb_opps = find_real_cross_venue_arb(events)
    jito_patterns = analyze_jito_bundle_patterns(events)
    large_trades = analyze_large_trade_patterns(events)
    venue_comp = analyze_venue_competition(events)

    print()
    print("=" * 80)
    print("YOGURTSLINGER ALPHA REPORT v2 - REAL OPPORTUNITIES")
    print("=" * 80)
    print()

    # === VENUE COMPETITION (YOUR EDGE) ===
    print("### VENUE COMPETITION ANALYSIS ###")
    print("(Lower P90 = less competition = your computational edge matters more)")
    print()
    
    sorted_venues = sorted(venue_comp.items(), key=lambda x: x[1]["p90"])
    for venue, stats in sorted_venues:
        jito_pct = stats["zero_fee_pct"]
        print(f"{venue}:")
        print(f"  TXs: {stats['total_txs']} | Jito bundles: {jito_pct:.1f}%")
        print(f"  P50: {stats['p50']:,} | P90: {stats['p90']:,} | P99: {stats['p99']:,}")
        print(f"  → Beat 90% with: {stats['beat_90pct']:,} lamports")
        print()

    # === REAL CROSS-VENUE ARB ===
    print("### REAL CROSS-VENUE ARBITRAGE (Native DEXes Only) ###")
    print(f"Found {len(arb_opps)} opportunities with 0.1-50% spread")
    print()
    
    if arb_opps:
        for i, opp in enumerate(arb_opps[:15]):
            print(f"{i+1}. Token: {opp['token'][:20]}...")
            print(f"   Spread: {opp['spread_pct']:.2f}%")
            print(f"   Buy @ {opp['low_venue']}: {opp['low_price']:.9f}")
            print(f"   Sell @ {opp['high_venue']}: {opp['high_price']:.9f}")
            print(f"   Slot: ~{opp['slot_bucket']}")
            print()
    else:
        print("   No significant cross-venue spreads detected in this window.")
        print("   This is EXPECTED - arb is competitive. Monitor in real-time.")
        print()

    # === JITO BUNDLE PATTERNS ===
    print("### JITO BUNDLE USERS (0 Priority Fee = Direct to Block Builder) ###")
    print(f"Total zero-fee signers: {jito_patterns['total_zero_fee_signers']}")
    print(f"Likely Jito users (clustered txs): {len(jito_patterns['likely_jito_users'])}")
    print()
    
    print("Top by volume:")
    for i, u in enumerate(jito_patterns["by_volume"][:10]):
        jito_tag = "🎯 JITO" if u["likely_jito"] else ""
        print(f"  {i+1}. {u['signer'][:30]}...")
        print(f"     Volume: {u['quote_volume']:.2f} SOL | TXs: {u['tx_count']} | Gap: {u['avg_slot_gap']:.1f} slots {jito_tag}")
        print(f"     Venue: {u['primary_venue']} | Tokens: {u['unique_tokens']}")
        print()

    # === LARGE TRADES (SANDWICH TARGETS) ===
    print("### LARGE TRADES (>5 SOL) - SANDWICH TARGETS ###")
    print(f"Total: {large_trades['total_large_trades']}")
    print()
    
    print("Top 15 by size:")
    for i, t in enumerate(large_trades["top_trades"][:15]):
        print(f"  {i+1}. {t['direction']} {t['quote_amount']:.2f} SOL @ {t['venue']}")
        print(f"     Token: {t['token'][:20]}...")
        print(f"     Priority fee: {t['priority_fee']:,} lamports")
        print()

    print("Frequently traded large tokens (multiple >5 SOL trades):")
    for t in large_trades["frequent_large_tokens"][:10]:
        print(f"  - {t['token'][:20]}... | {t['trade_count']} trades | {t['total_volume']:.1f} SOL total")
        print(f"    Venues: {t['venues']}")
    print()

    # === ACTIONABLE SUMMARY ===
    print("=" * 80)
    print("ACTIONABLE SUMMARY")
    print("=" * 80)
    print()

    # Find lowest competition venue
    if venue_comp:
        lowest_comp = sorted_venues[0]
        print(f"1. LOWEST COMPETITION VENUE: {lowest_comp[0]}")
        print(f"   P90 = {lowest_comp[1]['p90']:,} lamports (vs {sorted_venues[-1][1]['p90']:,} on {sorted_venues[-1][0]})")
        print(f"   → Focus your arb detection here first")
        print()

    print("2. JITO BUNDLE STRATEGY:")
    print("   Top profitable bots use 0 priority fee = pure Jito bundles")
    print("   You have Jito whitelist - use bundle submission, not mempool")
    print()

    if large_trades["frequent_large_tokens"]:
        top_token = large_trades["frequent_large_tokens"][0]
        print(f"3. HOT TOKEN TO MONITOR: {top_token['token'][:30]}...")
        print(f"   {top_token['trade_count']} large trades, {top_token['total_volume']:.1f} SOL volume")
        print(f"   Venues: {top_token['venues']}")
        print()

    print("4. PRIORITY FEE TARGETS BY VENUE:")
    for venue, stats in sorted_venues:
        print(f"   {venue}: {stats['beat_90pct']:,} lamports (beats 90%)")


if __name__ == "__main__":
    main()