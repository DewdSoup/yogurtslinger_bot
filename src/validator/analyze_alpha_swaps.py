#!/usr/bin/env python3
"""
analyze_alpha_swaps.py

Offline analysis of Helius DEX swap tape (NDJSON).

Usage:
    python3 analyze_alpha_swaps.py helius_alpha_swaps.ndjson [max_tx]

- Streams NDJSON line by line (handles 500MB+ fine).
- Expects each line to be a single JSON object from Helius' DEX parser, e.g.:
    {
        "signature": "...",
        "slot": 385667931,
        "blockTime": 1765337130,
        "program": "RAYDIUM_V4",
        "programId": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
        "input":  { "mint": "...", "amount": "499315477", "decimals": 6, ... },
        "output": { "mint": "...", "amount": "123456",    "decimals": 6, ... },
        "accountRoles": { "addr": "user_token_in", ... },
        ...
    }

We use only:
- programId / program
- input / output.{mint, amount, decimals}
- blockTime (if available) for time range

Outputs:
- Basic counts by program / type / source
- Top 20 tokens by volume (ui units)
- Top 20 token pairs by volume (ui in)
- Cross-program price dispersion per pair
- "Jupiter gap" candidates (where JUP is worse than best DEX)
"""

import sys
import json
import math
from collections import Counter, defaultdict
from statistics import median

# Known program IDs (for prettier labels)
PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
RAYDIUM_V4_PROGRAM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
RAYDIUM_CLMM_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
METEORA_DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
JUPITER_PROGRAM = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"

PROGRAM_LABELS = {
    PUMPSWAP_PROGRAM: "PumpSwap AMM",
    RAYDIUM_V4_PROGRAM: "Raydium V4 AMM",
    RAYDIUM_CLMM_PROGRAM: "Raydium CLMM",
    METEORA_DLMM_PROGRAM: "Meteora DLMM",
    JUPITER_PROGRAM: "Jupiter Aggregator",
}


def ui_amount(amount_raw: int, decimals: int | None) -> float:
    if decimals is None or decimals < 0:
        decimals = 0
    if amount_raw == 0:
        return 0.0
    return amount_raw / (10.0 ** decimals)


def safe_int(x, default: int = 0) -> int:
    if x is None:
        return default
    if isinstance(x, int):
        return x
    try:
        return int(x)
    except Exception:
        return default


def main():
    if len(sys.argv) < 2:
        print("Usage: analyze_alpha_swaps.py <path-to-ndjson> [max_tx]")
        sys.exit(1)

    path = sys.argv[1]
    max_tx = int(sys.argv[2]) if len(sys.argv) > 2 else None

    total_tx = 0
    program_counts = Counter()
    source_counts = Counter()
    type_counts = Counter()

    # Token-level volume (ui units)
    token_volume_ui = defaultdict(float)
    token_tx_count = Counter()

    # Pair-level stats: (inMint, outMint) -> stats
    # stats["programs"][programId]["prices"] = list of out_per_in prices
    pair_stats = {}

    # Simple time range
    min_slot = None
    max_slot = None
    min_ts = None
    max_ts = None

    with open(path, "r", encoding="utf-8") as f:
        for line_idx, line in enumerate(f, start=1):
            if max_tx is not None and total_tx >= max_tx:
                break

            line = line.strip()
            if not line:
                continue

            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                # Skip malformed line
                continue

            total_tx += 1

            # Program / type / source
            program_id = rec.get("programId") or rec.get("programAddress") or rec.get("program")
            if not program_id:
                program_id = "UNKNOWN_PROGRAM"

            program_counts[program_id] += 1

            src = rec.get("source") or rec.get("sourceType") or "UNKNOWN_SOURCE"
            source_counts[src] += 1

            tx_type = rec.get("type") or rec.get("category") or "UNKNOWN_TYPE"
            type_counts[tx_type] += 1

            # Slot / time (if present)
            slot = rec.get("slot")
            if isinstance(slot, int):
                min_slot = slot if min_slot is None else min(min_slot, slot)
                max_slot = slot if max_slot is None else max(max_slot, slot)

            ts = rec.get("blockTime") or rec.get("timestamp")
            if isinstance(ts, (int, float)):
                min_ts = ts if min_ts is None else min(min_ts, ts)
                max_ts = ts if max_ts is None else max(max_ts, ts)

            # Input / output tokens
            inp = rec.get("input") or {}
            outp = rec.get("output") or {}

            in_mint = inp.get("mint")
            out_mint = outp.get("mint")
            if not in_mint or not out_mint:
                # Some records may be weird; skip them for pair analysis
                continue

            in_amt_raw = safe_int(inp.get("amount"))
            out_amt_raw = safe_int(outp.get("amount"))
            if in_amt_raw <= 0 or out_amt_raw <= 0:
                continue

            in_dec = inp.get("decimals")
            out_dec = outp.get("decimals")

            in_ui = ui_amount(in_amt_raw, in_dec)
            out_ui = ui_amount(out_amt_raw, out_dec)
            if in_ui <= 0.0 or out_ui <= 0.0:
                continue

            # Price = out_per_in in UI units
            price = out_ui / in_ui

            # Token-level volume
            token_volume_ui[in_mint] += in_ui
            token_volume_ui[out_mint] += out_ui
            token_tx_count[in_mint] += 1
            token_tx_count[out_mint] += 1

            # Pair-level stats
            pair_key = (in_mint, out_mint)
            ps = pair_stats.get(pair_key)
            if ps is None:
                ps = {
                    "count": 0,
                    "total_in_ui": 0.0,
                    "total_out_ui": 0.0,
                    "programs": {},  # programId -> {count, volume_in_ui, volume_out_ui, prices: []}
                }
                pair_stats[pair_key] = ps

            ps["count"] += 1
            ps["total_in_ui"] += in_ui
            ps["total_out_ui"] += out_ui

            pstats = ps["programs"].get(program_id)
            if pstats is None:
                pstats = {
                    "count": 0,
                    "volume_in_ui": 0.0,
                    "volume_out_ui": 0.0,
                    "prices": [],
                }
                ps["programs"][program_id] = pstats

            pstats["count"] += 1
            pstats["volume_in_ui"] += in_ui
            pstats["volume_out_ui"] += out_ui
            pstats["prices"].append(price)

    # ----- Reporting -----

    print(f"Total transactions: {total_tx}")
    if min_slot is not None and max_slot is not None:
        print(f"Slot range: {min_slot} .. {max_slot}")
    if min_ts is not None and max_ts is not None:
        print(f"Timestamp range (unix): {min_ts} .. {max_ts}")
    print()

    # By program
    print("=== By programId ===")
    for pid, count in program_counts.most_common():
        label = PROGRAM_LABELS.get(pid, "")
        label_part = f" ({label})" if label else ""
        print(f"{pid}{label_part}: {count}")
    print()

    # By source
    print("=== By Helius source ===")
    for src, count in source_counts.most_common():
        print(f"{src}: {count}")
    print()

    # By type/category
    print("=== By Helius type/category ===")
    for typ, count in type_counts.most_common():
        print(f"{typ}: {count}")
    print()

    # Top tokens by UI volume
    print("=== Top 20 tokens by volume (sum of ui input+output) ===")
    token_items = sorted(
        token_volume_ui.items(),
        key=lambda kv: kv[1],
        reverse=True,
    )
    for mint, vol in token_items[:20]:
        txc = token_tx_count[mint]
        print(f"{mint}: volume={vol:.6f}, tx_count={txc}")
    print()

    # Top pairs by UI input volume
    print("=== Top 20 token pairs by in-volume (ui) ===")
    pair_items = sorted(
        pair_stats.items(),
        key=lambda kv: kv[1]["total_in_ui"],
        reverse=True,
    )
    for (in_mint, out_mint), ps in pair_items[:20]:
        print(
            f"{in_mint} -> {out_mint}: "
            f"tx_count={ps['count']}, "
            f"total_in_ui={ps['total_in_ui']:.6f}, "
            f"total_out_ui={ps['total_out_ui']:.6f}"
        )
    print()

    # Cross-program price dispersion
    print("=== Cross-program price dispersion per pair (top 20 by spread) ===")
    dispersion_rows = []
    for pair_key, ps in pair_stats.items():
        progs = ps["programs"]
        if len(progs) < 2:
            continue

        # median price per program
        medians = {}
        for pid, st in progs.items():
            if not st["prices"]:
                continue
            medians[pid] = median(st["prices"])
        if len(medians) < 2:
            continue

        best = max(medians.values())
        worst = min(medians.values())
        if best <= 0 or worst <= 0:
            continue

        spread = best / worst - 1.0  # relative spread
        dispersion_rows.append((spread, pair_key, medians))

    dispersion_rows.sort(key=lambda x: x[0], reverse=True)
    for spread, (in_mint, out_mint), medians in dispersion_rows[:20]:
        print(f"{in_mint} -> {out_mint}: spread={spread*100:.4f}%")
        for pid, med in sorted(medians.items(), key=lambda kv: kv[1]):
            label = PROGRAM_LABELS.get(pid, "")
            label_part = f" ({label})" if label else ""
            print(f"    {pid}{label_part}: median_price={med:.10f}")
    print()

    # Jupiter gap: where JUP median is worse than best DEX median
    print("=== Jupiter gap candidates (JUP vs best program, top 20 by gap) ===")
    jup_rows = []
    for pair_key, ps in pair_stats.items():
        progs = ps["programs"]
        if JUPITER_PROGRAM not in progs or len(progs) < 2:
            continue

        # median price per program
        medians = {}
        for pid, st in progs.items():
            if not st["prices"]:
                continue
            medians[pid] = median(st["prices"])
        if JUPITER_PROGRAM not in medians or len(medians) < 2:
            continue

        jup_med = medians[JUPITER_PROGRAM]
        if jup_med <= 0:
            continue

        best = max(medians.values())
        if best <= 0:
            continue

        gap = (best - jup_med) / best  # fraction by which JUP is below best
        if gap <= 0:
            continue

        jup_rows.append((gap, pair_key, jup_med, best, medians))

    jup_rows.sort(key=lambda x: x[0], reverse=True)

    for gap, (in_mint, out_mint), jup_med, best_med, medians in jup_rows[:20]:
        print(
            f"{in_mint} -> {out_mint}: "
            f"JUP gap={gap*100:.4f}% "
            f"(JUP median={jup_med:.10f}, best={best_med:.10f})"
        )
        for pid, med in sorted(medians.items(), key=lambda kv: kv[1], reverse=True):
            label = PROGRAM_LABELS.get(pid, "")
            label_part = f" ({label})" if label else ""
            print(f"    {pid}{label_part}: median_price={med:.10f}")
    print()


if __name__ == "__main__":
    main()
