#!/usr/bin/env tsx
/**
 * Local Evidence Analysis — No MCP Dependency
 *
 * Outputs parity metrics directly from capture.db using better-sqlite3.
 * Run after capture-evidence.ts to get quantifiable measurements.
 *
 * Usage:
 *   pnpm exec tsx scripts/analyze-evidence.ts [session_id]
 *   (defaults to latest session)
 *
 * Critical for swap simulation parity:
 *   - Cache must reflect mainnet state EXACTLY
 *   - Any divergence = wrong price impact = bad MEV decisions
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const EVIDENCE_DIR = join(__dirname, '..', 'data', 'evidence');
const SQLITE_FILE = join(EVIDENCE_DIR, 'capture.db');
const OUTPUT_FILE = join(EVIDENCE_DIR, 'analysis.json');

// ============================================================================
// MAIN
// ============================================================================

function main(): void {
    if (!existsSync(SQLITE_FILE)) {
        console.error(`Database not found: ${SQLITE_FILE}`);
        console.error('Run capture-evidence.ts first.');
        process.exit(1);
    }

    const db = new Database(SQLITE_FILE, { readonly: true });
    const sessionId = process.argv[2] ?? getLatestSession(db);

    if (!sessionId) {
        console.error('No sessions found in database.');
        process.exit(1);
    }

    console.log('='.repeat(70));
    console.log('EVIDENCE ANALYSIS — LOCAL (No MCP)');
    console.log('='.repeat(70));
    console.log(`Session: ${sessionId}`);
    console.log(`Database: ${SQLITE_FILE}`);
    console.log('='.repeat(70));

    // Gather all metrics
    // Compute parity gap once and reuse (expensive query)
    const parityGapCount = computeParityGap(db, sessionId);

    const analysis = {
        session: getSessionInfo(db, sessionId),
        plane_counts: getPlaneCounts(db, sessionId),
        topology: getTopologyMetrics(db, sessionId),
        parity: getParityMetrics(db, sessionId, parityGapCount),
        latency: getLatencyMetrics(db, sessionId),
        critical_path: getCriticalPath(db, sessionId, parityGapCount),
    };

    // Output to console
    console.log('\n## SESSION INFO');
    console.log(JSON.stringify(analysis.session, null, 2));

    console.log('\n## PLANE COUNTS');
    console.log(JSON.stringify(analysis.plane_counts, null, 2));

    console.log('\n## TOPOLOGY METRICS');
    console.log(JSON.stringify(analysis.topology, null, 2));

    console.log('\n## PARITY METRICS (CRITICAL FOR SWAP SIM)');
    console.log(JSON.stringify(analysis.parity, null, 2));

    console.log('\n## LATENCY METRICS');
    console.log(JSON.stringify(analysis.latency, null, 2));

    console.log('\n## CRITICAL PATH TO 100% PARITY');
    console.log(JSON.stringify(analysis.critical_path, null, 2));

    // Write to file
    writeFileSync(OUTPUT_FILE, JSON.stringify(analysis, null, 2));
    console.log(`\nAnalysis written to: ${OUTPUT_FILE}`);

    db.close();
}

// ============================================================================
// QUERIES
// ============================================================================

function getLatestSession(db: Database.Database): string | null {
    const row = db.prepare(`
        SELECT id FROM capture_sessions
        ORDER BY started_at DESC
        LIMIT 1
    `).get() as { id: string } | undefined;
    return row?.id ?? null;
}

function computeParityGap(db: Database.Database, sessionId: string): number {
    // Use NOT EXISTS for better performance with proper indexes
    // This counts pubkeys in mainnet_updates that have no corresponding cache_traces entry
    console.log('  Computing parity gap (may take a moment for large datasets)...');
    const row = db.prepare(`
        SELECT COUNT(DISTINCT m.pubkey) as count
        FROM mainnet_updates m
        WHERE m.session_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM cache_traces c
            WHERE c.session_id = m.session_id AND c.pubkey = m.pubkey
          )
    `).get(sessionId) as { count: number };
    console.log(`  Parity gap: ${row.count} pubkeys`);
    return row.count;
}

function getSessionInfo(db: Database.Database, sessionId: string): any {
    const row = db.prepare(`
        SELECT
            id,
            script_hash,
            datetime(started_at/1000, 'unixepoch') as started,
            datetime(ended_at/1000, 'unixepoch') as ended,
            (ended_at - started_at)/1000 as duration_s,
            grpc_endpoint,
            shred_endpoint
        FROM capture_sessions
        WHERE id = ?
    `).get(sessionId);
    return row;
}

function getPlaneCounts(db: Database.Database, sessionId: string): any {
    const counts: any = {};

    const tables = [
        { name: 'P1_mainnet_updates', table: 'mainnet_updates' },
        { name: 'P2_cache_traces', table: 'cache_traces' },
        { name: 'P3_pending_shreds', table: 'pending_shreds' },
        { name: 'P4_confirmed_txs', table: 'mainnet_txs' },
        { name: 'P5_topology_events', table: 'topology_events' },
        { name: 'P6_frozen_topologies', table: 'frozen_topologies' },
        { name: 'bootstrap_updates', table: 'bootstrap_updates' },
        { name: 'stream_events', table: 'stream_events' },
    ];

    for (const { name, table } of tables) {
        const row = db.prepare(`
            SELECT COUNT(*) as count
            FROM ${table}
            WHERE session_id = ?
        `).get(sessionId) as { count: number };
        counts[name] = row.count;
    }

    return counts;
}

function getTopologyMetrics(db: Database.Database, sessionId: string): any {
    // Event type distribution
    const events = db.prepare(`
        SELECT event_type, new_state, COUNT(*) as count
        FROM topology_events
        WHERE session_id = ?
        GROUP BY event_type, new_state
        ORDER BY count DESC
    `).all(sessionId);

    // Block reasons
    const blockReasons = db.prepare(`
        SELECT reason, COUNT(*) as count
        FROM topology_events
        WHERE session_id = ? AND event_type = 'incomplete'
        GROUP BY reason
        ORDER BY count DESC
    `).all(sessionId);

    // Unique pools
    const uniquePools = db.prepare(`
        SELECT COUNT(DISTINCT pool_pubkey) as count
        FROM frozen_topologies
        WHERE session_id = ?
    `).get(sessionId) as { count: number };

    const activatedPools = db.prepare(`
        SELECT COUNT(DISTINCT pool_pubkey) as count
        FROM topology_events
        WHERE session_id = ? AND event_type = 'activate' AND new_state = 'ACTIVE'
    `).get(sessionId) as { count: number };

    return {
        unique_pools_frozen: uniquePools.count,
        unique_pools_activated: activatedPools.count,
        activation_rate: uniquePools.count > 0
            ? (activatedPools.count / uniquePools.count * 100).toFixed(1) + '%'
            : 'N/A',
        event_distribution: events,
        block_reasons: blockReasons,
    };
}

function getParityMetrics(db: Database.Database, sessionId: string, parityGapCount: number): any {
    // P1 unique pubkeys (mainnet truth)
    const p1Unique = db.prepare(`
        SELECT COUNT(DISTINCT pubkey) as count
        FROM mainnet_updates
        WHERE session_id = ?
    `).get(sessionId) as { count: number };

    // P2 unique pubkeys (cache tracked)
    const p2Unique = db.prepare(`
        SELECT COUNT(DISTINCT pubkey) as count
        FROM cache_traces
        WHERE session_id = ?
    `).get(sessionId) as { count: number };

    // Cache type breakdown
    const cacheTypes = db.prepare(`
        SELECT cache_type, COUNT(*) as traces, COUNT(DISTINCT pubkey) as unique_keys
        FROM cache_traces
        WHERE session_id = ?
        GROUP BY cache_type
        ORDER BY traces DESC
    `).all(sessionId);

    // parityGapCount is precomputed and passed in to avoid running the expensive query twice

    const parityPercent = p1Unique.count > 0
        ? ((p1Unique.count - parityGapCount) / p1Unique.count * 100).toFixed(1)
        : '0';

    return {
        p1_unique_pubkeys: p1Unique.count,
        p2_unique_pubkeys: p2Unique.count,
        parity_gap_count: parityGapCount,
        parity_percent: parityPercent + '%',
        gap_percent: (100 - parseFloat(parityPercent)).toFixed(1) + '%',
        cache_type_breakdown: cacheTypes,
        // CRITICAL: For swap simulation, we need 100% parity on tracked pools
        swap_sim_ready: parityGapCount === 0,
    };
}

function getLatencyMetrics(db: Database.Database, sessionId: string): any {
    // P1 → P2 latency (ingest to cache apply)
    // Must match on write_version to get 1:1 pairing (not cross-product)
    // Include timing relative to session start to separate warmup from steady-state
    const latencySample = db.prepare(`
        SELECT
            c.apply_ts - m.ingest_ts as latency_ms,
            m.ingest_ts - (SELECT MIN(ingest_ts) FROM mainnet_updates WHERE session_id = ?) as ms_since_start
        FROM cache_traces c
        JOIN mainnet_updates m
            ON c.pubkey = m.pubkey
            AND c.slot = m.slot
            AND c.write_version = m.write_version
            AND c.session_id = m.session_id
        WHERE c.session_id = ?
          AND c.apply_ts >= m.ingest_ts
        LIMIT 50000
    `).all(sessionId, sessionId) as { latency_ms: number; ms_since_start: number }[];

    if (latencySample.length === 0) {
        return { sample_size: 0, message: 'No matching P1→P2 pairs found' };
    }

    const allLatencies = latencySample.map(r => r.latency_ms).filter(l => l >= 0).sort((a, b) => a - b);

    if (allLatencies.length === 0) {
        return { sample_size: latencySample.length, message: 'All latencies negative (clock skew?)' };
    }

    // Separate warmup (first 5s) from steady-state
    const warmupMs = 5000;
    const warmupLatencies = latencySample
        .filter(r => r.ms_since_start < warmupMs && r.latency_ms >= 0)
        .map(r => r.latency_ms)
        .sort((a, b) => a - b);
    const steadyLatencies = latencySample
        .filter(r => r.ms_since_start >= warmupMs && r.latency_ms >= 0)
        .map(r => r.latency_ms)
        .sort((a, b) => a - b);

    const computeStats = (label: string, latencies: number[]) => {
        if (latencies.length === 0) return `${label}: no samples`;
        const p50 = latencies[Math.floor(latencies.length * 0.5)];
        const p95 = latencies[Math.floor(latencies.length * 0.95)];
        const p99 = latencies[Math.floor(latencies.length * 0.99)];
        const min = latencies[0];
        const max = latencies[latencies.length - 1];
        const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
        return `${label} (n=${latencies.length}): min=${min}ms, avg=${avg.toFixed(2)}ms, p50=${p50}ms, p95=${p95}ms, p99=${p99}ms, max=${max}ms`;
    };

    return {
        grpc_to_cache_latency: {
            all: computeStats('all', allLatencies),
            warmup_0_to_5s: computeStats('warmup', warmupLatencies),
            steady_state_5s_plus: computeStats('steady', steadyLatencies),
        },
    };
}

function getCriticalPath(db: Database.Database, sessionId: string, parityGapCount: number): any {
    // What's blocking 100% parity for swap simulation?
    const issues: string[] = [];
    const metrics: any = {};

    // 1. Check virtual array blocks
    const virtualBlocks = db.prepare(`
        SELECT COUNT(*) as count
        FROM topology_events
        WHERE session_id = ? AND reason LIKE '%virtual%'
    `).get(sessionId) as { count: number };

    if (virtualBlocks.count > 0) {
        issues.push(`${virtualBlocks.count} pools blocked due to virtual arrays (no real liquidity data)`);
        metrics.virtual_array_blocks = virtualBlocks.count;
    }

    // 2. Check parity gap (precomputed value passed in)
    if (parityGapCount > 0) {
        issues.push(`${parityGapCount} pubkeys in mainnet not tracked in cache`);
        metrics.untracked_pubkeys = parityGapCount;
    }

    // 3. Check stream continuity
    const streamGaps = db.prepare(`
        SELECT COUNT(*) as count
        FROM stream_events
        WHERE session_id = ? AND event_type IN ('disconnect', 'error')
    `).get(sessionId) as { count: number };

    if (streamGaps.count > 0) {
        issues.push(`${streamGaps.count} stream disconnects/errors (potential data loss)`);
        metrics.stream_disruptions = streamGaps.count;
    }

    // 4. Check activation rate
    const frozen = db.prepare(`
        SELECT COUNT(DISTINCT pool_pubkey) as count
        FROM frozen_topologies WHERE session_id = ?
    `).get(sessionId) as { count: number };

    const activated = db.prepare(`
        SELECT COUNT(DISTINCT pool_pubkey) as count
        FROM topology_events
        WHERE session_id = ? AND event_type = 'activate' AND new_state = 'ACTIVE'
    `).get(sessionId) as { count: number };

    const notActivated = frozen.count - activated.count;
    if (notActivated > 0) {
        issues.push(`${notActivated} pools frozen but not activated`);
        metrics.pools_not_activated = notActivated;
    }

    // Summary
    const ready = issues.length === 0;

    return {
        swap_simulation_ready: ready,
        blocking_issues: issues,
        metrics,
        next_action: ready
            ? 'Parity achieved. Ready for swap simulation validation.'
            : issues[0]?.includes('virtual')
                ? 'Fix tick array fetching - ensure bitmap-based discovery returns real liquidity data'
                : issues[0]?.includes('untracked')
                    ? 'Expand cache subscription to cover all DEX-related accounts'
                    : 'Investigate stream continuity - ensure no data loss during capture',
    };
}

main();
