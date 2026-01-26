#!/usr/bin/env python3
"""
validate_cross_venue_v2.py

FIXED validation with:
1. Proper signature extraction
2. Correct price direction (SOL per token, not token per SOL)
3. Minimum volume thresholds
4. JSON output for further analysis
5. Raw data dump for manual verification

Usage:
    python3 validate_cross_venue_v2.py helius_alpha_swaps.ndjson
    python3 validate_cross_venue_v2.py helius_alpha_swaps.ndjson --json-out validation_results.json
"""

import json
import sys
from collections import defaultdict
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, asdict
from datetime import datetime
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
QUOTE_TOKENS = {WSOL, USDC, USDT}

# Minimum thresholds to filter noise
MIN_QUOTE_VOLUME = 0.01  # Minimum 0.01 SOL trade
MIN_TOKEN_VOLUME = 0.0001  # Minimum token amount

# Fee estimates
JITO_TIP = 0.0001  # 100k lamports
TX_FEE = 0.000005  # 5k lamports
SWAP_FEE_PCT = 0.003  # 0.3% per swap


@dataclass
class ParsedSwap:
    signature: str
    slot: int
    block_time: int
    venue: str
    fee_payer: str
    priority_fee_lamports: int
    
    # The memecoin/token being traded
    token_mint: str
    token_amount: float  # Absolute value
    token_direction: str  # "BUY" or "SELL"
    
    # The quote (SOL/USDC)
    quote_mint: str
    quote_amount: float  # Absolute value
    
    # Price in quote per token (e.g., 0.001 SOL per BONK)
    price_quote_per_token: float


def safe_float(v) -> float:
    try:
        f = float(v)
        return 0.0 if f != f else f
    except:
        return 0.0


def load_ndjson(path):
    count = 0
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    count += 1
                    yield json.loads(line)
                except:
                    pass
    print(f"  Read {count} lines from {path}", file=sys.stderr)


def extract_balance_changes(meta: dict) -> Dict[str, float]:
    """
    Returns: {mint: net_change} for the transaction
    Aggregates all account changes per mint.
    """
    pre = meta.get("preTokenBalances", []) or []
    post = meta.get("postTokenBalances", []) or []

    # Build maps keyed by (accountIndex, mint)
    pre_map = {}
    post_map = {}

    for b in pre:
        key = (b.get("accountIndex"), b.get("mint"))
        ui_amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        pre_map[key] = ui_amt

    for b in post:
        key = (b.get("accountIndex"), b.get("mint"))
        ui_amt = safe_float(b.get("uiTokenAmount", {}).get("uiAmount", 0))
        post_map[key] = ui_amt

    # Calculate deltas per mint (aggregate across all accounts)
    mint_deltas = defaultdict(float)
    all_keys = set(pre_map.keys()) | set(post_map.keys())
    
    for key in all_keys:
        idx, mint = key
        if not mint:
            continue
        pre_amt = pre_map.get(key, 0.0)
        post_amt = post_map.get(key, 0.0)
        delta = post_amt - pre_amt
        mint_deltas[mint] += delta

    return dict(mint_deltas)


def get_fee_payer(tx_data: dict) -> str:
    msg = tx_data.get("transaction", {}).get("message", {})
    keys = msg.get("accountKeys", [])
    if not keys:
        return "UNKNOWN"
    first = keys[0]
    if isinstance(first, dict):
        return first.get("pubkey", "UNKNOWN")
    return str(first) if first else "UNKNOWN"


def parse_swap(rec: dict) -> Optional[ParsedSwap]:
    """
    Parse a transaction record into a normalized swap.
    
    Key logic:
    - Quote token = WSOL, USDC, or USDT
    - Token = everything else
    - If user gains tokens and loses quote -> BUY
    - If user loses tokens and gains quote -> SELL
    - Price = quote_amount / token_amount (SOL per token)
    """
    tx = rec.get("tx", {})
    meta = tx.get("meta", {})

    # Skip failed transactions
    if meta.get("err"):
        return None

    program = rec.get("program", "")
    if program not in NATIVE_DEXES:
        return None

    venue = NATIVE_DEXES[program]
    slot = tx.get("slot", 0)
    block_time = tx.get("blockTime", 0)
    
    # CRITICAL: Extract signature correctly
    signature = rec.get("signature", "") or tx.get("signature", "")
    if not signature:
        # Try to find it in the transaction structure
        tx_inner = tx.get("transaction", {})
        sigs = tx_inner.get("signatures", [])
        if sigs:
            signature = sigs[0]
    
    if not signature:
        return None  # Can't verify without signature

    fee_payer = get_fee_payer(tx)
    fee_lamports = meta.get("fee", 0)
    priority_fee = max(0, fee_lamports - 5000)

    # Get balance changes
    deltas = extract_balance_changes(meta)
    if not deltas:
        return None

    # Separate quote and token
    quote_mint = None
    quote_delta = 0.0
    token_mint = None
    token_delta = 0.0

    for mint, delta in deltas.items():
        if mint in QUOTE_TOKENS:
            # Prefer WSOL as quote
            if quote_mint is None or mint == WSOL:
                quote_mint = mint
                quote_delta = delta
        else:
            # Take token with largest absolute change
            if token_mint is None or abs(delta) > abs(token_delta):
                token_mint = mint
                token_delta = delta

    if not token_mint or not quote_mint:
        return None

    # Apply minimum thresholds
    if abs(quote_delta) < MIN_QUOTE_VOLUME:
        return None
    if abs(token_delta) < MIN_TOKEN_VOLUME:
        return None

    # Determine direction
    # BUY token = gain tokens (positive delta), lose quote (negative delta)
    # SELL token = lose tokens (negative delta), gain quote (positive delta)
    if token_delta > 0 and quote_delta < 0:
        direction = "BUY"
    elif token_delta < 0 and quote_delta > 0:
        direction = "SELL"
    else:
        # Unusual case - both positive or both negative
        # Could be complex transaction, skip
        return None

    # Calculate price: quote per token
    token_amount = abs(token_delta)
    quote_amount = abs(quote_delta)
    
    if token_amount < 1e-15:
        return None  # Avoid division issues
    
    price = quote_amount / token_amount

    # Sanity check price (between 1e-15 and 1e6 SOL per token)
    if price < 1e-15 or price > 1e6:
        return None

    return ParsedSwap(
        signature=signature,
        slot=slot,
        block_time=block_time,
        venue=venue,
        fee_payer=fee_payer,
        priority_fee_lamports=priority_fee,
        token_mint=token_mint,
        token_amount=token_amount,
        token_direction=direction,
        quote_mint=quote_mint,
        quote_amount=quote_amount,
        price_quote_per_token=price,
    )


def find_same_slot_opportunities(swaps: List[ParsedSwap]) -> List[dict]:
    """
    Find exact same-slot, different-venue trades for the same token.
    """
    # Group by (slot, token_mint)
    slot_token_map = defaultdict(list)
    for s in swaps:
        slot_token_map[(s.slot, s.token_mint)].append(s)

    opportunities = []

    for (slot, token), trades in slot_token_map.items():
        venues = set(t.venue for t in trades)
        if len(venues) < 2:
            continue

        # Get prices by venue
        venue_prices = defaultdict(list)
        venue_swaps = defaultdict(list)
        for t in trades:
            venue_prices[t.venue].append(t.price_quote_per_token)
            venue_swaps[t.venue].append(t)

        # Calculate median price per venue
        venue_median = {}
        for v, prices in venue_prices.items():
            venue_median[v] = statistics.median(prices)

        if len(venue_median) < 2:
            continue

        # Find best buy (lowest price) and best sell (highest price)
        sorted_venues = sorted(venue_median.items(), key=lambda x: x[1])
        buy_venue, buy_price = sorted_venues[0]
        sell_venue, sell_price = sorted_venues[-1]

        if buy_price <= 0:
            continue

        spread_pct = (sell_price - buy_price) / buy_price * 100

        # Only report spreads between 0.5% and 200%
        if not (0.5 <= spread_pct <= 200):
            continue

        # Get sample transactions
        buy_samples = venue_swaps[buy_venue][:3]
        sell_samples = venue_swaps[sell_venue][:3]

        # Calculate theoretical profit per 1 SOL
        tokens_bought = 1.0 / buy_price
        sol_received = tokens_bought * sell_price
        gross_profit = sol_received - 1.0
        
        # Fees: 2 swaps + Jito tip + tx fees
        total_fees = (2 * SWAP_FEE_PCT) + JITO_TIP + (2 * TX_FEE)
        net_profit = gross_profit - total_fees

        opportunities.append({
            "slot": slot,
            "token_mint": token,
            "buy_venue": buy_venue,
            "buy_price_sol": buy_price,
            "sell_venue": sell_venue,
            "sell_price_sol": sell_price,
            "spread_pct": round(spread_pct, 4),
            "gross_profit_per_sol": round(gross_profit, 6),
            "net_profit_per_sol": round(net_profit, 6),
            "profitable": net_profit > 0,
            "trades_in_slot": len(trades),
            "venues_in_slot": list(venues),
            "buy_samples": [
                {
                    "signature": s.signature,
                    "solscan": f"https://solscan.io/tx/{s.signature}",
                    "direction": s.token_direction,
                    "token_amount": round(s.token_amount, 6),
                    "quote_amount": round(s.quote_amount, 6),
                    "price": round(s.price_quote_per_token, 12),
                    "fee_payer": s.fee_payer,
                }
                for s in buy_samples
            ],
            "sell_samples": [
                {
                    "signature": s.signature,
                    "solscan": f"https://solscan.io/tx/{s.signature}",
                    "direction": s.token_direction,
                    "token_amount": round(s.token_amount, 6),
                    "quote_amount": round(s.quote_amount, 6),
                    "price": round(s.price_quote_per_token, 12),
                    "fee_payer": s.fee_payer,
                }
                for s in sell_samples
            ],
        })

    return sorted(opportunities, key=lambda x: x["spread_pct"], reverse=True)


def analyze_quality(swaps: List[ParsedSwap]) -> dict:
    """
    Data quality metrics.
    """
    venues = defaultdict(int)
    tokens = defaultdict(int)
    price_ranges = []

    for s in swaps:
        venues[s.venue] += 1
        tokens[s.token_mint] += 1
        price_ranges.append(s.price_quote_per_token)

    return {
        "total_swaps": len(swaps),
        "by_venue": dict(venues),
        "unique_tokens": len(tokens),
        "top_tokens": dict(sorted(tokens.items(), key=lambda x: -x[1])[:20]),
        "price_stats": {
            "min": min(price_ranges) if price_ranges else 0,
            "max": max(price_ranges) if price_ranges else 0,
            "median": statistics.median(price_ranges) if price_ranges else 0,
        } if price_ranges else {},
        "slot_range": {
            "min": min(s.slot for s in swaps) if swaps else 0,
            "max": max(s.slot for s in swaps) if swaps else 0,
        },
    }


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate_cross_venue_v2.py <ndjson_path> [--json-out <path>]", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1]
    json_out = None
    if "--json-out" in sys.argv:
        idx = sys.argv.index("--json-out")
        if idx + 1 < len(sys.argv):
            json_out = sys.argv[idx + 1]

    print(f"Loading {path}...", file=sys.stderr)

    swaps = []
    parse_errors = 0
    for rec in load_ndjson(path):
        s = parse_swap(rec)
        if s:
            swaps.append(s)
        else:
            parse_errors += 1

    print(f"Parsed {len(swaps)} valid swaps (filtered out {parse_errors})", file=sys.stderr)

    if not swaps:
        print("No valid swaps found!", file=sys.stderr)
        sys.exit(1)

    # Analyze
    quality = analyze_quality(swaps)
    opportunities = find_same_slot_opportunities(swaps)

    # Build results
    results = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "input_file": path,
        "data_quality": quality,
        "same_slot_opportunities": opportunities,
        "summary": {
            "total_opportunities": len(opportunities),
            "profitable_after_fees": len([o for o in opportunities if o["profitable"]]),
            "best_spread_pct": opportunities[0]["spread_pct"] if opportunities else 0,
            "venues_analyzed": list(quality["by_venue"].keys()),
        },
    }

    # Output
    if json_out:
        with open(json_out, "w") as f:
            json.dump(results, f, indent=2)
        print(f"\nResults written to: {json_out}", file=sys.stderr)

    # Console output
    print()
    print("=" * 80)
    print("CROSS-VENUE VALIDATION REPORT v2")
    print("=" * 80)
    print()

    print("### DATA QUALITY ###")
    print(f"Total valid swaps: {quality['total_swaps']}")
    print(f"Unique tokens: {quality['unique_tokens']}")
    print(f"Slot range: {quality['slot_range']['min']} - {quality['slot_range']['max']}")
    print(f"By venue:")
    for v, c in quality["by_venue"].items():
        print(f"  {v}: {c}")
    print()

    print("### SAME-SLOT CROSS-VENUE OPPORTUNITIES ###")
    print(f"Found: {len(opportunities)}")
    profitable = [o for o in opportunities if o["profitable"]]
    print(f"Profitable after fees: {len(profitable)}")
    print()

    if opportunities:
        for i, opp in enumerate(opportunities[:10]):
            status = "✅ PROFITABLE" if opp["profitable"] else "❌ Fees exceed spread"
            print(f"{i+1}. Slot {opp['slot']} | Token: {opp['token_mint'][:16]}...")
            print(f"   Spread: {opp['spread_pct']:.2f}% | {status}")
            print(f"   Buy @ {opp['buy_venue']}: {opp['buy_price_sol']:.12f} SOL/token")
            print(f"   Sell @ {opp['sell_venue']}: {opp['sell_price_sol']:.12f} SOL/token")
            print(f"   Gross: {opp['gross_profit_per_sol']:.4f} SOL | Net: {opp['net_profit_per_sol']:.4f} SOL")
            print()
            print(f"   VERIFY:")
            for s in opp["buy_samples"][:2]:
                print(f"   Buy:  {s['solscan']}")
                print(f"         {s['direction']} {s['token_amount']:.4f} tokens for {s['quote_amount']:.4f} SOL @ {s['price']:.12f}")
            for s in opp["sell_samples"][:2]:
                print(f"   Sell: {s['solscan']}")
                print(f"         {s['direction']} {s['token_amount']:.4f} tokens for {s['quote_amount']:.4f} SOL @ {s['price']:.12f}")
            print()
            print("-" * 60)
            print()
    else:
        print("No cross-venue opportunities found in this dataset.")
        print()
        print("Possible reasons:")
        print("1. Market is efficient (arb bots already capturing)")
        print("2. Sample window too short")
        print("3. Need to capture during high volatility periods")
        print()

    print("=" * 80)
    print("NEXT STEPS")
    print("=" * 80)
    print()
    print("1. Click the Solscan links above and verify:")
    print("   - Is it actually a swap? (not transfer, not failed)")
    print("   - Do the token amounts match?")
    print("   - Check the pool addresses")
    print()
    print("2. If results look correct, run longer capture:")
    print(f"   node helius_alpha_ingest_v2.cjs --hours 24 --out ./alpha_24h.ndjson")
    print()
    print("3. If opportunities are real but you're not capturing them:")
    print("   - Your ShredStream latency may be too high")
    print("   - Competition is submitting bundles faster")
    print("   - Consider co-location or faster RPC")


if __name__ == "__main__":
    main()