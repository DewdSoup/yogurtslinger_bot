#!/usr/bin/env tsx
/**
 * Verify: Do pool reserves match vault balances?
 *
 * This script checks if the reserves stored in pool state
 * match the actual vault token balances at activation time.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQLITE_FILE = join(__dirname, '..', 'data', 'evidence', 'capture.db');

// SPL Token account layout offsets
const TOKEN_AMOUNT_OFFSET = 64; // amount is at offset 64 in SPL token account

function decodeTokenAmount(data: Buffer): bigint {
    // SPL Token account: amount is u64 at offset 64
    return data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

// PumpSwap pool layout (simplified)
const PUMPSWAP_BASE_RESERVE_OFFSET = 8 + 1 + 2 + 32 + 32 + 32 + 32 + 32 + 32; // After discriminator, bump, index, creator, baseMint, quoteMint, lpMint, baseVault, quoteVault
// Actually let me find the exact offset by reading the decoder

function toHex(bytes: Uint8Array | Buffer): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

async function main() {
    const db = new Database(SQLITE_FILE, { readonly: true });

    // Get frozen topologies with their vault pubkeys
    const topologies = db.prepare(`
        SELECT
            pool_pubkey,
            vault_base,
            vault_quote,
            frozen_at_slot,
            venue
        FROM frozen_topologies
        LIMIT 100
    `).all() as Array<{
        pool_pubkey: string;
        vault_base: string;
        vault_quote: string;
        frozen_at_slot: number;
        venue: number;
    }>;

    console.log(`Checking ${topologies.length} pools...\n`);

    let checked = 0;
    let mismatches = 0;
    const results: Array<{
        pool: string;
        venue: number;
        poolSlot: number;
        vaultSlot: number;
        slotDelta: number;
        match: boolean;
        details: string;
    }> = [];

    for (const topo of topologies) {
        // Get pool data at frozen slot
        const poolData = db.prepare(`
            SELECT data_b64, slot
            FROM mainnet_updates
            WHERE pubkey = ?
            ORDER BY slot DESC
            LIMIT 1
        `).get(topo.pool_pubkey) as { data_b64: string; slot: number } | undefined;

        // Get vault data
        const baseVaultData = db.prepare(`
            SELECT data_b64, slot
            FROM mainnet_updates
            WHERE pubkey = ?
            ORDER BY slot DESC
            LIMIT 1
        `).get(topo.vault_base) as { data_b64: string; slot: number } | undefined;

        const quoteVaultData = db.prepare(`
            SELECT data_b64, slot
            FROM mainnet_updates
            WHERE pubkey = ?
            ORDER BY slot DESC
            LIMIT 1
        `).get(topo.vault_quote) as { data_b64: string; slot: number } | undefined;

        if (!poolData || !baseVaultData || !quoteVaultData) {
            continue;
        }

        checked++;

        const poolBuffer = Buffer.from(poolData.data_b64, 'base64');
        const baseVaultBuffer = Buffer.from(baseVaultData.data_b64, 'base64');
        const quoteVaultBuffer = Buffer.from(quoteVaultData.data_b64, 'base64');

        // Decode vault balances
        const baseVaultBalance = decodeTokenAmount(baseVaultBuffer);
        const quoteVaultBalance = decodeTokenAmount(quoteVaultBuffer);

        // Slot comparison
        const poolSlot = poolData.slot;
        const vaultSlot = Math.max(baseVaultData.slot, quoteVaultData.slot);
        const slotDelta = Math.abs(poolSlot - vaultSlot);

        // For PumpSwap (venue 0), decode reserves
        // Layout: 8 (disc) + 1 (bump) + 2 (index) + 32*6 (pubkeys) + 8 (baseReserves) + 8 (quoteReserves)
        if (topo.venue === 0 && poolBuffer.length >= 220) {
            const baseReserveOffset = 8 + 1 + 2 + 32 * 6; // 203
            const quoteReserveOffset = baseReserveOffset + 8; // 211

            const poolBaseReserve = poolBuffer.readBigUInt64LE(baseReserveOffset);
            const poolQuoteReserve = poolBuffer.readBigUInt64LE(quoteReserveOffset);

            const baseMatch = poolBaseReserve === baseVaultBalance;
            const quoteMatch = poolQuoteReserve === quoteVaultBalance;

            if (!baseMatch || !quoteMatch) {
                mismatches++;
            }

            results.push({
                pool: topo.pool_pubkey.slice(0, 16) + '...',
                venue: topo.venue,
                poolSlot,
                vaultSlot,
                slotDelta,
                match: baseMatch && quoteMatch,
                details: `base: pool=${poolBaseReserve} vault=${baseVaultBalance} ${baseMatch ? '✓' : '✗'} | quote: pool=${poolQuoteReserve} vault=${quoteVaultBalance} ${quoteMatch ? '✓' : '✗'}`
            });
        }
    }

    // Print results
    console.log('='.repeat(120));
    console.log('RESERVE vs VAULT BALANCE COMPARISON');
    console.log('='.repeat(120));
    console.log(`Checked: ${checked} pools`);
    console.log(`Mismatches: ${mismatches} (${(100 * mismatches / checked).toFixed(1)}%)`);
    console.log('');

    // Show mismatches
    const mismatchResults = results.filter(r => !r.match);
    if (mismatchResults.length > 0) {
        console.log('MISMATCHES:');
        console.log('-'.repeat(120));
        for (const r of mismatchResults.slice(0, 20)) {
            console.log(`Pool: ${r.pool} | Venue: ${r.venue} | SlotΔ: ${r.slotDelta}`);
            console.log(`  ${r.details}`);
        }
    }

    // Show matches with slot delta > 0
    const deltaMatches = results.filter(r => r.match && r.slotDelta > 0);
    if (deltaMatches.length > 0) {
        console.log('\nMATCHES WITH SLOT DELTA > 0:');
        console.log('-'.repeat(120));
        for (const r of deltaMatches.slice(0, 10)) {
            console.log(`Pool: ${r.pool} | Venue: ${r.venue} | SlotΔ: ${r.slotDelta} | ${r.details}`);
        }
    }

    // Summary by slot delta
    console.log('\nSUMMARY BY SLOT DELTA:');
    console.log('-'.repeat(60));
    const deltaGroups = new Map<string, { total: number; matches: number }>();
    for (const r of results) {
        const group = r.slotDelta === 0 ? '0' : r.slotDelta <= 5 ? '1-5' : r.slotDelta <= 20 ? '6-20' : '>20';
        const existing = deltaGroups.get(group) || { total: 0, matches: 0 };
        existing.total++;
        if (r.match) existing.matches++;
        deltaGroups.set(group, existing);
    }
    for (const [group, stats] of deltaGroups) {
        console.log(`SlotΔ ${group}: ${stats.matches}/${stats.total} match (${(100 * stats.matches / stats.total).toFixed(1)}%)`);
    }

    db.close();
}

main().catch(console.error);
