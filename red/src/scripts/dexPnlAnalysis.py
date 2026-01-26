#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DEX PnL analysis for dexTransactionCollector outputs.

This script is intentionally conservative: it can compute
SOL/WSOL and stablecoin net deltas without any external prices.
If a price file or online pricing is provided, it will compute
mark-to-market PnL in USDC.
Supports full JSON and .ndjson transaction streams.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import ijson

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
WSOL_MINT = "So11111111111111111111111111111111111111112"

LAMPORTS_PER_SOL = 1_000_000_000

PROGRAMS = {
    "PUMPSWAP": "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "RAYDIUM_V4": "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "RAYDIUM_CLMM": "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
    "METEORA_DLMM": "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "ORCA_WHIRLPOOL": "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",
    "JUPITER_V6": "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
    "JUPITER_V4": "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",
    "JUPITER_V3": "JUP2jxvXaqu7NQY1GmNF4m1vodw12LVXYxbFL2uJvfo",
    "JUPITER_V2": "JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph",
}

DEX_PROGRAMS = {
    PROGRAMS["PUMPSWAP"],
    PROGRAMS["RAYDIUM_V4"],
    PROGRAMS["RAYDIUM_CLMM"],
    PROGRAMS["METEORA_DLMM"],
    PROGRAMS["ORCA_WHIRLPOOL"],
}

AGG_PROGRAMS = {
    PROGRAMS["JUPITER_V6"],
    PROGRAMS["JUPITER_V4"],
    PROGRAMS["JUPITER_V3"],
    PROGRAMS["JUPITER_V2"],
}

PROGRAM_NAME_BY_ID = {v: k for k, v in PROGRAMS.items()}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PnL analysis on dexTransactionCollector JSON output.")
    parser.add_argument("--input", required=True, help="Path to dex_txs_*.json")
    parser.add_argument("--out", default="", help="Write JSON summary to this path")
    parser.add_argument("--report", default="", help="Write Markdown report to this path")
    parser.add_argument("--top-wallets", type=int, default=50, help="Top wallets by tx count for pricing")
    parser.add_argument("--min-tx", type=int, default=200, help="Min tx for certain summaries")
    parser.add_argument("--price-file", default="", help="JSON file mapping mint -> price (USDC)")
    parser.add_argument("--price-source", choices=["", "jup", "helius"], default="", help="Optional price source")
    parser.add_argument("--price-vs", default=USDC_MINT, help="Price vs token mint (default USDC)")
    parser.add_argument("--helius-key", default="", help="Helius API key (optional)")
    parser.add_argument("--helius-config", default="", help="Config JSON that may contain heliusApiKey or rpcUrl")
    return parser.parse_args()


def iter_transactions(input_path: str) -> Iterable[Dict]:
    path = Path(input_path)
    lower = path.name.lower()
    if lower.endswith(".ndjson"):
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue
    else:
        with path.open("rb") as f:
            for tx in ijson.items(f, "transactions.item"):
                yield tx


def quantile_from_hist(hist: Counter, q: float) -> Optional[int]:
    total = sum(hist.values())
    if total == 0:
        return None
    rank = math.ceil(q * total)
    cum = 0
    for value in sorted(hist):
        cum += hist[value]
        if cum >= rank:
            return value
    return None


def summarize_hist(hist: Counter) -> Dict[str, Optional[int]]:
    return {
        "p50": quantile_from_hist(hist, 0.50),
        "p90": quantile_from_hist(hist, 0.90),
    }


def parse_error_label(err_str: Optional[str]) -> Optional[str]:
    if not err_str:
        return None
    try:
        obj = json.loads(err_str)
    except Exception:
        return err_str
    if isinstance(obj, dict):
        if "InstructionError" in obj and isinstance(obj["InstructionError"], list):
            lst = obj["InstructionError"]
            if len(lst) >= 2:
                err = lst[1]
                if isinstance(err, dict):
                    if "Custom" in err:
                        return f"InstructionError:Custom:{err['Custom']}"
                    key = next(iter(err.keys()), None)
                    return f"InstructionError:{key}" if key else "InstructionError"
                return f"InstructionError:{err}"
            return "InstructionError"
        key = next(iter(obj.keys()), None)
        return f"{key}:{obj[key]}" if key else str(obj)
    return str(obj)


def extract_api_key_from_url(url: str) -> Optional[str]:
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    qs = urllib.parse.parse_qs(parsed.query)
    key = qs.get("api-key", [None])[0]
    if key:
        return str(key)
    return None


def load_helius_key(explicit: str, config_path: str, repo_root: Path) -> Optional[str]:
    if explicit:
        return explicit
    env_key = os.environ.get("HELIUS_API_KEY")
    if env_key:
        return env_key

    config_paths = []
    if config_path:
        config_paths.append(Path(config_path))
    config_paths.extend([
        repo_root / "capture.config.json",
        repo_root / "capture.grpc.config.json",
        repo_root / "txdump.config.json",
    ])

    for path in config_paths:
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        key = data.get("heliusApiKey")
        if key:
            return key
        for field in ("rpcUrl", "wsUrl"):
            key = extract_api_key_from_url(str(data.get(field, "")))
            if key:
                return key
    return None


def fetch_helius_prices(mints: List[str], api_key: str, batch_size: int = 100) -> Dict[str, float]:
    prices: Dict[str, float] = {}
    if not api_key:
        return prices
    url = f"https://mainnet.helius-rpc.com/?api-key={api_key}"
    headers = {"Content-Type": "application/json"}
    for i in range(0, len(mints), batch_size):
        batch = mints[i : i + batch_size]
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getAssetBatch",
            "params": {"ids": batch},
        }
        req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        results = data.get("result") or []
        if not isinstance(results, list):
            continue
        for asset in results:
            mint = asset.get("id")
            price_info = (asset.get("token_info") or {}).get("price_info") or {}
            price = price_info.get("price_per_token")
            if mint and price is not None:
                try:
                    prices[mint] = float(price)
                except Exception:
                    continue
        time.sleep(0.2)
    return prices


def latency_bucket(ms: Optional[int]) -> str:
    if ms is None:
        return "unknown"
    if ms < 0:
        return "<0"
    if ms <= 50:
        return "0-50"
    if ms <= 100:
        return "50-100"
    if ms <= 200:
        return "100-200"
    if ms <= 500:
        return "200-500"
    if ms <= 1000:
        return "500-1000"
    return "1000+"


def read_price_file(path: str) -> Dict[str, float]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"price file not found: {path}")
    data = json.loads(p.read_text())
    out: Dict[str, float] = {}
    for mint, val in data.items():
        if isinstance(val, dict):
            price = val.get("price")
        else:
            price = val
        if price is None:
            continue
        try:
            out[mint] = float(price)
        except Exception:
            continue
    return out


def fetch_jup_prices(mints: List[str], vs_token: str, batch_size: int = 100) -> Dict[str, float]:
    prices: Dict[str, float] = {}
    base = f"https://price.jup.ag/v6/price?vsToken={vs_token}&ids="
    for i in range(0, len(mints), batch_size):
        batch = mints[i : i + batch_size]
        url = base + ",".join(batch)
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue
        data_map = data.get("data", {})
        for mint, info in data_map.items():
            price = info.get("price")
            if price is None:
                continue
            try:
                prices[mint] = float(price)
            except Exception:
                continue
        time.sleep(0.2)
    return prices


def to_units(delta: int, decimals: Optional[int]) -> float:
    if decimals is None:
        return float(delta)
    return float(delta) / (10 ** decimals)


def pct(n: int, d: int) -> float:
    return (n / d) if d else 0.0


def compute_wallet_metrics(input_path: str) -> Tuple[Dict[str, Dict], Counter]:
    wallet_stats: Dict[str, Dict] = {}
    wallet_counts: Counter = Counter()

    for tx in iter_transactions(input_path):
        fee_payer = tx.get("feePayer")
        if not fee_payer:
            continue

        wallet_counts[fee_payer] += 1

        m = wallet_stats.get(fee_payer)
        if m is None:
            m = {
                "tx": 0,
                "exec": 0,
                "fail": 0,
                "agg_tx": 0,
                "dex_tx": 0,
                "tip_sum": 0,
                "sol_delta": 0,
                "wsol_delta": 0,
                "usdc_delta": 0,
                "usdt_delta": 0,
            }
            wallet_stats[fee_payer] = m

        m["tx"] += 1
        if tx.get("executed"):
            m["exec"] += 1
        else:
            m["fail"] += 1

        if tx.get("aggregatorProgramsInvoked"):
            m["agg_tx"] += 1
        if tx.get("dexProgramsInvoked"):
            m["dex_tx"] += 1

        m["tip_sum"] += int(tx.get("jitoTipAmount") or 0)
        m["sol_delta"] += int(tx.get("feePayerSolChange") or 0)

        for change in tx.get("tokenChanges") or []:
            if change.get("owner") != fee_payer:
                continue
            mint = change.get("mint")
            if not mint:
                continue
            try:
                delta = int(change.get("deltaAmount") or 0)
            except Exception:
                continue
            if mint == WSOL_MINT:
                m["wsol_delta"] += delta
            elif mint == USDC_MINT:
                m["usdc_delta"] += delta
            elif mint == USDT_MINT:
                m["usdt_delta"] += delta

    return wallet_stats, wallet_counts


def compute_top_wallet_token_deltas(
    input_path: str,
    top_wallets: List[str],
) -> Tuple[Dict[str, Dict[str, int]], Dict[str, int]]:
    top_set = set(top_wallets)
    token_deltas: Dict[str, Dict[str, int]] = {w: defaultdict(int) for w in top_wallets}
    mint_decimals: Dict[str, int] = {}

    for tx in iter_transactions(input_path):
        fee_payer = tx.get("feePayer")
        if fee_payer not in top_set:
            continue
        for change in tx.get("tokenChanges") or []:
            if change.get("owner") != fee_payer:
                continue
            mint = change.get("mint")
            if not mint:
                continue
            try:
                delta = int(change.get("deltaAmount") or 0)
            except Exception:
                continue
            token_deltas[fee_payer][mint] += delta
            dec = change.get("decimals")
            if isinstance(dec, int) and mint not in mint_decimals:
                mint_decimals[mint] = dec

    return token_deltas, mint_decimals


def analyze_transactions(input_path: str) -> Dict:
    program_stats = {
        pid: {
            "tx": 0,
            "exec": 0,
            "fail": 0,
            "tip_sum": 0,
            "tip_tx": 0,
            "tip_success_sum": 0,
            "tip_fail_sum": 0,
            "instr_hist": Counter(),
            "inner_hist": Counter(),
            "compute_sum": 0,
            "compute_success_sum": 0,
            "compute_fail_sum": 0,
            "solw_sum": 0,
            "stable_sum": 0,
            "agg_cooccur": 0,
            "multi_dex": 0,
            "error_counts": Counter(),
        }
        for pid in list(DEX_PROGRAMS | AGG_PROGRAMS)
    }

    flow_stats: Dict[str, Dict] = {}
    latency_stats: Dict[str, Dict] = {}
    category_stats = {
        "dex_only": {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0},
        "agg_only": {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0},
        "both": {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0},
    }

    mint_stats: Dict[str, Dict] = defaultdict(lambda: {"delta": 0, "tx": 0, "decimals": None})

    for tx in iter_transactions(input_path):
        fee_payer = tx.get("feePayer")
        if not fee_payer:
            continue

        executed = bool(tx.get("executed"))
        instr_count = int(tx.get("instructionCount") or 0)
        inner_count = int(tx.get("innerInstructionCount") or 0)
        compute = int(tx.get("computeUnitsConsumed") or 0)
        tip = int(tx.get("jitoTipAmount") or 0)

        sol_delta = int(tx.get("feePayerSolChange") or 0)
        wsol_delta = 0
        stable_delta = 0

        for change in tx.get("tokenChanges") or []:
            if change.get("owner") != fee_payer:
                continue
            mint = change.get("mint")
            if not mint:
                continue
            try:
                delta = int(change.get("deltaAmount") or 0)
            except Exception:
                continue
            if mint == WSOL_MINT:
                wsol_delta += delta
            if mint == USDC_MINT or mint == USDT_MINT:
                stable_delta += delta
            mint_entry = mint_stats[mint]
            mint_entry["delta"] += delta
            mint_entry["tx"] += 1
            if mint_entry["decimals"] is None and isinstance(change.get("decimals"), int):
                mint_entry["decimals"] = change.get("decimals")

        solw_delta = sol_delta + wsol_delta

        dex_list = tx.get("dexProgramsInvoked") or []
        agg_list = tx.get("aggregatorProgramsInvoked") or []
        has_dex = bool(dex_list)
        has_agg = bool(agg_list)

        if has_dex and has_agg:
            cat = category_stats["both"]
        elif has_dex:
            cat = category_stats["dex_only"]
        else:
            cat = category_stats["agg_only"]
        cat["tx"] += 1
        if not executed:
            cat["fail"] += 1
        cat["tip_sum"] += tip
        cat["solw_sum"] += solw_delta
        cat["stable_sum"] += stable_delta

        err_label = parse_error_label(tx.get("executionError")) if not executed else None

            # Program-level stats
        dex_set = set(dex_list)
        for pid in dex_set | set(agg_list):
            if pid not in program_stats:
                continue
            ps = program_stats[pid]
            ps["tx"] += 1
            if executed:
                ps["exec"] += 1
                ps["compute_success_sum"] += compute
                ps["tip_success_sum"] += tip
            else:
                ps["fail"] += 1
                ps["compute_fail_sum"] += compute
                ps["tip_fail_sum"] += tip
                if err_label:
                    ps["error_counts"][err_label] += 1
            ps["instr_hist"][instr_count] += 1
            ps["inner_hist"][inner_count] += 1
            ps["compute_sum"] += compute
            ps["solw_sum"] += solw_delta
            ps["stable_sum"] += stable_delta
            ps["tip_sum"] += tip
            if tip > 0:
                ps["tip_tx"] += 1
            if pid in DEX_PROGRAMS and has_agg:
                ps["agg_cooccur"] += 1
            if pid in DEX_PROGRAMS and len(dex_set) > 1:
                ps["multi_dex"] += 1

            # Flow stats
        flow = tx.get("txStructure", {}).get("programFlow") or []
        flow_key = "->".join(flow) if flow else "unknown"
        fs = flow_stats.get(flow_key)
        if fs is None:
            fs = {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0}
            flow_stats[flow_key] = fs
        fs["tx"] += 1
        if not executed:
            fs["fail"] += 1
        fs["tip_sum"] += tip
        fs["solw_sum"] += solw_delta
        fs["stable_sum"] += stable_delta

            # Latency buckets
        latency = tx.get("captureLatencyMs")
        bucket = latency_bucket(latency if isinstance(latency, int) else None)
        lb = latency_stats.get(bucket)
        if lb is None:
            lb = {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0}
            latency_stats[bucket] = lb
        lb["tx"] += 1
        if not executed:
            lb["fail"] += 1
        lb["tip_sum"] += tip
        lb["solw_sum"] += solw_delta
        lb["stable_sum"] += stable_delta

    program_rows = []
    for pid, ps in program_stats.items():
        if ps["tx"] == 0:
            continue
        instr_stats = summarize_hist(ps["instr_hist"])
        inner_stats = summarize_hist(ps["inner_hist"])
        program_rows.append({
            "program": PROGRAM_NAME_BY_ID.get(pid, pid),
            "tx": ps["tx"],
            "fail_rate": pct(ps["fail"], ps["tx"]),
            "tip_rate": pct(ps["tip_tx"], ps["tx"]),
            "tip_avg": ps["tip_sum"] / ps["tx"] if ps["tx"] else 0,
            "tip_success_avg": ps["tip_success_sum"] / ps["exec"] if ps["exec"] else 0,
            "tip_fail_avg": ps["tip_fail_sum"] / ps["fail"] if ps["fail"] else 0,
            "instr_p50": instr_stats["p50"],
            "instr_p90": instr_stats["p90"],
            "inner_p50": inner_stats["p50"],
            "inner_p90": inner_stats["p90"],
            "compute_avg": ps["compute_sum"] / ps["tx"] if ps["tx"] else 0,
            "compute_success_avg": ps["compute_success_sum"] / ps["exec"] if ps["exec"] else 0,
            "compute_fail_avg": ps["compute_fail_sum"] / ps["fail"] if ps["fail"] else 0,
            "solw_sum": ps["solw_sum"] / LAMPORTS_PER_SOL,
            "stable_sum": ps["stable_sum"] / 1e6,
            "agg_cooccur_rate": pct(ps["agg_cooccur"], ps["tx"]),
            "multi_dex_rate": pct(ps["multi_dex"], ps["tx"]),
            "top_errors": ps["error_counts"].most_common(5),
        })

    flow_rows = []
    for flow_key, fs in flow_stats.items():
        flow_rows.append({
            "flow": flow_key,
            "tx": fs["tx"],
            "fail_rate": pct(fs["fail"], fs["tx"]),
            "tip_avg": fs["tip_sum"] / fs["tx"] if fs["tx"] else 0,
            "solw_sum": fs["solw_sum"] / LAMPORTS_PER_SOL,
            "stable_sum": fs["stable_sum"] / 1e6,
        })

    latency_rows = []
    for bucket, lb in latency_stats.items():
        latency_rows.append({
            "bucket": bucket,
            "tx": lb["tx"],
            "fail_rate": pct(lb["fail"], lb["tx"]),
            "tip_avg": lb["tip_sum"] / lb["tx"] if lb["tx"] else 0,
            "solw_sum": lb["solw_sum"] / LAMPORTS_PER_SOL,
            "stable_sum": lb["stable_sum"] / 1e6,
        })

    category_rows = []
    for key, cat in category_stats.items():
        category_rows.append({
            "category": key,
            "tx": cat["tx"],
            "fail_rate": pct(cat["fail"], cat["tx"]),
            "tip_avg": cat["tip_sum"] / cat["tx"] if cat["tx"] else 0,
            "solw_sum": cat["solw_sum"] / LAMPORTS_PER_SOL,
            "stable_sum": cat["stable_sum"] / 1e6,
        })

    mint_rows = []
    for mint, ms in mint_stats.items():
        dec = ms["decimals"]
        units = to_units(ms["delta"], dec) if dec is not None else None
        mint_rows.append({
            "mint": mint,
            "net_delta": units if units is not None else ms["delta"],
            "tx": ms["tx"],
            "decimals": dec,
        })

    mint_rows = sorted(mint_rows, key=lambda r: abs(float(r["net_delta"])), reverse=True)
    flow_rows = sorted(flow_rows, key=lambda r: r["tx"], reverse=True)
    bucket_order = {
        "<0": 0,
        "0-50": 1,
        "50-100": 2,
        "100-200": 3,
        "200-500": 4,
        "500-1000": 5,
        "1000+": 6,
        "unknown": 7,
    }
    latency_rows = sorted(latency_rows, key=lambda r: bucket_order.get(r["bucket"], 99))
    program_rows = sorted(program_rows, key=lambda r: r["tx"], reverse=True)
    category_rows = sorted(category_rows, key=lambda r: r["tx"], reverse=True)

    return {
        "programs": program_rows,
        "flows": flow_rows,
        "latency": latency_rows,
        "categories": category_rows,
        "mints": mint_rows,
    }


def analyze_pools(input_path: str, top_n: int = 50) -> List[Dict]:
    pool_stats: Dict[str, Dict] = {}

    for tx in iter_transactions(input_path):
        fee_payer = tx.get("feePayer")
        if not fee_payer:
            continue
        pools = tx.get("poolsTargeted") or []
        if not pools:
            continue

        executed = bool(tx.get("executed"))
        tip = int(tx.get("jitoTipAmount") or 0)
        sol_delta = int(tx.get("feePayerSolChange") or 0)
        wsol_delta = 0
        stable_delta = 0
        for change in tx.get("tokenChanges") or []:
            if change.get("owner") != fee_payer:
                continue
            mint = change.get("mint")
            if not mint:
                continue
            try:
                delta = int(change.get("deltaAmount") or 0)
            except Exception:
                continue
            if mint == WSOL_MINT:
                wsol_delta += delta
            if mint == USDC_MINT or mint == USDT_MINT:
                stable_delta += delta
        solw_delta = sol_delta + wsol_delta
        agg_tx = 1 if tx.get("aggregatorProgramsInvoked") else 0

        for pool in pools:
            ps = pool_stats.get(pool)
            if ps is None:
                ps = {"tx": 0, "fail": 0, "tip_sum": 0, "solw_sum": 0, "stable_sum": 0, "agg_tx": 0}
                pool_stats[pool] = ps
            ps["tx"] += 1
            if not executed:
                ps["fail"] += 1
            ps["tip_sum"] += tip
            ps["solw_sum"] += solw_delta
            ps["stable_sum"] += stable_delta
            ps["agg_tx"] += agg_tx

    top_pools = sorted(pool_stats.items(), key=lambda x: x[1]["tx"], reverse=True)[:top_n]
    top_set = {p for p, _ in top_pools}
    pool_wallets: Dict[str, set] = {p: set() for p in top_set}

    for tx in iter_transactions(input_path):
        fee_payer = tx.get("feePayer")
        if not fee_payer:
            continue
        pools = tx.get("poolsTargeted") or []
        for pool in pools:
            if pool in pool_wallets:
                pool_wallets[pool].add(fee_payer)

    rows = []
    for pool, ps in top_pools:
        rows.append({
            "pool": pool,
            "tx": ps["tx"],
            "fail_rate": pct(ps["fail"], ps["tx"]),
            "tip_avg": ps["tip_sum"] / ps["tx"] if ps["tx"] else 0,
            "solw_sum": ps["solw_sum"] / LAMPORTS_PER_SOL,
            "stable_sum": ps["stable_sum"] / 1e6,
            "agg_share": pct(ps["agg_tx"], ps["tx"]),
            "unique_wallets": len(pool_wallets.get(pool, set())),
        })

    return rows


def analyze_cohorts(wallet_stats: Dict[str, Dict], min_tx: int) -> Dict[str, List[Dict]]:
    def agg_bucket(v: float) -> str:
        if v == 0:
            return "0"
        if v < 0.2:
            return "0-0.2"
        if v < 0.8:
            return "0.2-0.8"
        return "0.8-1.0"

    def tip_bucket(v: float) -> str:
        if v == 0:
            return "0"
        if v < 1000:
            return "0-1k"
        if v < 10000:
            return "1k-10k"
        if v < 100000:
            return "10k-100k"
        return "100k+"

    agg_stats: Dict[str, Dict] = {}
    tip_stats: Dict[str, Dict] = {}

    for wallet, m in wallet_stats.items():
        if m["tx"] < min_tx:
            continue
        tx = m["tx"]
        agg_share = m["agg_tx"] / tx if tx else 0
        tip_avg = m["tip_sum"] / tx if tx else 0
        fail_rate = m["fail"] / tx if tx else 0
        solw = m["sol_delta"] + m["wsol_delta"]
        stable = m["usdc_delta"] + m["usdt_delta"]

        a_bucket = agg_bucket(agg_share)
        t_bucket = tip_bucket(tip_avg)

        for bucket, stats in ((a_bucket, agg_stats), (t_bucket, tip_stats)):
            entry = stats.get(bucket)
            if entry is None:
                entry = {
                    "wallets": 0,
                    "tx_sum": 0,
                    "fail_rate_sum": 0.0,
                    "tip_avg_sum": 0.0,
                    "solw_pos": 0,
                    "solw_sum": 0,
                    "stable_sum": 0,
                }
                stats[bucket] = entry
            entry["wallets"] += 1
            entry["tx_sum"] += tx
            entry["fail_rate_sum"] += fail_rate
            entry["tip_avg_sum"] += tip_avg
            entry["solw_sum"] += solw
            entry["stable_sum"] += stable
            if solw > 0:
                entry["solw_pos"] += 1

    def finalize(stats: Dict[str, Dict], order: List[str]) -> List[Dict]:
        rows = []
        for bucket in order:
            entry = stats.get(bucket)
            if not entry:
                continue
            wallets = entry["wallets"]
            rows.append({
                "bucket": bucket,
                "wallets": wallets,
                "avg_tx": entry["tx_sum"] / wallets if wallets else 0,
                "avg_fail_rate": entry["fail_rate_sum"] / wallets if wallets else 0,
                "avg_tip": entry["tip_avg_sum"] / wallets if wallets else 0,
                "solw_pos_rate": entry["solw_pos"] / wallets if wallets else 0,
                "solw_sum": entry["solw_sum"] / LAMPORTS_PER_SOL,
                "stable_sum": entry["stable_sum"] / 1e6,
            })
        return rows

    return {
        "agg_share": finalize(agg_stats, ["0", "0-0.2", "0.2-0.8", "0.8-1.0"]),
        "tip_intensity": finalize(tip_stats, ["0", "0-1k", "1k-10k", "10k-100k", "100k+"]),
    }

def summarize_wallets(
    wallet_stats: Dict[str, Dict],
    wallet_counts: Counter,
    min_tx: int,
) -> Dict:
    total_wallets = len(wallet_counts)
    sol_pos = sol_neg = sol_zero = 0
    solw_pos = solw_neg = solw_zero = 0
    stable_pos = stable_neg = stable_zero = 0

    for wallet, m in wallet_stats.items():
        if m["sol_delta"] > 0:
            sol_pos += 1
        elif m["sol_delta"] < 0:
            sol_neg += 1
        else:
            sol_zero += 1

        solw = m["sol_delta"] + m["wsol_delta"]
        if solw > 0:
            solw_pos += 1
        elif solw < 0:
            solw_neg += 1
        else:
            solw_zero += 1

        stable = m["usdc_delta"] + m["usdt_delta"]
        if stable > 0:
            stable_pos += 1
        elif stable < 0:
            stable_neg += 1
        else:
            stable_zero += 1

    eligible_wallets = 0
    solw_pos_min = solw_neg_min = solw_zero_min = 0
    stable_pos_min = stable_neg_min = stable_zero_min = 0

    for wallet, m in wallet_stats.items():
        if m["tx"] < min_tx:
            continue
        eligible_wallets += 1
        solw = m["sol_delta"] + m["wsol_delta"]
        if solw > 0:
            solw_pos_min += 1
        elif solw < 0:
            solw_neg_min += 1
        else:
            solw_zero_min += 1

        stable = m["usdc_delta"] + m["usdt_delta"]
        if stable > 0:
            stable_pos_min += 1
        elif stable < 0:
            stable_neg_min += 1
        else:
            stable_zero_min += 1

    return {
        "wallets_total": total_wallets,
        "sol": {"pos": sol_pos, "neg": sol_neg, "zero": sol_zero},
        "sol_wsol": {"pos": solw_pos, "neg": solw_neg, "zero": solw_zero},
        "stable": {"pos": stable_pos, "neg": stable_neg, "zero": stable_zero},
        "min_tx": min_tx,
        "min_tx_wallets": eligible_wallets,
        "min_tx_sol_wsol": {"pos": solw_pos_min, "neg": solw_neg_min, "zero": solw_zero_min},
        "min_tx_stable": {"pos": stable_pos_min, "neg": stable_neg_min, "zero": stable_zero_min},
    }


def main() -> int:
    args = parse_args()
    input_path = args.input

    wallet_stats, wallet_counts = compute_wallet_metrics(input_path)
    top_wallets = [w for w, _ in wallet_counts.most_common(args.top_wallets)]

    repo_root = Path(__file__).resolve().parents[2]
    helius_key = load_helius_key(args.helius_key, args.helius_config, repo_root)

    token_deltas, mint_decimals = compute_top_wallet_token_deltas(input_path, top_wallets)

    prices: Dict[str, float] = {}
    if args.price_file:
        try:
            prices.update(read_price_file(args.price_file))
        except Exception as exc:
            print(f"price file error: {exc}", file=sys.stderr)

    if args.price_source == "jup":
        # Only fetch for mints seen in top wallets to keep this bounded.
        mint_set = set(mint_decimals.keys())
        mint_set.add(WSOL_MINT)
        mints = sorted(mint_set)
        try:
            prices.update(fetch_jup_prices(mints, vs_token=args.price_vs))
        except Exception as exc:
            print(f"price fetch error: {exc}", file=sys.stderr)
    elif args.price_source == "helius":
        mint_set = set(mint_decimals.keys())
        mint_set.add(WSOL_MINT)
        mints = sorted(mint_set)
        if not helius_key:
            print("helius price source selected but no API key found", file=sys.stderr)
        else:
            try:
                prices.update(fetch_helius_prices(mints, helius_key))
            except Exception as exc:
                print(f"helius price fetch error: {exc}", file=sys.stderr)

    # Per-wallet PnL for top wallets (mark-to-market in USDC)
    pnl_rows = []
    for w in top_wallets:
        m = wallet_stats[w]
        tx = m["tx"]
        agg_share = pct(m["agg_tx"], tx)
        fail_rate = pct(m["fail"], tx)
        tip_avg = m["tip_sum"] / tx if tx else 0.0

        sol_units = m["sol_delta"] / LAMPORTS_PER_SOL
        sol_price = prices.get(WSOL_MINT)
        sol_value = sol_units * sol_price if sol_price is not None else 0.0

        token_value = 0.0
        stable_value = 0.0
        priced = 0
        total_mints = 0
        for mint, delta in token_deltas[w].items():
            total_mints += 1
            dec = mint_decimals.get(mint)
            units = to_units(delta, dec)
            price = prices.get(mint)
            if price is None:
                continue
            priced += 1
            token_value += units * price
            if mint in (USDC_MINT, USDT_MINT):
                stable_value += units * price

        total_value = sol_value + token_value
        coverage = pct(priced, total_mints) if total_mints else 0.0

        pnl_rows.append({
            "wallet": w,
            "tx": tx,
            "agg_share": agg_share,
            "fail_rate": fail_rate,
            "tip_avg_lamports": tip_avg,
            "sol_value_usdc": sol_value,
            "token_value_usdc": token_value,
            "total_value_usdc": total_value,
            "stable_value_usdc": stable_value,
            "price_coverage": coverage,
            "total_mints": total_mints,
        })

    pnl_rows_sorted = sorted(pnl_rows, key=lambda r: r["total_value_usdc"], reverse=True)

    # Additional derived tables
    solw_rows = []
    stable_rows = []
    for w, m in wallet_stats.items():
        if m["tx"] < args.min_tx:
            continue
        solw = (m["sol_delta"] + m["wsol_delta"]) / LAMPORTS_PER_SOL
        stable = (m["usdc_delta"] + m["usdt_delta"]) / 1e6
        solw_rows.append({
            "wallet": w,
            "tx": m["tx"],
            "sol_wsol": solw,
            "agg_share": pct(m["agg_tx"], m["tx"]),
        })
        stable_rows.append({
            "wallet": w,
            "tx": m["tx"],
            "stable": stable,
            "sol_wsol": solw,
            "agg_share": pct(m["agg_tx"], m["tx"]),
        })

    solw_rows = sorted(solw_rows, key=lambda r: r["sol_wsol"], reverse=True)
    stable_rows = sorted(stable_rows, key=lambda r: r["stable"], reverse=True)

    tx_analysis = analyze_transactions(input_path)
    pool_rows = analyze_pools(input_path, top_n=50)
    cohort_rows = analyze_cohorts(wallet_stats, args.min_tx)

    summary = {
        "input": input_path,
        "price_source": args.price_source,
        "helius_key_loaded": bool(helius_key),
        "top_wallets": top_wallets,
        "counts": summarize_wallets(wallet_stats, wallet_counts, args.min_tx),
        "solw_top": solw_rows[:10],
        "stable_top": stable_rows[:10],
        "pnl_top": pnl_rows_sorted[:10],
        "pnl_bottom": list(reversed(pnl_rows_sorted[-10:])),
        "programs": tx_analysis["programs"][:10],
        "program_errors": {p["program"]: p["top_errors"] for p in tx_analysis["programs"][:10]},
        "flows": tx_analysis["flows"][:15],
        "latency": tx_analysis["latency"],
        "categories": tx_analysis["categories"],
        "pools": pool_rows[:20],
        "cohorts": cohort_rows,
        "mint_flows": tx_analysis["mints"][:20],
        "price_coverage_overall": {
            "priced_mints": len(prices),
            "mint_decimals": len(mint_decimals),
        },
    }

    if args.out:
        Path(args.out).write_text(json.dumps(summary, indent=2))

    if args.report:
        lines = []
        counts = summary["counts"]
        lines.append("# DEX PnL Summary (conservative)\n")
        lines.append("## Coverage\n")
        lines.append(f"- Wallets observed: {counts['wallets_total']}\n")
        lines.append(f"- Min tx threshold: {counts['min_tx']} ({counts['min_tx_wallets']} wallets)\n")
        lines.append(f"- Priced mints: {summary['price_coverage_overall']['priced_mints']} of {summary['price_coverage_overall']['mint_decimals']}\n")
        lines.append("\n## SOL+WSOL outcomes\n")
        lines.append(f"- All wallets: +{counts['sol_wsol']['pos']} / -{counts['sol_wsol']['neg']} / 0:{counts['sol_wsol']['zero']}\n")
        lines.append(f"- Min tx wallets: +{counts['min_tx_sol_wsol']['pos']} / -{counts['min_tx_sol_wsol']['neg']} / 0:{counts['min_tx_sol_wsol']['zero']}\n")
        lines.append("\n## Stable (USDC+USDT) outcomes\n")
        lines.append(f"- All wallets: +{counts['stable']['pos']} / -{counts['stable']['neg']} / 0:{counts['stable']['zero']}\n")
        lines.append(f"- Min tx wallets: +{counts['min_tx_stable']['pos']} / -{counts['min_tx_stable']['neg']} / 0:{counts['min_tx_stable']['zero']}\n")

        def fmt(v: object) -> str:
            if isinstance(v, float):
                return f"{v:.6f}"
            return str(v)

        def table(title: str, rows: List[Dict], cols: List[str]) -> None:
            lines.append(f"\n## {title}\n")
            lines.append("| " + " | ".join(cols) + " |\n")
            lines.append("| " + " | ".join(["---"] * len(cols)) + " |\n")
            for r in rows:
                lines.append("| " + " | ".join(fmt(r.get(c, "")) for c in cols) + " |\n")

        table(
            "Top SOL+WSOL (min tx)",
            summary["solw_top"],
            ["wallet", "tx", "sol_wsol", "agg_share"],
        )
        table(
            "Top Stable Net (min tx)",
            summary["stable_top"],
            ["wallet", "tx", "stable", "sol_wsol", "agg_share"],
        )
        table(
            "Category Summary (DEX vs Agg)",
            summary["categories"],
            ["category", "tx", "fail_rate", "tip_avg", "solw_sum", "stable_sum"],
        )
        table(
            "Top Programs",
            summary["programs"],
            [
                "program",
                "tx",
                "fail_rate",
                "tip_rate",
                "tip_avg",
                "instr_p50",
                "inner_p50",
                "compute_avg",
                "solw_sum",
                "stable_sum",
            ],
        )
        lines.append("\n## Program Error Signatures\n")
        for program, errors in summary["program_errors"].items():
            if not errors:
                continue
            parts = [f"{e[0]} ({e[1]})" for e in errors]
            lines.append(f"- {program}: " + ", ".join(parts) + "\n")
        table(
            "Top Program Flows",
            summary["flows"],
            ["flow", "tx", "fail_rate", "tip_avg", "solw_sum", "stable_sum"],
        )
        table(
            "Latency Buckets",
            summary["latency"],
            ["bucket", "tx", "fail_rate", "tip_avg", "solw_sum", "stable_sum"],
        )
        table(
            "Top Pools",
            summary["pools"],
            ["pool", "tx", "fail_rate", "tip_avg", "solw_sum", "stable_sum", "agg_share", "unique_wallets"],
        )
        table(
            "Cohorts by Aggregator Share",
            summary["cohorts"]["agg_share"],
            ["bucket", "wallets", "avg_tx", "avg_fail_rate", "avg_tip", "solw_pos_rate", "solw_sum", "stable_sum"],
        )
        table(
            "Cohorts by Tip Intensity",
            summary["cohorts"]["tip_intensity"],
            ["bucket", "wallets", "avg_tx", "avg_fail_rate", "avg_tip", "solw_pos_rate", "solw_sum", "stable_sum"],
        )
        table(
            "Top Mint Net Flows",
            summary["mint_flows"],
            ["mint", "net_delta", "tx", "decimals"],
        )
        table(
            "Top Mark-to-Market (top wallets)",
            summary["pnl_top"],
            ["wallet", "tx", "total_value_usdc", "price_coverage", "agg_share", "fail_rate"],
        )
        table(
            "Bottom Mark-to-Market (top wallets)",
            summary["pnl_bottom"],
            ["wallet", "tx", "total_value_usdc", "price_coverage", "agg_share", "fail_rate"],
        )

        Path(args.report).write_text("".join(lines))

    # Print a short console summary
    print(json.dumps({
        "wallets": summary["counts"]["wallets_total"],
        "min_tx_wallets": summary["counts"]["min_tx_wallets"],
        "priced_mints": summary["price_coverage_overall"]["priced_mints"],
        "priced_mints_total": summary["price_coverage_overall"]["mint_decimals"],
    }))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
