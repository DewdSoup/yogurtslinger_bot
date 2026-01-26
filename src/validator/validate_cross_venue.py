#!/usr/bin/env python3
"""
validate_cross_venue.py

RIGOROUS validation of cross-venue arbitrage opportunities.

Key differences from extract_alpha_v2.py:
1. EXACT same-slot matching (not 3-slot buckets)
2. Outputs specific signatures for manual verification on Solscan/Explorer
3. Shows raw balance deltas so you can verify the math
4. Calculates theoretical profit INCLUDING realistic fees
5. Flags data quality issues (impossible prices, tiny volumes, etc.)

Usage:
    python3 validate_cross_venue.py helius_alpha_swaps.ndjson
"""

import json
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
import statistics

# Native DEX programs only
NATIVE_DEXES = {
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "PumpSwap",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium_V4",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium_CLMM",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora_DLMM",
}

WSOL = "So11111111111111111111111111111111111111112"
USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
STABLES = {USDC, USDT}

# Realistic fee estimates (in SOL)
JITO_TIP_ESTIMATE = 0.0001  # 100k lamports tip per bundle
TX_FEE = 0.000005  # 5k lamports base fee
SWAP_FEE_BPS = 25  # ~0.25% average swap fee


@dataclass
class SwapData:
    signature: str
    slot: int
    block_time: int
    program: str
    venue: str
    fee_payer: str
    priority_fee_lamports: int
    token_mint: str
    token_delta: float  # UI amount
    quote_mint: str
    quote_delta: float  # UI amount (SOL or stable)
    implied_price: float  # quote per token
    raw_token_balances: List[dict]  # For verification


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


def extract_token_balances(meta: dict) -> Tuple[Dict[str, Dict[str, float]], List[dict]]:
    """
    Returns: (deltas dict, raw balance list for verification)
    """
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []

    raw_balances = []
    pre_map = {}
    post_map = {}

    for b in pre:
        key = (b.get("accountIndex"), b.get("mint"))
        owner = b.get("owner", "")
        ui_amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        raw_amt = b.get("uiTokenAmount", {}).get("amount", "0")
        decimals = b.get("uiTokenAmount", {}).get("decimals", 0)
        pre_map[key] = (ui_amt, owner)
        raw_balances.append({
            "type": "pre",
            "mint": b.get("mint"),
            "owner": owner,
            "uiAmount": ui_amt,
            "rawAmount": raw_amt,
            "decimals": decimals,
        })

    for b in post:
        key = (b.get("accountIndex"), b.get("mint"))
        owner = b.get("owner", "")
        ui_amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        raw_amt = b.get("uiTokenAmount", {}).get("amount", "0")
        decimals = b.get("uiTokenAmount", {}).get("decimals", 0)
        post_map[key] = (ui_amt, owner)
        raw_balances.append({
            "type": "post",
            "mint": b.get("mint"),
            "owner": owner,
            "uiAmount": ui_amt,
            "rawAmount": raw_amt,
            "decimals": decimals,
        })

    deltas = defaultdict(lambda: defaultdict(float))
    for key in set(pre_map.keys()) | set(post_map.keys()):
        idx, mint = key
        pre_amt, pre_owner = pre_map.get(key, (0.0, ""))
        post_amt, post_owner = post_map.get(key, (0.0, pre_owner))
        owner = post_owner or pre_owner
        delta = post_amt - pre_amt
        if abs(delta) > 1e-12:
            deltas[mint][owner] += delta

    return dict(deltas), raw_balances


def get_fee_payer(tx_data: dict) -> str:
    msg = tx_data.get("transaction", {}).get("message", {})
    keys = msg.get("accountKeys", [])
    if not keys:
        return "UNKNOWN"
    first = keys[0]
    if isinstance(first, dict):
        return first.get("pubkey", "UNKNOWN")
    return first


def parse_swap(rec: dict) -> Optional[SwapData]:
    tx = rec.get("tx", {})
    meta = tx.get("meta", {})

    # Skip failed transactions
    if meta.get("err"):
        return None

    program = rec.get("program", "")
    if program not in NATIVE_DEXES:
        return None  # Only native DEXes

    venue = NATIVE_DEXES[program]
    slot = tx.get("slot", 0)
    block_time = tx.get("blockTime", 0)
    signature = rec.get("signature", "")

    fee_payer = get_fee_payer(tx)
    fee_lamports = meta.get("fee", 0)
    priority_fee = max(0, fee_lamports - 5000)

    deltas, raw_balances = extract_token_balances(meta)
    if not deltas:
        return None

    # Identify token and quote sides
    token_mint = None
    token_delta = 0.0
    quote_mint = None
    quote_delta = 0.0

    for mint, owners in deltas.items():
        total = sum(owners.values())
        if mint == WSOL or mint in STABLES:
            if quote_mint is None or mint == WSOL:
                quote_mint = mint
                quote_delta = total
        else:
            if token_mint is None or abs(total) > abs(token_delta):
                token_mint = mint
                token_delta = total

    if not token_mint or not quote_mint:
        return None
    if abs(token_delta) < 1e-12 or abs(quote_delta) < 1e-12:
        return None

    implied_price = abs(quote_delta / token_delta)

    return SwapData(
        signature=signature,
        slot=slot,
        block_time=block_time,
        program=program,
        venue=venue,
        fee_payer=fee_payer,
        priority_fee_lamports=priority_fee,
        token_mint=token_mint,
        token_delta=token_delta,
        quote_mint=quote_mint,
        quote_delta=quote_delta,
        implied_price=implied_price,
        raw_token_balances=raw_balances,
    )


def find_exact_same_slot_opportunities(swaps: List[SwapData]) -> List[dict]:
    """
    Find opportunities where the EXACT SAME SLOT has trades on different venues.
    This is the only scenario where atomic arbitrage is truly possible.
    """
    # Group by (slot, token_mint)
    slot_token_map = defaultdict(list)
    for s in swaps:
        slot_token_map[(s.slot, s.token_mint)].append(s)

    opportunities = []

    for (slot, token), trades in slot_token_map.items():
        # Need at least 2 different venues
        venues = set(t.venue for t in trades)
        if len(venues) < 2:
            continue

        # Group by venue
        by_venue = defaultdict(list)
        for t in trades:
            by_venue[t.venue].append(t)

        # Calculate per-venue prices
        venue_prices = {}
        venue_samples = {}
        for venue, vtrades in by_venue.items():
            prices = [t.implied_price for t in vtrades if t.implied_price > 0]
            if prices:
                # Use median to reduce outlier impact
                venue_prices[venue] = statistics.median(prices)
                venue_samples[venue] = vtrades

        if len(venue_prices) < 2:
            continue

        # Find best buy and sell venues
        sorted_venues = sorted(venue_prices.items(), key=lambda x: x[1])
        buy_venue, buy_price = sorted_venues[0]
        sell_venue, sell_price = sorted_venues[-1]

        if buy_price <= 0:
            continue

        spread_pct = (sell_price - buy_price) / buy_price * 100

        # Filter: require meaningful spread (> 0.5%) but not insane (< 100%)
        if not (0.5 <= spread_pct <= 100):
            continue

        # Get sample transactions for verification
        buy_samples = venue_samples[buy_venue][:3]
        sell_samples = venue_samples[sell_venue][:3]

        # Calculate theoretical profit
        # Assume we buy 1 SOL worth of tokens, then sell
        if buy_price > 0:
            tokens_bought = 1.0 / buy_price  # Tokens per SOL
            sol_received = tokens_bought * sell_price
            gross_profit = sol_received - 1.0

            # Deduct fees
            swap_fee_cost = 2 * SWAP_FEE_BPS / 10000  # Two swaps
            net_profit = gross_profit - swap_fee_cost - JITO_TIP_ESTIMATE - (2 * TX_FEE)
        else:
            net_profit = 0

        opportunities.append({
            "slot": slot,
            "token": token,
            "buy_venue": buy_venue,
            "buy_price": buy_price,
            "sell_venue": sell_venue,
            "sell_price": sell_price,
            "spread_pct": spread_pct,
            "gross_profit_per_sol": gross_profit if buy_price > 0 else 0,
            "net_profit_per_sol": net_profit,
            "profitable_after_fees": net_profit > 0,
            "buy_sample_sigs": [s.signature for s in buy_samples],
            "sell_sample_sigs": [s.signature for s in sell_samples],
            "buy_sample_details": [{
                "sig": s.signature,
                "token_delta": s.token_delta,
                "quote_delta": s.quote_delta,
                "implied_price": s.implied_price,
                "fee_payer": s.fee_payer,
            } for s in buy_samples],
            "sell_sample_details": [{
                "sig": s.signature,
                "token_delta": s.token_delta,
                "quote_delta": s.quote_delta,
                "implied_price": s.implied_price,
                "fee_payer": s.fee_payer,
            } for s in sell_samples],
            "total_trades_in_slot": len(trades),
            "venues_in_slot": list(venues),
        })

    return sorted(opportunities, key=lambda x: x["spread_pct"], reverse=True)


def find_adjacent_slot_opportunities(swaps: List[SwapData], max_slot_gap: int = 1) -> List[dict]:
    """
    Find opportunities in adjacent slots (slot N and N+1).
    Less ideal than same-slot but still potentially actionable.
    """
    # Group by token
    token_swaps = defaultdict(list)
    for s in swaps:
        token_swaps[s.token_mint].append(s)

    opportunities = []

    for token, trades in token_swaps.items():
        if len(trades) < 2:
            continue

        # Sort by slot
        trades = sorted(trades, key=lambda x: x.slot)

        # Look for adjacent slot pairs with different venues
        for i in range(len(trades)):
            for j in range(i + 1, len(trades)):
                t1, t2 = trades[i], trades[j]
                slot_gap = t2.slot - t1.slot

                if slot_gap > max_slot_gap:
                    break  # No need to check further

                if t1.venue == t2.venue:
                    continue

                # Calculate spread
                if t1.implied_price <= 0 or t2.implied_price <= 0:
                    continue

                if t1.implied_price < t2.implied_price:
                    buy, sell = t1, t2
                else:
                    buy, sell = t2, t1

                spread_pct = (sell.implied_price - buy.implied_price) / buy.implied_price * 100

                if not (0.5 <= spread_pct <= 100):
                    continue

                opportunities.append({
                    "slot_range": f"{buy.slot}-{sell.slot}",
                    "slot_gap": slot_gap,
                    "token": token,
                    "buy_venue": buy.venue,
                    "buy_price": buy.implied_price,
                    "buy_sig": buy.signature,
                    "sell_venue": sell.venue,
                    "sell_price": sell.implied_price,
                    "sell_sig": sell.signature,
                    "spread_pct": spread_pct,
                })

    return sorted(opportunities, key=lambda x: x["spread_pct"], reverse=True)


def analyze_data_quality(swaps: List[SwapData]) -> dict:
    """
    Identify potential data quality issues.
    """
    issues = {
        "zero_price_swaps": 0,
        "extreme_prices": [],  # Prices that seem impossible
        "tiny_volumes": 0,  # Swaps < 0.001 SOL
        "same_signer_multi_venue": [],  # Could indicate multi-hop, not arb
    }

    signer_venues = defaultdict(set)

    for s in swaps:
        if s.implied_price == 0:
            issues["zero_price_swaps"] += 1

        # Flag extreme prices (> 1000 SOL per token or < 0.000000001)
        if s.implied_price > 1000 or (0 < s.implied_price < 1e-9):
            issues["extreme_prices"].append({
                "sig": s.signature,
                "token": s.token_mint[:20],
                "price": s.implied_price,
                "venue": s.venue,
            })

        if abs(s.quote_delta) < 0.001:
            issues["tiny_volumes"] += 1

        signer_venues[s.fee_payer].add(s.venue)

    # Find signers who hit multiple venues (could be aggregator users, not arb)
    for signer, venues in signer_venues.items():
        if len(venues) >= 3:
            issues["same_signer_multi_venue"].append({
                "signer": signer,
                "venues": list(venues),
            })

    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate_cross_venue.py <ndjson_path>", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    print(f"Loading {path}...", file=sys.stderr)

    swaps = []
    skipped = 0
    for rec in load_ndjson(path):
        s = parse_swap(rec)
        if s:
            swaps.append(s)
        else:
            skipped += 1

    print(f"Parsed {len(swaps)} native DEX swaps (skipped {skipped})", file=sys.stderr)

    # Data quality check
    quality = analyze_data_quality(swaps)

    # Find opportunities
    same_slot = find_exact_same_slot_opportunities(swaps)
    adjacent_slot = find_adjacent_slot_opportunities(swaps, max_slot_gap=1)

    print()
    print("=" * 80)
    print("CROSS-VENUE ARBITRAGE VALIDATION REPORT")
    print("=" * 80)
    print()

    # Data quality
    print("### DATA QUALITY CHECK ###")
    print(f"Total native DEX swaps: {len(swaps)}")
    print(f"Zero price swaps: {quality['zero_price_swaps']}")
    print(f"Tiny volume swaps (<0.001 SOL): {quality['tiny_volumes']}")
    print(f"Extreme prices detected: {len(quality['extreme_prices'])}")
    if quality['extreme_prices'][:5]:
        print("  Sample extreme prices (possible data issues):")
        for ep in quality['extreme_prices'][:5]:
            print(f"    {ep['venue']}: {ep['token']}... @ {ep['price']:.12f}")
    print(f"Multi-venue signers (possible aggregator): {len(quality['same_signer_multi_venue'])}")
    print()

    # Same-slot opportunities (MOST RELIABLE)
    print("### EXACT SAME-SLOT OPPORTUNITIES (Most Reliable) ###")
    print(f"Found: {len(same_slot)}")
    print()

    if same_slot:
        profitable = [o for o in same_slot if o["profitable_after_fees"]]
        print(f"Profitable after fees: {len(profitable)}")
        print()

        for i, opp in enumerate(same_slot[:10]):
            profitable_tag = "✅ PROFITABLE" if opp["profitable_after_fees"] else "❌ Not profitable after fees"
            print(f"{i+1}. Slot {opp['slot']} | {opp['token'][:20]}...")
            print(f"   Spread: {opp['spread_pct']:.2f}% | {profitable_tag}")
            print(f"   Buy @ {opp['buy_venue']}: {opp['buy_price']:.12f}")
            print(f"   Sell @ {opp['sell_venue']}: {opp['sell_price']:.12f}")
            print(f"   Gross profit/SOL: {opp['gross_profit_per_sol']:.6f}")
            print(f"   Net profit/SOL: {opp['net_profit_per_sol']:.6f}")
            print(f"   Total trades in slot: {opp['total_trades_in_slot']}")
            print()
            print(f"   === VERIFY THESE SIGNATURES ===")
            print(f"   Buy samples ({opp['buy_venue']}):")
            for d in opp["buy_sample_details"][:2]:
                print(f"     https://solscan.io/tx/{d['sig']}")
                print(f"       token_delta={d['token_delta']:.6f}, quote_delta={d['quote_delta']:.6f}, price={d['implied_price']:.12f}")
            print(f"   Sell samples ({opp['sell_venue']}):")
            for d in opp["sell_sample_details"][:2]:
                print(f"     https://solscan.io/tx/{d['sig']}")
                print(f"       token_delta={d['token_delta']:.6f}, quote_delta={d['quote_delta']:.6f}, price={d['implied_price']:.12f}")
            print()
            print("-" * 60)
            print()
    else:
        print("   ⚠️  NO exact same-slot cross-venue opportunities found.")
        print("   This could mean:")
        print("   1. Arb bots are already capturing these (good market efficiency)")
        print("   2. Sample size too small (30 min may not be enough)")
        print("   3. Need to look at adjacent slots")
        print()

    # Adjacent slot opportunities
    print("### ADJACENT SLOT OPPORTUNITIES (slot gap ≤ 1) ###")
    print(f"Found: {len(adjacent_slot)}")
    print()

    if adjacent_slot:
        for i, opp in enumerate(adjacent_slot[:10]):
            print(f"{i+1}. Slots {opp['slot_range']} | {opp['token'][:20]}...")
            print(f"   Spread: {opp['spread_pct']:.2f}%")
            print(f"   Buy @ {opp['buy_venue']}: {opp['buy_price']:.12f}")
            print(f"   Sell @ {opp['sell_venue']}: {opp['sell_price']:.12f}")
            print(f"   Verify:")
            print(f"     Buy:  https://solscan.io/tx/{opp['buy_sig']}")
            print(f"     Sell: https://solscan.io/tx/{opp['sell_sig']}")
            print()

    # Summary
    print("=" * 80)
    print("VALIDATION SUMMARY")
    print("=" * 80)
    print()

    if same_slot:
        print(f"✅ Found {len(same_slot)} same-slot opportunities")
        profitable = [o for o in same_slot if o["profitable_after_fees"]]
        if profitable:
            print(f"✅ {len(profitable)} are profitable after realistic fees")
            print(f"   Best spread: {same_slot[0]['spread_pct']:.2f}%")
        else:
            print(f"⚠️  None profitable after fees (spreads too small)")
    else:
        print("❌ No same-slot opportunities - either too efficient or need more data")

    print()
    print("RECOMMENDED NEXT STEPS:")
    print("1. Verify the Solscan links above manually")
    print("2. Run data capture for 24-48 hours for statistical significance")
    print("3. Add status filter to ingest (filter failed txs at source)")
    print("4. If opportunities validate, they are REAL but may be captured by faster bots")


if __name__ == "__main__":
    main()