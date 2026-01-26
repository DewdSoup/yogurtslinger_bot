#!/usr/bin/env python3
import sys
import json
from decimal import Decimal, getcontext
from collections import defaultdict
from typing import Any, Dict, Optional, List

getcontext().prec = 28

# Program IDs
PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
RAYDIUM_V4_PROGRAM_ID = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
JUPITER_V4_PROGRAM_ID = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"

PROGRAM_LABELS = {
    PUMPSWAP_PROGRAM_ID: "PumpSwap",
    RAYDIUM_V4_PROGRAM_ID: "Raydium_V4",
    RAYDIUM_CLMM_PROGRAM_ID: "Raydium_CLMM",
    METEORA_DLMM_PROGRAM_ID: "Meteora_DLMM",
    JUPITER_V4_PROGRAM_ID: "Jupiter_V4",
}

# Only treat underlying venues as "venues" for spreads.
ENABLE_VENUES = {"PumpSwap", "Raydium_V4", "Raydium_CLMM", "Meteora_DLMM"}

# Tunables
BUCKET_SECONDS = 5
MIN_SPREAD_BPS = 10       # report events with >= 10 bps spread
MIN_VENUES = 2
TOP_N_EVENTS = 50


def median_decimal(values: List[Decimal]) -> Optional[Decimal]:
    if not values:
        return None
    values = sorted(values)
    n = len(values)
    mid = n // 2
    if n % 2 == 1:
        return values[mid]
    return (values[mid - 1] + values[mid]) / Decimal(2)


def find_enhanced_like(node: Any) -> Optional[Dict[str, Any]]:
    """
    Robustly find a Helius-style enhanced/raw object that has accountData.
    We don't assume any wrapper key; just DFS through dicts/lists.
    """
    if isinstance(node, dict):
        # Direct hit
        if "accountData" in node and isinstance(node["accountData"], list):
            return node

        # Common wrapper keys
        for key in ("enhanced", "raw", "tx", "transaction", "data"):
            v = node.get(key)
            if isinstance(v, dict) and "accountData" in v:
                return v

        # Generic DFS
        for v in node.values():
            found = find_enhanced_like(v)
            if found is not None:
                return found

    elif isinstance(node, list):
        for item in node:
            found = find_enhanced_like(item)
            if found is not None:
                return found

    return None


def extract_enhanced(wrapper: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Entry point: try to locate the enhanced/raw tx object inside a NDJSON line.
    """
    return find_enhanced_like(wrapper)


def get_program_id(wrapper: Dict[str, Any], enh: Dict[str, Any]) -> Optional[str]:
    """
    Recover which AMM program this transaction is associated with.
    We:
      1) Check common wrapper-level fields.
      2) Check common enhanced-level fields.
      3) Scan accountData[].account for known program IDs.
    """
    # 1. Wrapper-level hints
    for key in (
        "programId",
        "program_id",
        "owner",
        "program",
        "addressQueried",
        "address",
        "sourceProgram",
    ):
        v = wrapper.get(key)
        if isinstance(v, str) and v in PROGRAM_LABELS:
            return v

    # 2. Enhanced-level hints
    for key in ("programId", "program_id", "owner", "program", "address"):
        v = enh.get(key)
        if isinstance(v, str) and v in PROGRAM_LABELS:
            return v

    # 3. Fallback: scan accountData
    for ad in enh.get("accountData", []):
        acc = ad.get("account")
        if isinstance(acc, str) and acc in PROGRAM_LABELS:
            return acc

    return None


def extract_swap_from_enhanced(enh: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Infer a simple 2-token swap from accountData.tokenBalanceChanges.
    Same core idea as your v2 analyzer:
      - choose feePayer accountData if present, otherwise the account
        with the most tokenBalanceChanges
      - aggregate net rawTokenAmount per mint for that account
      - require exactly one net-negative and one net-positive mint.
    """
    fee_payer = enh.get("feePayer")
    account_data = enh.get("accountData") or []

    # Choose accountData entry: feePayer preferred
    ad_fee = None
    for ad in account_data:
        if ad.get("account") == fee_payer:
            ad_fee = ad
            break

    if ad_fee is None:
        # fallback: max tokenBalanceChanges length
        best = None
        best_len = -1
        for ad in account_data:
            tbc = ad.get("tokenBalanceChanges") or []
            if len(tbc) > best_len:
                best_len = len(tbc)
                best = ad
        ad_fee = best

    if ad_fee is None:
        return None

    t_changes = ad_fee.get("tokenBalanceChanges") or []

    # Aggregate net change per mint
    by_mint: Dict[str, tuple[int, int]] = {}
    for ch in t_changes:
        raw = ch.get("rawTokenAmount") or {}
        amt_str = raw.get("tokenAmount")
        dec = raw.get("decimals")
        mint = ch.get("mint")
        if mint is None or amt_str is None or dec is None:
            continue

        try:
            amt = int(amt_str)
        except Exception:
            continue
        if amt == 0:
            continue

        if mint in by_mint:
            prev_amt, prev_dec = by_mint[mint]
            if prev_dec != dec:
                # strange; skip mixing decimals
                continue
            by_mint[mint] = (prev_amt + amt, prev_dec)
        else:
            by_mint[mint] = (amt, dec)

    neg = [(m, a, d) for m, (a, d) in by_mint.items() if a < 0]
    pos = [(m, a, d) for m, (a, d) in by_mint.items() if a > 0]

    if len(neg) != 1 or len(pos) != 1:
        return None

    in_mint, in_delta, in_dec = neg[0]
    out_mint, out_delta, out_dec = pos[0]

    if in_delta >= 0 or out_delta <= 0:
        return None

    try:
        amount_in_ui = Decimal(-in_delta) / (Decimal(10) ** in_dec)
        amount_out_ui = Decimal(out_delta) / (Decimal(10) ** out_dec)
    except Exception:
        return None

    if amount_in_ui <= 0 or amount_out_ui <= 0:
        return None

    price = amount_out_ui / amount_in_ui

    return {
        "in_mint": in_mint,
        "out_mint": out_mint,
        "amount_in_ui": amount_in_ui,
        "amount_out_ui": amount_out_ui,
        "price": price,
        "slot": enh.get("slot"),
        "timestamp": enh.get("timestamp"),
        "signature": enh.get("signature"),
    }


def canonical_pair(m1: str, m2: str) -> tuple[str, str]:
    return (m1, m2) if m1 <= m2 else (m2, m1)


def main(path: str) -> None:
    swaps = []

    skipped_parse = 0
    skipped_no_enh = 0
    skipped_no_prog = 0
    skipped_no_swap = 0

    with open(path, "r") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue

            try:
                obj = json.loads(line)
            except Exception:
                skipped_parse += 1
                continue

            enh = extract_enhanced(obj)
            if enh is None:
                skipped_no_enh += 1
                continue

            pid = get_program_id(obj, enh)
            if pid is None:
                skipped_no_prog += 1
                continue

            venue = PROGRAM_LABELS.get(pid)
            if venue is None:
                skipped_no_prog += 1
                continue

            swap = extract_swap_from_enhanced(enh)
            if swap is None:
                skipped_no_swap += 1
                continue

            swap["venue"] = venue
            swaps.append(swap)

    print(f"Loaded swaps: {len(swaps)}")
    print(f"Skipped parse errors: {skipped_parse}")
    print(f"Skipped no enhanced-like payload: {skipped_no_enh}")
    print(f"Skipped no program match: {skipped_no_prog}")
    print(f"Skipped no simple 2-token swap: {skipped_no_swap}")

    # === Cross-venue spread aggregation ===
    # key: (pair0, pair1, direction, bucket) -> venue -> [prices]
    table: Dict[tuple[str, str, str, int], Dict[str, List[Decimal]]] = defaultdict(
        lambda: defaultdict(list)
    )

    for s in swaps:
        venue = s["venue"]
        if venue not in ENABLE_VENUES:
            continue

        in_mint = s["in_mint"]
        out_mint = s["out_mint"]
        ts = s.get("timestamp")
        slot = s.get("slot")

        if ts is None:
            if slot is None:
                continue
            bucket = int(slot)
        else:
            bucket = int(ts) // BUCKET_SECONDS

        pair = canonical_pair(in_mint, out_mint)
        direction = f"{in_mint}->{out_mint}"
        key = (pair[0], pair[1], direction, bucket)

        table[key][venue].append(s["price"])

    events = []

    for key, venue_prices in table.items():
        if len(venue_prices) < MIN_VENUES:
            continue

        # median per venue
        med_prices: Dict[str, Decimal] = {}
        for venue, prices in venue_prices.items():
            m = median_decimal(prices)
            if m is not None and m > 0:
                med_prices[venue] = m

        if len(med_prices) < MIN_VENUES:
            continue

        venues = list(med_prices.keys())
        prices = [med_prices[v] for v in venues]

        max_idx = max(range(len(prices)), key=lambda i: prices[i])
        min_idx = min(range(len(prices)), key=lambda i: prices[i])

        max_venue, max_price = venues[max_idx], prices[max_idx]
        min_venue, min_price = venues[min_idx], prices[min_idx]

        spread_bps = (max_price / min_price - Decimal(1)) * Decimal(10000)

        if spread_bps < MIN_SPREAD_BPS:
            continue

        pair0, pair1, direction, bucket = key

        events.append(
            {
                "pair0": pair0,
                "pair1": pair1,
                "direction": direction,
                "bucket": bucket,
                "max_venue": max_venue,
                "min_venue": min_venue,
                "max_price": max_price,
                "min_price": min_price,
                "spread_bps": spread_bps,
                "venue_counts": {v: len(prs) for v, prs in venue_prices.items()},
            }
        )

    events.sort(key=lambda e: e["spread_bps"], reverse=True)

    print()
    print(
        f"Cross-venue spread events (>= {MIN_SPREAD_BPS} bps), "
        f"top {TOP_N_EVENTS}:"
    )
    for e in events[:TOP_N_EVENTS]:
        p0 = e["pair0"]
        p1 = e["pair1"]
        print(
            f"{p0[:6]}..{p0[-4:]} / {p1[:6]}..{p1[-4:]} "
            f"{e['direction']} bucket={e['bucket']} "
            f"spread={e['spread_bps']:.1f} bps "
            f"{e['min_venue']}->{e['max_venue']} "
            f"prices={e['min_price']:.8f}->{e['max_price']:.8f} "
            f"counts={e['venue_counts']}"
        )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(
            "Usage: analyze_cross_venue_spreads_v2.py <helius_alpha_swaps.ndjson>",
            file=sys.stderr,
        )
        sys.exit(1)
    main(sys.argv[1])
