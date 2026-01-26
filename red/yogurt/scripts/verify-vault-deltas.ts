#!/usr/bin/env tsx
/**
 * Verify: How much do vault balances change between slots?
 *
 * This script analyzes actual mainnet data to measure:
 * 1. When vault and pool have different slots, how much does the vault balance differ?
 * 2. What's the magnitude of balance changes per slot?
 * 3. Does this create material simulation errors?
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQLITE_FILE = join(__dirname, '..', 'data', 'evidence', 'capture.db');

// SPL Token account layout
const TOKEN_AMOUNT_OFFSET = 64;

function decodeTokenAmount(data: Buffer): bigint {
    if (data.length < TOKEN_AMOUNT_OFFSET + 8) return 0n;
    return data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

function toHex(bytes: Buffer | Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
}

interface VaultUpdate {
    pubkey: string;
    slot: number;
    amount: bigint;
}

interface SlotDeltaAnalysis {
    vaultPubkey: string;
    slot1: number;
    slot2: number;
    slotDelta: number;
    amount1: bigint;
    amount2: bigint;
    amountDelta: bigint;
    amountDeltaPct: number;
}

async function main() {
    const db = new Database(SQLITE_FILE, { readonly: true });

    console.log('='.repeat(80));
    console.log('VAULT BALANCE DELTA ANALYSIS');
    console.log('='.repeat(80));
    console.log('');

    // Get all vault updates from mainnet_updates
    // Vaults are SPL Token accounts (165 bytes)
    const vaultUpdates = db.prepare(`
        SELECT pubkey, slot, data_b64
        FROM mainnet_updates
        WHERE LENGTH(data_b64) = 220  -- 165 bytes base64 encoded = 220 chars
        ORDER BY pubkey, slot
    `).all() as Array<{ pubkey: string; slot: number; data_b64: string }>;

    console.log(`Found ${vaultUpdates.length} vault updates\n`);

    // Group by vault pubkey
    const vaultHistory = new Map<string, VaultUpdate[]>();

    for (const update of vaultUpdates) {
        const data = Buffer.from(update.data_b64, 'base64');
        const amount = decodeTokenAmount(data);

        if (!vaultHistory.has(update.pubkey)) {
            vaultHistory.set(update.pubkey, []);
        }
        vaultHistory.get(update.pubkey)!.push({
            pubkey: update.pubkey,
            slot: update.slot,
            amount,
        });
    }

    console.log(`Unique vaults with updates: ${vaultHistory.size}\n`);

    // Analyze balance changes between consecutive slots for each vault
    const deltas: SlotDeltaAnalysis[] = [];

    for (const [pubkey, updates] of vaultHistory) {
        // Sort by slot
        updates.sort((a, b) => a.slot - b.slot);

        for (let i = 1; i < updates.length; i++) {
            const prev = updates[i - 1];
            const curr = updates[i];

            const slotDelta = curr.slot - prev.slot;
            const amountDelta = curr.amount - prev.amount;
            const amountDeltaAbs = amountDelta < 0n ? -amountDelta : amountDelta;

            // Calculate percentage change (avoid division by zero)
            let amountDeltaPct = 0;
            if (prev.amount > 0n) {
                amountDeltaPct = Number((amountDeltaAbs * 10000n) / prev.amount) / 100;
            }

            deltas.push({
                vaultPubkey: pubkey.slice(0, 16) + '...',
                slot1: prev.slot,
                slot2: curr.slot,
                slotDelta,
                amount1: prev.amount,
                amount2: curr.amount,
                amountDelta,
                amountDeltaPct,
            });
        }
    }

    console.log(`Total balance change events: ${deltas.length}\n`);

    // Statistics on slot deltas
    console.log('SLOT DELTA DISTRIBUTION:');
    console.log('-'.repeat(60));

    const slotDeltaBuckets = new Map<string, number>();
    for (const d of deltas) {
        const bucket = d.slotDelta === 0 ? '0' :
                      d.slotDelta === 1 ? '1' :
                      d.slotDelta <= 5 ? '2-5' :
                      d.slotDelta <= 10 ? '6-10' :
                      d.slotDelta <= 50 ? '11-50' : '>50';
        slotDeltaBuckets.set(bucket, (slotDeltaBuckets.get(bucket) || 0) + 1);
    }

    for (const [bucket, count] of slotDeltaBuckets) {
        console.log(`  Slot delta ${bucket}: ${count} (${(100 * count / deltas.length).toFixed(1)}%)`);
    }

    // Statistics on balance changes
    console.log('\nBALANCE CHANGE MAGNITUDE:');
    console.log('-'.repeat(60));

    const changesWithDelta = deltas.filter(d => d.amountDelta !== 0n);
    console.log(`  Vaults with balance change: ${changesWithDelta.length} / ${deltas.length} (${(100 * changesWithDelta.length / deltas.length).toFixed(1)}%)`);

    if (changesWithDelta.length > 0) {
        // Sort by absolute percentage change
        changesWithDelta.sort((a, b) => b.amountDeltaPct - a.amountDeltaPct);

        console.log('\n  Top 10 largest balance changes:');
        console.log('  ' + '-'.repeat(78));
        console.log('  Vault            | Slot Δ | Before           | After            | Change %');
        console.log('  ' + '-'.repeat(78));

        for (const d of changesWithDelta.slice(0, 10)) {
            console.log(`  ${d.vaultPubkey} | ${d.slotDelta.toString().padStart(6)} | ${d.amount1.toString().padStart(16)} | ${d.amount2.toString().padStart(16)} | ${d.amountDeltaPct.toFixed(2)}%`);
        }

        // Bucket by percentage change
        console.log('\n  Balance change distribution:');
        const pctBuckets = new Map<string, number>();
        for (const d of changesWithDelta) {
            const bucket = d.amountDeltaPct < 0.01 ? '<0.01%' :
                          d.amountDeltaPct < 0.1 ? '0.01-0.1%' :
                          d.amountDeltaPct < 1 ? '0.1-1%' :
                          d.amountDeltaPct < 10 ? '1-10%' : '>10%';
            pctBuckets.set(bucket, (pctBuckets.get(bucket) || 0) + 1);
        }

        for (const [bucket, count] of pctBuckets) {
            console.log(`    ${bucket.padEnd(12)}: ${count} (${(100 * count / changesWithDelta.length).toFixed(1)}%)`);
        }
    }

    // Now analyze: for pools with slot mismatch, what's the vault delta?
    console.log('\n' + '='.repeat(80));
    console.log('SLOT MISMATCH IMPACT ANALYSIS');
    console.log('='.repeat(80));
    console.log('');

    // Get pools with slot mismatches from snapshot_slot_consistency
    const mismatches = db.prepare(`
        SELECT
            ssc.pool_pubkey,
            ssc.pool_slot,
            ssc.base_vault_slot,
            ssc.quote_vault_slot,
            ssc.slot_delta,
            ft.vault_base,
            ft.vault_quote
        FROM snapshot_slot_consistency ssc
        JOIN frozen_topologies ft ON ft.pool_pubkey = ssc.pool_pubkey
        WHERE ssc.slot_delta > 0
        ORDER BY ssc.slot_delta DESC
        LIMIT 50
    `).all() as Array<{
        pool_pubkey: string;
        pool_slot: number;
        base_vault_slot: number;
        quote_vault_slot: number;
        slot_delta: number;
        vault_base: string;
        vault_quote: string;
    }>;

    console.log(`Analyzing ${mismatches.length} pools with slot mismatches...\n`);

    interface MismatchImpact {
        poolPubkey: string;
        slotDelta: number;
        baseVaultDelta: bigint;
        baseVaultDeltaPct: number;
        quoteVaultDelta: bigint;
        quoteVaultDeltaPct: number;
    }

    const impacts: MismatchImpact[] = [];

    for (const m of mismatches) {
        // Get vault balances at pool slot vs latest vault slot
        const baseAtPoolSlot = db.prepare(`
            SELECT data_b64 FROM mainnet_updates
            WHERE pubkey = ? AND slot <= ?
            ORDER BY slot DESC LIMIT 1
        `).get(m.vault_base, m.pool_slot) as { data_b64: string } | undefined;

        const baseAtVaultSlot = db.prepare(`
            SELECT data_b64 FROM mainnet_updates
            WHERE pubkey = ? AND slot <= ?
            ORDER BY slot DESC LIMIT 1
        `).get(m.vault_base, m.base_vault_slot) as { data_b64: string } | undefined;

        const quoteAtPoolSlot = db.prepare(`
            SELECT data_b64 FROM mainnet_updates
            WHERE pubkey = ? AND slot <= ?
            ORDER BY slot DESC LIMIT 1
        `).get(m.vault_quote, m.pool_slot) as { data_b64: string } | undefined;

        const quoteAtVaultSlot = db.prepare(`
            SELECT data_b64 FROM mainnet_updates
            WHERE pubkey = ? AND slot <= ?
            ORDER BY slot DESC LIMIT 1
        `).get(m.vault_quote, m.quote_vault_slot) as { data_b64: string } | undefined;

        if (!baseAtPoolSlot || !baseAtVaultSlot || !quoteAtPoolSlot || !quoteAtVaultSlot) {
            continue;
        }

        const baseAmountAtPoolSlot = decodeTokenAmount(Buffer.from(baseAtPoolSlot.data_b64, 'base64'));
        const baseAmountAtVaultSlot = decodeTokenAmount(Buffer.from(baseAtVaultSlot.data_b64, 'base64'));
        const quoteAmountAtPoolSlot = decodeTokenAmount(Buffer.from(quoteAtPoolSlot.data_b64, 'base64'));
        const quoteAmountAtVaultSlot = decodeTokenAmount(Buffer.from(quoteAtVaultSlot.data_b64, 'base64'));

        const baseVaultDelta = baseAmountAtVaultSlot - baseAmountAtPoolSlot;
        const quoteVaultDelta = quoteAmountAtVaultSlot - quoteAmountAtPoolSlot;

        let baseVaultDeltaPct = 0;
        let quoteVaultDeltaPct = 0;

        if (baseAmountAtPoolSlot > 0n) {
            const absBase = baseVaultDelta < 0n ? -baseVaultDelta : baseVaultDelta;
            baseVaultDeltaPct = Number((absBase * 10000n) / baseAmountAtPoolSlot) / 100;
        }
        if (quoteAmountAtPoolSlot > 0n) {
            const absQuote = quoteVaultDelta < 0n ? -quoteVaultDelta : quoteVaultDelta;
            quoteVaultDeltaPct = Number((absQuote * 10000n) / quoteAmountAtPoolSlot) / 100;
        }

        impacts.push({
            poolPubkey: m.pool_pubkey.slice(0, 16) + '...',
            slotDelta: m.slot_delta,
            baseVaultDelta,
            baseVaultDeltaPct,
            quoteVaultDelta,
            quoteVaultDeltaPct,
        });
    }

    if (impacts.length > 0) {
        console.log('Pool               | Slot Δ | Base Vault Δ     | Base %   | Quote Vault Δ    | Quote %');
        console.log('-'.repeat(95));

        for (const impact of impacts.slice(0, 20)) {
            console.log(
                `${impact.poolPubkey} | ${impact.slotDelta.toString().padStart(6)} | ` +
                `${impact.baseVaultDelta.toString().padStart(16)} | ${impact.baseVaultDeltaPct.toFixed(4).padStart(8)}% | ` +
                `${impact.quoteVaultDelta.toString().padStart(16)} | ${impact.quoteVaultDeltaPct.toFixed(4).padStart(7)}%`
            );
        }

        // Summary statistics
        const withActualChange = impacts.filter(i => i.baseVaultDeltaPct > 0 || i.quoteVaultDeltaPct > 0);
        console.log('\nSUMMARY:');
        console.log('-'.repeat(60));
        console.log(`  Pools analyzed: ${impacts.length}`);
        console.log(`  Pools with vault balance change: ${withActualChange.length} (${(100 * withActualChange.length / impacts.length).toFixed(1)}%)`);

        if (withActualChange.length > 0) {
            const avgBasePct = withActualChange.reduce((s, i) => s + i.baseVaultDeltaPct, 0) / withActualChange.length;
            const avgQuotePct = withActualChange.reduce((s, i) => s + i.quoteVaultDeltaPct, 0) / withActualChange.length;
            const maxBasePct = Math.max(...withActualChange.map(i => i.baseVaultDeltaPct));
            const maxQuotePct = Math.max(...withActualChange.map(i => i.quoteVaultDeltaPct));

            console.log(`  Avg base vault delta: ${avgBasePct.toFixed(4)}%`);
            console.log(`  Avg quote vault delta: ${avgQuotePct.toFixed(4)}%`);
            console.log(`  Max base vault delta: ${maxBasePct.toFixed(4)}%`);
            console.log(`  Max quote vault delta: ${maxQuotePct.toFixed(4)}%`);
        }
    }

    db.close();
}

main().catch(console.error);
