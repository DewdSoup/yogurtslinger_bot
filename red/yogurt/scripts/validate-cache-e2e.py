#!/usr/bin/env python3
"""
End-to-End Cache Validation

THE REAL TEST: Use local cache state as input, run math, compare to actual on-chain output.

Methodology:
1. For each swap in parsed_swaps:
   - Get the pool from frozen_topologies (vault_base, vault_quote)
   - Get the MOST RECENT mainnet_updates for those vaults BEFORE the swap's slot
   - Decode vault balances from data_b64 (Token Account: offset 64, u64 little-endian = amount)
   - Use those balances as input to CPMM math
   - Compare calculated amountOut to actual_output_amount from parsed_swaps

For PumpSwap, feeBps = 25
"""

import sqlite3
import base64
import struct
from dataclasses import dataclass
from typing import Optional, Tuple
import sys

DB_PATH = "data/evidence/capture.db"

@dataclass
class SwapData:
    pool_pubkey: str
    swap_slot: int
    input_amount: int
    actual_output: int
    direction: int  # 0 = base->quote, 1 = quote->base
    vault_base: str
    vault_quote: str
    signature: str
    is_single_swap: bool = True

@dataclass
class VaultState:
    pubkey: str
    slot: int
    amount: int  # Token balance from account data

@dataclass
class ValidationResult:
    swap: SwapData
    base_vault_state: Optional[VaultState]
    quote_vault_state: Optional[VaultState]
    calculated_output: Optional[int]
    actual_output: int
    error_bps: Optional[float]
    match: bool
    failure_reason: Optional[str]


def decode_token_account_amount(data_b64: str) -> int:
    """
    Decode token balance from Token Account data.
    Token Account layout:
    - 0-31: mint (32 bytes)
    - 32-63: owner (32 bytes)
    - 64-71: amount (u64 little-endian)
    """
    data = base64.b64decode(data_b64)
    if len(data) < 72:
        raise ValueError(f"Token account data too short: {len(data)} bytes")
    amount = struct.unpack('<Q', data[64:72])[0]
    return amount


def cpmm_get_amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int = 25) -> int:
    """
    CPMM formula:
    amountOut = (amountIn * (10000 - feeBps) * reserveOut) / (reserveIn * 10000 + amountIn * (10000 - feeBps))
    """
    if reserve_in == 0 or reserve_out == 0:
        return 0

    amount_in_with_fee = amount_in * (10000 - fee_bps)
    numerator = amount_in_with_fee * reserve_out
    denominator = reserve_in * 10000 + amount_in_with_fee

    if denominator == 0:
        return 0

    return numerator // denominator


def get_vault_state_before_slot(conn: sqlite3.Connection, vault_pubkey: str, before_slot: int) -> Optional[VaultState]:
    """Get the most recent vault state before a given slot."""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT pubkey, slot, data_b64
        FROM mainnet_updates
        WHERE pubkey = ? AND slot < ?
        ORDER BY slot DESC
        LIMIT 1
    """, (vault_pubkey, before_slot))

    row = cursor.fetchone()
    if row is None:
        return None

    pubkey, slot, data_b64 = row
    try:
        amount = decode_token_account_amount(data_b64)
        return VaultState(pubkey=pubkey, slot=slot, amount=amount)
    except Exception as e:
        print(f"Error decoding vault {pubkey}: {e}", file=sys.stderr)
        return None


def validate_swap(conn: sqlite3.Connection, swap: SwapData) -> ValidationResult:
    """Validate a single swap using cache state."""

    # Get vault states before the swap
    base_vault = get_vault_state_before_slot(conn, swap.vault_base, swap.swap_slot)
    quote_vault = get_vault_state_before_slot(conn, swap.vault_quote, swap.swap_slot)

    # Check if we have both vault states
    if base_vault is None or quote_vault is None:
        missing = []
        if base_vault is None:
            missing.append("base_vault")
        if quote_vault is None:
            missing.append("quote_vault")
        return ValidationResult(
            swap=swap,
            base_vault_state=base_vault,
            quote_vault_state=quote_vault,
            calculated_output=None,
            actual_output=swap.actual_output,
            error_bps=None,
            match=False,
            failure_reason=f"Missing vault state: {', '.join(missing)}"
        )

    # Determine reserves based on direction
    # direction 0 = base -> quote (selling base, buying quote)
    # direction 1 = quote -> base (selling quote, buying base)
    if swap.direction == 0:
        reserve_in = base_vault.amount   # We're selling base
        reserve_out = quote_vault.amount  # We're buying quote
    else:
        reserve_in = quote_vault.amount  # We're selling quote
        reserve_out = base_vault.amount   # We're buying base

    # Calculate expected output
    calculated_output = cpmm_get_amount_out(swap.input_amount, reserve_in, reserve_out, fee_bps=25)

    # Calculate error
    if swap.actual_output > 0:
        error_bps = abs(calculated_output - swap.actual_output) * 10000 / swap.actual_output
    else:
        error_bps = None

    # Determine match (within 1 bps tolerance for rounding)
    match = error_bps is not None and error_bps <= 1

    failure_reason = None
    if not match:
        if error_bps is not None:
            failure_reason = f"Error {error_bps:.2f} bps"
        else:
            failure_reason = "Cannot calculate error (zero actual output)"

    return ValidationResult(
        swap=swap,
        base_vault_state=base_vault,
        quote_vault_state=quote_vault,
        calculated_output=calculated_output,
        actual_output=swap.actual_output,
        error_bps=error_bps,
        match=match,
        failure_reason=failure_reason
    )


def get_swaps_with_topologies(conn: sqlite3.Connection, venue: str = 'pumpswap', single_swap_only: bool = False, limit: int = None) -> list[SwapData]:
    """Get swaps joined with their frozen topologies."""
    cursor = conn.cursor()

    if single_swap_only:
        # Get only swaps from transactions with exactly 1 swap
        query = """
            WITH single_swap_txs AS (
                SELECT signature
                FROM parsed_swaps
                WHERE venue = ?
                GROUP BY signature
                HAVING COUNT(*) = 1
            )
            SELECT
                s.pool_pubkey,
                s.slot,
                s.input_amount,
                s.actual_output_amount,
                s.direction,
                f.vault_base,
                f.vault_quote,
                s.signature
            FROM parsed_swaps s
            INNER JOIN frozen_topologies f ON s.pool_pubkey = f.pool_pubkey
            INNER JOIN single_swap_txs sst ON s.signature = sst.signature
            WHERE s.venue = ?
            AND f.venue = 0  -- PumpSwap venue code
            AND s.actual_output_amount IS NOT NULL
            AND CAST(s.actual_output_amount AS INTEGER) > 0
            ORDER BY s.slot
        """
        params = (venue, venue)
    else:
        query = """
            SELECT
                s.pool_pubkey,
                s.slot,
                s.input_amount,
                s.actual_output_amount,
                s.direction,
                f.vault_base,
                f.vault_quote,
                s.signature
            FROM parsed_swaps s
            INNER JOIN frozen_topologies f ON s.pool_pubkey = f.pool_pubkey
            WHERE s.venue = ?
            AND f.venue = 0  -- PumpSwap venue code
            AND s.actual_output_amount IS NOT NULL
            AND CAST(s.actual_output_amount AS INTEGER) > 0
            ORDER BY s.slot
        """
        params = (venue,)

    if limit:
        query += f" LIMIT {limit}"

    cursor.execute(query, params)

    swaps = []
    for row in cursor.fetchall():
        pool_pubkey, slot, input_amount, actual_output, direction, vault_base, vault_quote, signature = row
        try:
            swaps.append(SwapData(
                pool_pubkey=pool_pubkey,
                swap_slot=int(slot),
                input_amount=int(input_amount),
                actual_output=int(actual_output),
                direction=int(direction) if direction is not None else 0,
                vault_base=vault_base,
                vault_quote=vault_quote,
                signature=signature,
                is_single_swap=single_swap_only
            ))
        except (ValueError, TypeError) as e:
            print(f"Skipping malformed swap: {e}", file=sys.stderr)

    return swaps


def main():
    conn = sqlite3.connect(DB_PATH)

    print("="*80)
    print("END-TO-END CACHE VALIDATION")
    print("Using LOCAL CACHE STATE as input, running CPMM math, comparing to ON-CHAIN output")
    print("="*80)
    print()

    # Run analysis for both single-swap only and all swaps
    for mode_name, single_swap_only in [("SINGLE-SWAP TRANSACTIONS ONLY", True), ("ALL SWAPS (including multi-swap TXs)", False)]:
        print()
        print("="*80)
        print(f"MODE: {mode_name}")
        print("="*80)
        print()

        print("Loading swaps with frozen topologies...")
        swaps = get_swaps_with_topologies(conn, venue='pumpswap', single_swap_only=single_swap_only)
        print(f"Total swaps: {len(swaps)}")
        print()

        # Validate each swap
        results = []
        matches = 0
        missing_state = 0
        mismatches = 0

        print("Validating swaps...")
        for i, swap in enumerate(swaps):
            result = validate_swap(conn, swap)
            results.append(result)

            if result.match:
                matches += 1
            elif result.failure_reason and "Missing vault state" in result.failure_reason:
                missing_state += 1
            else:
                mismatches += 1

            if (i + 1) % 10000 == 0:
                print(f"  Processed {i + 1}/{len(swaps)} swaps...")

        print()
        print("-"*60)
        print("RESULTS SUMMARY")
        print("-"*60)
        print()

        total = len(results)
        with_state = total - missing_state

        print(f"Total swaps evaluated:         {total}")
        print(f"Swaps with prior vault state:  {with_state}")
        print(f"Swaps missing vault state:     {missing_state}")
        print()

        if with_state > 0:
            match_rate = matches / with_state * 100
            mismatch_rate = mismatches / with_state * 100
            print(f"MATCH RATE (cache state as input): {matches}/{with_state} = {match_rate:.2f}%")
            print(f"MISMATCH RATE:                     {mismatches}/{with_state} = {mismatch_rate:.2f}%")

        # Error distribution for this mode
        errors = [r.error_bps for r in results if r.error_bps is not None and not r.match]
        if errors:
            errors.sort()
            print()
            print(f"Error distribution (n={len(errors)}):")
            print(f"  Min: {min(errors):.2f} bps")
            print(f"  P50: {errors[len(errors)//2]:.2f} bps")
            print(f"  P95: {errors[int(len(errors)*0.95)]:.2f} bps")
            print(f"  Max: {max(errors):.2f} bps")

            buckets = {
                "1-10 bps": len([e for e in errors if 1 < e <= 10]),
                "10-100 bps": len([e for e in errors if 10 < e <= 100]),
                "100-1000 bps": len([e for e in errors if 100 < e <= 1000]),
                "1000-10000 bps": len([e for e in errors if 1000 < e <= 10000]),
                ">10000 bps": len([e for e in errors if e > 10000]),
            }
            print()
            print("Error buckets:")
            for bucket, count in buckets.items():
                pct = count / len(errors) * 100 if errors else 0
                print(f"  {bucket}: {count} ({pct:.1f}%)")

        # Show sample mismatches only for single-swap mode
        if single_swap_only and mismatches > 0:
            print()
            print("-"*60)
            print("SAMPLE MISMATCHES (single-swap only)")
            print("-"*60)

            mismatch_samples = [r for r in results if not r.match and r.calculated_output is not None][:10]

            for r in mismatch_samples:
                print()
                print(f"Pool: {r.swap.pool_pubkey}")
                print(f"Swap slot: {r.swap.swap_slot}, Direction: {'base->quote' if r.swap.direction == 0 else 'quote->base'}")
                print(f"Input amount: {r.swap.input_amount:,}")
                if r.base_vault_state and r.quote_vault_state:
                    print(f"Cache state slot: base={r.base_vault_state.slot}, quote={r.quote_vault_state.slot}")
                    print(f"Cache reserves: base={r.base_vault_state.amount:,}, quote={r.quote_vault_state.amount:,}")
                print(f"Calculated output: {r.calculated_output:,}")
                print(f"Actual output:     {r.actual_output:,}")
                print(f"Error: {r.error_bps:.2f} bps")

    # Final conclusion
    print()
    print("="*80)
    print("CONCLUSION")
    print("="*80)

    conn.close()


if __name__ == "__main__":
    main()
