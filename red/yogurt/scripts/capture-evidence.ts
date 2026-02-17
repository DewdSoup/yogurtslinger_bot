#!/usr/bin/env tsx
/**
 * Evidence Capture Script v2.3 — Trace-Based Capture
 *
 * FIX 5 DEMARCATION: Planes are categorized by purpose:
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ REPLAY PROOF PLANES (Canonical — feed ReplayProofRunner)               │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ PLANE 1 — Mainnet Account State (gRPC)                                 │
 * │   - Raw account updates with ingest_ts                                 │
 * │   - Full data for state reconstruction                                 │
 * │   - PURPOSE: Pre-state for replay proof                                │
 * │                                                                        │
 * │ PLANE 2 — Cache Application Trace (Hooks)                              │
 * │   - Each cache.set() logged with apply_ts                              │
 * │   - Links to originating Plane 1 update                                │
 * │   - PURPOSE: Verify cache determinism (P1 → P2 is reproducible)        │
 * │                                                                        │
 * │ PLANE 4 — Confirmed Transactions (gRPC)                                │
 * │   - Confirmed txs with confirm_ts                                      │
 * │   - Pre/post balances for simulation validation                        │
 * │   - PURPOSE: Ground truth for replay comparison                        │
 * │                                                                        │
 * │ PLANE 7 — Parsed Swap Transactions (Derived from P4)                   │
 * │   - Decoded swap legs with venue, pool, amounts                        │
 * │   - Actual output calculated from balance deltas                       │
 * │   - Transaction fees captured                                          │
 * │   - PURPOSE: Quoter verification (expected vs actual output)           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ANALYTICS PLANE (Speculative — optional, not for correctness proof)    │
 * ├─────────────────────────────────────────────────────────────────────────┤
 * │ PLANE 3 — Pending Transactions (ShredStream)                           │
 * │   - Pending shreds with receive_ts                                     │
 * │   - NEVER modifies cache state                                         │
 * │   - PURPOSE: Latency analysis, speculation tracking (not proof)        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * REPLAY PROOF CONTRACT:
 *   - ReplayProofRunner consumes P1 + P4 to prove determinism
 *   - P2 validates cache behavior but is derivable from P1
 *   - P3 is analytics only — never gates correctness
 *
 * Usage:
 *   pnpm exec tsx scripts/capture-evidence.ts [duration_seconds]
 *   Default: run indefinitely (0 = no limit)
 */

import { loadPackageDefinition, credentials } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { createHash, randomUUID } from 'crypto';
import { createGrpcConsumer, type StreamContinuityEvent } from '../src/ingest/grpc.js';
import { createShredStreamConsumer } from '../src/ingest/shred.js';
import { createPhase3Handler } from '../src/handler/phase3.js';
import { commitAccountUpdate } from '../src/cache/commit.js';
import { decodePumpSwapGlobalConfig, PUMPSWAP_GLOBAL_CONFIG_PUBKEY } from '../src/decode/programs/pumpswap.js';
import { setBootstrapHandler, type BootstrapEvent } from '../src/topology/index.js';
import type { IngestEvent, AccountUpdate, TxUpdate, PoolState, RaydiumClmmPool, MeteoraDlmmPool } from '../src/types.js';
import { VenueId } from '../src/types.js';
import type { CacheTraceEvent } from '../src/cache/types.js';
import type { LifecycleEvent } from '../src/cache/lifecycle.js';
import { extractSwapLegs, hasSwapInstructions } from '../src/decode/swap.js';
import type { CompiledInstruction, SwapLeg } from '../src/types.js';
import { mkdirSync, readFileSync, existsSync, unlinkSync, openSync, closeSync, writeSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// CONFIG
// ============================================================================

const GRPC_ENDPOINT = process.env.GRPC_ENDPOINT ?? '127.0.0.1:10000';
const SHRED_ENDPOINT = process.env.SHRED_ENDPOINT ?? '127.0.0.1:11000';
const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';
const CAPTURE_SECONDS = parseInt(process.argv[2] ?? '0', 10);

// Control-plane logs (connection, subscription) silenced unless DEBUG=1
// Only heartbeat and errors shown by default
const DEBUG = process.env.DEBUG === '1';

// PumpSwap GlobalConfig PDA (imported from pumpswap.ts)
import bs58 from 'bs58';
const PUMPSWAP_GLOBAL_CONFIG = bs58.encode(PUMPSWAP_GLOBAL_CONFIG_PUBKEY);

// Load program IDs for filtering
const programsPath = join(__dirname, '..', 'data', 'programs.json');
const programs = JSON.parse(readFileSync(programsPath, 'utf8'));

// Program lists:
// - programIds: All programs (used for decoding)
// - subscriptionProgramIds: DEX programs only (used for gRPC/TX subscriptions)
//
// SPL Token excluded from subscriptions because it owns all token accounts.
// Vaults are subscribed individually via grpcConsumer.subscribeVaults()
const programIds = Object.values(programs) as string[];
const subscriptionProgramIds = Object.entries(programs)
    .filter(([key]) => key !== 'splToken')
    .map(([, value]) => value as string);

// Output paths
const EVIDENCE_DIR = join(__dirname, '..', 'data', 'evidence');
const SQLITE_FILE = join(EVIDENCE_DIR, 'capture.db');
const LOCK_FILE = join(EVIDENCE_DIR, 'capture.lock');
const RUN_VALIDATION = process.env.RUN_VALIDATION === '1';  // default skip; opt-in with RUN_VALIDATION=1

// ============================================================================
// HANG DIAGNOSTICS CONFIG
// ============================================================================

// External heartbeat file for forensic analysis when process hangs
const HEARTBEAT_FILE = join(EVIDENCE_DIR, 'heartbeat.json');
const HEARTBEAT_INTERVAL_MS = 2000;  // Write heartbeat every 2s

// Stall detection thresholds
const EVENT_LOOP_LAG_WARN_MS = 500;   // Warn if event loop lags > 500ms
const EVENT_LOOP_LAG_FATAL_MS = 5000; // Fatal if event loop lags > 5s
const INTERVAL_SKIP_WARN_MS = 8000;   // Warn if progress interval skips (expected 5s)

// ============================================================================
// CANARY TIMER - Detects exactly when event loop blocks
// ============================================================================

interface CanaryState {
    lastTickAt: number;
    lastTickExpectedAt: number;
    maxDelayMs: number;
    blockEvents: Array<{ at: number; delayMs: number; lastOp: string }>;
}

const canaryState: CanaryState = {
    lastTickAt: 0,
    lastTickExpectedAt: 0,
    maxDelayMs: 0,
    blockEvents: [],
};

const CANARY_INTERVAL_MS = 500;  // Expected to fire every 500ms
const CANARY_BLOCK_THRESHOLD_MS = 1000;  // Report if delayed by > 1s

function startCanary(): NodeJS.Timeout {
    canaryState.lastTickAt = Date.now();
    canaryState.lastTickExpectedAt = Date.now() + CANARY_INTERVAL_MS;

    return setInterval(() => {
        const now = Date.now();
        const expectedAt = canaryState.lastTickExpectedAt;
        const delayMs = now - expectedAt;

        if (delayMs > CANARY_BLOCK_THRESHOLD_MS) {
            // Event loop was blocked!
            const blockEvent = {
                at: now,
                delayMs,
                lastOp: heartbeatData.lastOp,
            };
            canaryState.blockEvents.push(blockEvent);

            // Keep only last 20 block events
            if (canaryState.blockEvents.length > 20) {
                canaryState.blockEvents.shift();
            }

            console.error(`[CANARY] Event loop blocked for ${delayMs}ms! lastOp=${heartbeatData.lastOp} lastOpTs=${heartbeatData.lastOpTs}`);

            // Write block event to file immediately (sync - we're already blocked)
            try {
                const blockFile = join(EVIDENCE_DIR, `block-event-${now}.json`);
                writeFileSync(blockFile, JSON.stringify({
                    ...blockEvent,
                    heartbeat: { ...heartbeatData },
                    memory: process.memoryUsage(),
                }, null, 2));
            } catch {
                // ignore
            }
        }

        if (delayMs > canaryState.maxDelayMs) {
            canaryState.maxDelayMs = delayMs;
        }

        canaryState.lastTickAt = now;
        canaryState.lastTickExpectedAt = now + CANARY_INTERVAL_MS;
    }, CANARY_INTERVAL_MS);
}

// ============================================================================
// CPU WATCHDOG - Catches pure CPU spins (BigInt, O(n²), decode bombs)
// ============================================================================

const CPU_WATCHDOG_INTERVAL_MS = 5000;
const CPU_SPIN_THRESHOLD_MS = 4000;  // >4s CPU in 5s window = likely spin

let cpuWatchdogInterval: NodeJS.Timeout | null = null;
let lastCpuSample = process.cpuUsage();
let cpuSpinDetected = false;  // Latch to avoid duplicate diagnostics during prolonged spin

function startCpuWatchdog(): NodeJS.Timeout {
    lastCpuSample = process.cpuUsage();
    cpuSpinDetected = false;

    return setInterval(() => {
        const u = process.cpuUsage(lastCpuSample);
        lastCpuSample = process.cpuUsage();
        const cpuMs = (u.user + u.system) / 1000;

        if (!cpuSpinDetected && cpuMs > CPU_SPIN_THRESHOLD_MS) {
            cpuSpinDetected = true;
            console.error(`[CPU-WATCHDOG] ${cpuMs.toFixed(0)}ms CPU in ${CPU_WATCHDOG_INTERVAL_MS / 1000}s window - possible spin!`);
            console.error(`[CPU-WATCHDOG] user=${(u.user / 1000).toFixed(0)}ms sys=${(u.system / 1000).toFixed(0)}ms`);
            console.error(`[CPU-WATCHDOG] lastOp=${heartbeatData.lastOp} lastPubkey=${heartbeatData.lastPubkey}`);
            writeHangDiagnostic('cpu_spin');
            writeNodeReport('cpu_spin');
        }
    }, CPU_WATCHDOG_INTERVAL_MS);
}

function stopCpuWatchdog(): void {
    if (cpuWatchdogInterval) {
        clearInterval(cpuWatchdogInterval);
        cpuWatchdogInterval = null;
    }
}

// RPC timeout (prevents indefinite hangs)
const RPC_TIMEOUT_MS = 10000;  // 10s timeout for all RPC calls

// ============================================================================
// HEARTBEAT & DIAGNOSTICS
// ============================================================================

interface HeartbeatData {
    ts: number;
    elapsed: number;
    phase: string;
    lastProgressAt: number;
    lastP1At: number;
    p1Count: number;
    p2Count: number;
    p3Count: number;
    p4Count: number;
    writeQueueSize: number;
    eventLoopLagMs: number;
    rssBytes: number;
    activeRpcCalls: number;
    lastSlot: number;
    // DIAGNOSTIC: Track last operations for hang analysis
    lastOp: string;
    lastOpTs: number;
    lastPubkey: string;
    // DIAGNOSTIC: Flush stats for hang analysis
    lastFlushDurationMs: number;
    maxFlushDurationMs: number;
    flushCount: number;
    // DIAGNOSTIC: gRPC stream health
    grpcLastDataAt: number;
    grpcStaleMs: number;
    // DIAGNOSTIC: gRPC entry point tracking (for hang localization)
    grpcEntryTs: number;
    grpcEntrySlot: number;
    grpcEntryCount: number;
    grpcEntryStaleness: number;
}

let heartbeatData: HeartbeatData = {
    ts: 0,
    elapsed: 0,
    phase: 'init',
    lastProgressAt: 0,
    lastP1At: 0,
    p1Count: 0,
    p2Count: 0,
    p3Count: 0,
    p4Count: 0,
    writeQueueSize: 0,
    eventLoopLagMs: 0,
    rssBytes: 0,
    activeRpcCalls: 0,
    lastSlot: 0,
    lastOp: 'init',
    lastOpTs: 0,
    lastPubkey: '',
    lastFlushDurationMs: 0,
    maxFlushDurationMs: 0,
    flushCount: 0,
    grpcLastDataAt: 0,
    grpcStaleMs: 0,
    grpcEntryTs: 0,
    grpcEntrySlot: 0,
    grpcEntryCount: 0,
    grpcEntryStaleness: 0,
};

// Atomic snapshot of last event before handler call - survives hang
let lastEventSnapshot: {
    ts: number;
    eventType: string;
    pubkey: string;
    owner: string;
    slot: number;
    writeVersion: string;
    dataLength: number;
} | null = null;

/**
 * Write heartbeat to external file for forensic analysis.
 * This is the ONLY way to know what happened if the process hangs completely.
 *
 * IMPORTANT: Uses async write to avoid blocking event loop on filesystem stalls.
 */
let heartbeatWritePending = false;
function writeHeartbeat(): void {
    // Skip if a write is already pending (avoid queueing)
    if (heartbeatWritePending) return;

    heartbeatWritePending = true;
    const content = JSON.stringify(heartbeatData, null, 2);

    // Use async write to avoid blocking event loop
    import('fs/promises').then(({ writeFile, mkdir }) => {
        mkdir(EVIDENCE_DIR, { recursive: true })
            .then(() => writeFile(HEARTBEAT_FILE, content))
            .catch(() => { /* ignore */ })
            .finally(() => { heartbeatWritePending = false; });
    }).catch(() => {
        heartbeatWritePending = false;
    });
}

/**
 * Update heartbeat data (called from various places)
 */
function updateHeartbeat(updates: Partial<HeartbeatData>): void {
    heartbeatData = { ...heartbeatData, ...updates, ts: Date.now() };
}

/**
 * Track operation for hang diagnosis (call before expensive operations)
 */
function trackOp(op: string, pubkey?: Uint8Array | string): void {
    const pubkeyStr = pubkey
        ? (typeof pubkey === 'string' ? pubkey : pubkey.slice(0, 8).reduce((s, b) => s + b.toString(16).padStart(2, '0'), ''))
        : '';
    heartbeatData.lastOp = op;
    heartbeatData.lastOpTs = Date.now();
    heartbeatData.lastPubkey = pubkeyStr;
}

/**
 * Fetch with timeout to prevent indefinite hangs
 */
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number = RPC_TIMEOUT_MS): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ============================================================================
// WORKER THREAD WATCHDOG
// ============================================================================

// Watchdog runs in a separate thread and can detect when main thread is hung
// It monitors a shared heartbeat timestamp via SharedArrayBuffer

let watchdogWorker: Worker | null = null;
let sharedHeartbeat: Int32Array | null = null;

/**
 * Start watchdog worker thread.
 * Worker monitors shared memory timestamp and logs if main thread stops updating.
 */
function startWatchdogWorker(): void {
    try {
        // SharedArrayBuffer for lock-free communication
        const sharedBuffer = new SharedArrayBuffer(8);  // 2 x Int32 for timestamp
        sharedHeartbeat = new Int32Array(sharedBuffer);

        // Worker code as string (inline to avoid separate file)
        const workerCode = `
            const { parentPort, workerData } = require('worker_threads');
            const fs = require('fs');

            const sharedHeartbeat = new Int32Array(workerData.sharedBuffer);
            const heartbeatFile = workerData.heartbeatFile;
            const STALL_THRESHOLD_MS = 10000;  // 10s without heartbeat update = stall

            let lastSeenTimestamp = 0;
            let lastSeenAt = Date.now();

            setInterval(() => {
                const currentTimestamp = Atomics.load(sharedHeartbeat, 0);

                if (currentTimestamp !== lastSeenTimestamp) {
                    // Main thread is alive, update tracking
                    lastSeenTimestamp = currentTimestamp;
                    lastSeenAt = Date.now();
                } else {
                    // Main thread hasn't updated heartbeat
                    const stallDuration = Date.now() - lastSeenAt;
                    if (stallDuration > STALL_THRESHOLD_MS) {
                        const msg = '[WATCHDOG] MAIN THREAD STALLED for ' + (stallDuration / 1000).toFixed(1) + 's!';
                        console.error(msg);

                        // Write stall info to heartbeat file
                        try {
                            const stallInfo = {
                                stall_detected: true,
                                stall_duration_ms: stallDuration,
                                last_heartbeat_ts: lastSeenTimestamp,
                                detected_at: new Date().toISOString(),
                            };
                            fs.writeFileSync(heartbeatFile + '.stall', JSON.stringify(stallInfo, null, 2));
                        } catch (e) {
                            // ignore
                        }

                        // Send kill signal to main process to get a core dump or stack trace
                        parentPort.postMessage({ type: 'stall', duration: stallDuration });
                    }
                }
            }, 2000);
        `;

        watchdogWorker = new Worker(workerCode, {
            eval: true,
            workerData: {
                sharedBuffer,
                heartbeatFile: HEARTBEAT_FILE,
            },
        });

        watchdogWorker.on('message', (msg: any) => {
            if (msg.type === 'stall') {
                console.error(`[WATCHDOG] Stall detected (${msg.duration}ms)`);

                // Force JS stack trace from main thread by signaling ourselves
                // SIGUSR2 is handled synchronously on the main thread, so we get the actual stuck stack
                try {
                    console.error('[WATCHDOG] Forcing main thread stack trace via SIGUSR2...');
                    process.kill(process.pid, 'SIGUSR2');
                } catch (e) {
                    console.error('[WATCHDOG] Failed to signal self:', e);
                    // Fallback: write diagnostic from here (but stack won't be useful)
                    writeHangDiagnostic('watchdog_stall_fallback');
                    writeNodeReport('watchdog_stall_fallback');
                }
            }
        });

        watchdogWorker.on('error', (err) => {
            console.error('[WATCHDOG] Worker error:', err);
        });

        console.log('[watchdog] Worker thread started for hang detection');
    } catch (err: any) {
        console.error('[watchdog] Failed to start worker:', err?.message ?? err);
    }
}

/**
 * Update watchdog heartbeat (call this frequently from main thread)
 */
function tickWatchdog(): void {
    if (sharedHeartbeat) {
        // Store low 32 bits of timestamp (wraps every ~50 days, good enough)
        Atomics.store(sharedHeartbeat, 0, Date.now() & 0x7FFFFFFF);
    }
}

/**
 * Stop watchdog worker
 */
function stopWatchdogWorker(): void {
    if (watchdogWorker) {
        watchdogWorker.terminate();
        watchdogWorker = null;
    }
}

function writeNodeReport(label: string): void {
    try {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const reportPath = join(EVIDENCE_DIR, `node-report-${Date.now()}-${label}.json`);
        process.report.writeReport(reportPath);
        console.error(`[diag] Wrote node report: ${reportPath}`);
    } catch (err: any) {
        console.error(`[diag] Failed to write node report (${label}): ${err?.message ?? err}`);
    }
}

/**
 * Comprehensive hang diagnostic dump.
 * Captures everything we can about the process state for post-mortem analysis.
 */
function writeHangDiagnostic(label: string): void {
    const diagPath = join(EVIDENCE_DIR, `hang-diagnostic-${Date.now()}-${label}.json`);
    const diagnostic: Record<string, any> = {
        timestamp: new Date().toISOString(),
        label,
        pid: process.pid,
        uptime: process.uptime(),
        heartbeat: { ...heartbeatData },
        lastEventSnapshot,  // The exact event that was being processed when hang occurred
        canary: { ...canaryState },  // Block event history
        memory: process.memoryUsage(),
        cpuUsage: process.cpuUsage(),
        resourceUsage: process.resourceUsage?.() ?? null,
    };

    // Active handles (sockets, timers, etc)
    try {
        const handles = (process as any)._getActiveHandles?.() ?? [];
        const handleSummary: Record<string, number> = {};
        const handleDetails: Array<{ type: string; info: string }> = [];

        for (const h of handles) {
            const type = h?.constructor?.name ?? 'unknown';
            handleSummary[type] = (handleSummary[type] ?? 0) + 1;

            // Extract useful info from handles
            let info = '';
            if (h?._host) info = `host=${h._host}`;
            if (h?.address) info = `addr=${JSON.stringify(h.address())}`;
            if (h?._idleTimeout) info = `timeout=${h._idleTimeout}`;
            if (h?.fd !== undefined) info = `fd=${h.fd}`;

            if (handleDetails.length < 50) {  // Limit to avoid huge dumps
                handleDetails.push({ type, info });
            }
        }

        diagnostic.handles = {
            count: handles.length,
            summary: handleSummary,
            details: handleDetails,
        };
    } catch (err: any) {
        diagnostic.handles = { error: err?.message ?? String(err) };
    }

    // Active requests (pending async operations)
    try {
        const requests = (process as any)._getActiveRequests?.() ?? [];
        const requestSummary: Record<string, number> = {};

        for (const r of requests) {
            const type = r?.constructor?.name ?? 'unknown';
            requestSummary[type] = (requestSummary[type] ?? 0) + 1;
        }

        diagnostic.requests = {
            count: requests.length,
            summary: requestSummary,
        };
    } catch (err: any) {
        diagnostic.requests = { error: err?.message ?? String(err) };
    }

    // Linux-specific: kernel stack trace
    try {
        const stackPath = `/proc/${process.pid}/stack`;
        if (existsSync(stackPath)) {
            diagnostic.kernelStack = readFileSync(stackPath, 'utf8');
        }
    } catch {
        // Not available or permission denied
    }

    // Linux-specific: file descriptors
    try {
        const fdPath = `/proc/${process.pid}/fd`;
        if (existsSync(fdPath)) {
            const { readdirSync, readlinkSync } = require('fs');
            const fds = readdirSync(fdPath);
            const fdDetails: Array<{ fd: string; target: string }> = [];
            for (const fd of fds.slice(0, 100)) {  // Limit
                try {
                    const target = readlinkSync(join(fdPath, fd));
                    fdDetails.push({ fd, target });
                } catch {
                    fdDetails.push({ fd, target: '?' });
                }
            }
            diagnostic.fileDescriptors = {
                count: fds.length,
                details: fdDetails,
            };
        }
    } catch {
        // Not available
    }

    // Linux-specific: IO stats
    try {
        const ioPath = `/proc/${process.pid}/io`;
        if (existsSync(ioPath)) {
            diagnostic.ioStats = readFileSync(ioPath, 'utf8');
        }
    } catch {
        // Not available
    }

    // Environment hints
    diagnostic.env = {
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        GRPC_ENDPOINT: process.env.GRPC_ENDPOINT,
        RPC_ENDPOINT: process.env.RPC_ENDPOINT,
    };

    try {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        writeFileSync(diagPath, JSON.stringify(diagnostic, null, 2));
        console.error(`[diag] Wrote hang diagnostic: ${diagPath}`);
    } catch (err: any) {
        console.error(`[diag] Failed to write hang diagnostic: ${err?.message ?? err}`);
    }
}

// Best-effort diagnostics on termination signals and fatal errors
process.on('SIGINT', () => {
    console.error('[diag] SIGINT received; writing comprehensive diagnostics then exiting');
    console.error('[diag] TIP: Send SIGUSR1 first to dump diagnostics without killing');
    writeHangDiagnostic('sigint');
    writeNodeReport('sigint');
    // Also write final heartbeat
    heartbeatData.phase = 'sigint_exit';
    heartbeatData.ts = Date.now();
    writeHeartbeat();
    process.exit(1);
});

process.on('SIGTERM', () => {
    console.error('[diag] SIGTERM received; writing comprehensive diagnostics then exiting');
    writeHangDiagnostic('sigterm');
    writeNodeReport('sigterm');
    process.exit(1);
});

// SIGUSR1: Non-destructive diagnostic dump (use when hung, before Ctrl+C)
process.on('SIGUSR1', () => {
    console.error('[diag] SIGUSR1 received; writing comprehensive hang diagnostic (process continues)');
    console.error('[diag] Check data/evidence/hang-diagnostic-*.json for details');
    writeHangDiagnostic('sigusr1');
    writeNodeReport('sigusr1');
});

// SIGUSR2: Stack dump + diagnostics (triggered by watchdog on stall, or manually)
// This runs synchronously on main thread, so Error.stack shows where we're actually stuck
process.on('SIGUSR2', () => {
    console.error('[diag] SIGUSR2 received; dumping JS stacks');

    // JS stack - this is the critical piece that shows where execution is stuck
    console.error('[diag] === JS STACK TRACE ===');
    console.error(new Error('SIGUSR2 STACK').stack);

    // Full node report (includes native frames and libuv state)
    writeNodeReport('sigusr2_stack');

    // Comprehensive hang diagnostic snapshot
    writeHangDiagnostic('sigusr2');
});

process.on('uncaughtException', (err) => {
    console.error('[diag] uncaughtException:', err);
    writeHangDiagnostic('uncaughtException');
    writeNodeReport('uncaughtException');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('[diag] unhandledRejection:', reason);
    writeHangDiagnostic('unhandledRejection');
    writeNodeReport('unhandledRejection');
    process.exit(1);
});

// Proto paths
const PROTO_DIR = join(__dirname, '..', 'src', 'capture', 'proto');
const GEYSER_PROTO = join(PROTO_DIR, 'geyser.proto');

const PROTO_LOADER_OPTS = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
    includeDirs: [PROTO_DIR],
};

// ============================================================================
// HELPERS
// ============================================================================

// Simple single-run lock to prevent two captures writing the same SQLite file
let lockFd: number | null = null;

function acquireLock(sessionId: string): void {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    // If lock exists but owning pid is dead, remove it
    if (existsSync(LOCK_FILE)) {
        try {
            const content = readFileSync(LOCK_FILE, 'utf8');
            const pidMatch = content.match(/pid=(\d+)/);
            const pid = pidMatch ? parseInt(pidMatch[1]!, 10) : NaN;
            const hasPid = !Number.isNaN(pid);
            if (!hasPid || !isProcessAlive(pid)) {
                // Stale lock (missing pid or dead pid)
                unlinkSync(LOCK_FILE);
            }
        } catch {
            // best-effort cleanup
            try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
        }
    }
    try {
        lockFd = openSync(LOCK_FILE, 'wx');
        // Stash session id in lock for debugging
        fsWrite(lockFd, `session=${sessionId}\nstarted=${new Date().toISOString()}\npid=${process.pid}\n`);
    } catch (err: any) {
        if (err?.code === 'EEXIST') {
            throw new Error(`Another capture is already running (lock file ${LOCK_FILE} exists)`);
        }
        throw err;
    }
}

function releaseLock(): void {
    try {
        if (lockFd !== null) {
            closeSync(lockFd);
            lockFd = null;
        }
        if (existsSync(LOCK_FILE)) {
            unlinkSync(LOCK_FILE);
        }
    } catch {
        // Best-effort cleanup
    }
}

function fsWrite(fd: number, content: string): void {
    try {
        writeSync(fd, content);
    } catch {
        // ignore
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        return err?.code !== 'ESRCH' ? true : false;
    }
}

function toHex(bytes: Uint8Array): string {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return hex;
}

function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function toUint8Array(data: any): Uint8Array {
    if (data instanceof Uint8Array) return data;
    if (Buffer.isBuffer(data)) return new Uint8Array(data);
    if (typeof data === 'string') return new Uint8Array(Buffer.from(data, 'base64'));
    if (Array.isArray(data)) return new Uint8Array(data);
    return new Uint8Array(0);
}

function computeScriptHash(): string {
    const content = readFileSync(__filename, 'utf8');
    return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ============================================================================
// SQLITE SCHEMA
// ============================================================================

// better-sqlite3 writes directly to disk — no in-memory accumulation.
// This prevents the 2GB Buffer limit crash and enables multi-day capture.
function initDatabase(): Database.Database {
    mkdirSync(EVIDENCE_DIR, { recursive: true });

    // Delete old database to start fresh (avoids bloat across runs)
    if (existsSync(SQLITE_FILE)) {
        unlinkSync(SQLITE_FILE);
    }

    const db = new Database(SQLITE_FILE);

    // WAL mode for concurrent reads and better write performance
    db.pragma('journal_mode = WAL');
    // Relax sync to avoid main-thread stalls on every insert fsync
    db.pragma('synchronous = NORMAL');
    // Keep WAL checkpoints rare to avoid long pauses; manual close will flush
    db.pragma('wal_autocheckpoint = 10000');
    // Keep temp data in memory to reduce disk churn
    db.pragma('temp_store = MEMORY');
    // Backoff on brief contentions (robustness for any concurrent access)
    db.pragma('busy_timeout = 5000');

    // =========================================================================
    // SESSION METADATA
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS capture_sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER,
        ended_at INTEGER,
        script_name TEXT,
        script_version TEXT,
        script_hash TEXT,
        grpc_endpoint TEXT,
        shred_endpoint TEXT,
        warmup_seconds INTEGER,
        duration_seconds INTEGER,
        stats_json TEXT,
        grpc_subscription_start_slot INTEGER
    )`);

    // Phase 4.1: Idempotent migration
    const sessionCols = db.prepare("PRAGMA table_info(capture_sessions)").all() as any[];
    if (!sessionCols.some(c => c.name === 'grpc_subscription_start_slot')) {
        db.exec("ALTER TABLE capture_sessions ADD COLUMN grpc_subscription_start_slot INTEGER");
    }

    // =========================================================================
    // REPLAY PROOF TABLES (P1, P2, P4)
    // =========================================================================

    // Plane 1 — Mainnet account updates
    db.exec(`CREATE TABLE IF NOT EXISTS mainnet_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ingest_ts INTEGER,
        slot INTEGER,
        write_version TEXT,
        pubkey TEXT,
        owner TEXT,
        data_b64 TEXT,
        lamports TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_updates_session ON mainnet_updates(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_updates_pubkey_slot ON mainnet_updates(pubkey, slot)`);

    // Plane 2 — Cache application traces
    db.exec(`CREATE TABLE IF NOT EXISTS cache_traces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        apply_ts INTEGER,
        cache_type TEXT,
        pubkey TEXT,
        slot INTEGER,
        write_version TEXT,
        cache_key TEXT,
        data_length INTEGER,
        source TEXT,
        rejected INTEGER DEFAULT 0,
        existing_slot INTEGER,
        evicted INTEGER DEFAULT 0,
        out_of_frozen_range INTEGER DEFAULT 0
    )`);

    // Phase 3.1 / 4.7: Idempotent migrations
    const traceCols = db.prepare("PRAGMA table_info(cache_traces)").all() as any[];

    if (!traceCols.some(c => c.name === 'evicted')) {
        db.exec("ALTER TABLE cache_traces ADD COLUMN evicted INTEGER DEFAULT 0");
    }
    if (!traceCols.some(c => c.name === 'out_of_frozen_range')) {
        db.exec("ALTER TABLE cache_traces ADD COLUMN out_of_frozen_range INTEGER DEFAULT 0");
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_session ON cache_traces(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_traces_pubkey_slot ON cache_traces(pubkey, slot)`);

    // =========================================================================
    // ANALYTICS TABLE (P3)
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS pending_shreds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        receive_ts INTEGER,
        slot INTEGER,
        signature TEXT,
        raw_message_b64 TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_shreds_session ON pending_shreds(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_shreds_sig ON pending_shreds(signature)`);

    // =========================================================================
    // REPLAY PROOF TABLE (P4)
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS mainnet_txs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        confirm_ts INTEGER,
        slot INTEGER,
        signature TEXT,
        accounts_json TEXT,
        pre_balances_json TEXT,
        post_balances_json TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_txs_session ON mainnet_txs(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_txs_sig ON mainnet_txs(signature)`);

    // =========================================================================
    // PARSED SWAP TABLE (P7) — For quoter verification
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS parsed_swaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        confirm_ts INTEGER,
        slot INTEGER,
        signature TEXT,
        venue TEXT,
        pool_pubkey TEXT,
        direction INTEGER,
        input_mint TEXT,
        output_mint TEXT,
        input_amount TEXT,
        min_output_amount TEXT,
        actual_output_amount TEXT,
        tx_fee_lamports TEXT,
        decode_success INTEGER DEFAULT 1,
        instruction_index INTEGER DEFAULT 0
    )`);

    // Migration: Add instruction_index column if missing
    try {
        db.exec("ALTER TABLE parsed_swaps ADD COLUMN instruction_index INTEGER DEFAULT 0");
    } catch {
        // Column already exists
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swaps_session ON parsed_swaps(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swaps_venue ON parsed_swaps(venue)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swaps_pool ON parsed_swaps(pool_pubkey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_swaps_slot ON parsed_swaps(slot)`);

    // =========================================================================
    // TOPOLOGY TABLES (P5, P6)
    // =========================================================================

    // Plane 5 — Topology lifecycle events
    db.exec(`CREATE TABLE IF NOT EXISTS topology_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_ts INTEGER,
        pool_pubkey TEXT,
        slot INTEGER,
        event_type TEXT,
        prev_state TEXT,
        new_state TEXT,
        reason TEXT,
        epoch INTEGER,
        details TEXT
    )`);

    try {
        db.exec("ALTER TABLE topology_events ADD COLUMN details TEXT");
    } catch {
        // already exists
    }

    db.exec(`CREATE INDEX IF NOT EXISTS idx_topo_events_session ON topology_events(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_topo_events_pool ON topology_events(pool_pubkey)`);

    // Plane 6 — Frozen topology snapshots
    db.exec(`CREATE TABLE IF NOT EXISTS frozen_topologies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        pool_pubkey TEXT,
        venue INTEGER,
        frozen_at_slot INTEGER,
        frozen_at_ms INTEGER,
        vault_base TEXT,
        vault_quote TEXT,
        required_tick_arrays TEXT,
        required_bin_arrays TEXT,
        amm_config_pubkey TEXT,
        epoch INTEGER,
        tick_range_min INTEGER,
        tick_range_max INTEGER,
        bin_range_min INTEGER,
        bin_range_max INTEGER
    )`);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_frozen_session ON frozen_topologies(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_frozen_pool ON frozen_topologies(pool_pubkey)`);

    // Phase 4.7: Idempotent migration for range columns
    const frozenCols = db.prepare("PRAGMA table_info(frozen_topologies)").all() as any[];

    if (!frozenCols.some(c => c.name === 'tick_range_min')) {
        db.exec("ALTER TABLE frozen_topologies ADD COLUMN tick_range_min INTEGER");
        db.exec("ALTER TABLE frozen_topologies ADD COLUMN tick_range_max INTEGER");
        db.exec("ALTER TABLE frozen_topologies ADD COLUMN bin_range_min INTEGER");
        db.exec("ALTER TABLE frozen_topologies ADD COLUMN bin_range_max INTEGER");
    }

    // =========================================================================
    // STREAM CONTINUITY TABLE (C1)
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS stream_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_ts INTEGER,
        stream_type TEXT,
        event_type TEXT,
        last_slot_seen INTEGER,
        error_message TEXT,
        reconnect_attempt INTEGER,
        rollback_depth INTEGER,
        rollback_from_slot INTEGER
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stream_events_session ON stream_events(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_stream_events_type ON stream_events(stream_type, event_type)`);

    // =========================================================================
    // SLOT CONSISTENCY TABLE
    // =========================================================================

    db.exec(`CREATE TABLE IF NOT EXISTS snapshot_slot_consistency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        build_ts INTEGER,
        pool_pubkey TEXT,
        pool_slot INTEGER,
        base_vault_slot INTEGER,
        quote_vault_slot INTEGER,
        min_tick_slot INTEGER,
        min_bin_slot INTEGER,
        slot_delta INTEGER,
        is_consistent INTEGER,
        build_success INTEGER
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_slot_consistency_session ON snapshot_slot_consistency(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_slot_consistency_pool ON snapshot_slot_consistency(pool_pubkey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_slot_consistency_delta ON snapshot_slot_consistency(slot_delta)`);

    // =========================================
    // BOOTSTRAP TABLE (B4.3)
    // =========================================

    // Bootstrap updates: RPC snapshot data that seeded the cache
    // - Full account metadata for deterministic replay
    // - owner: Real program owner pubkey (hex), NOT accountType
    // - lamports: Actual account lamports, NOT hardcoded '0'
    // - executable: Account executable flag
    // - rent_epoch: Rent epoch for deterministic replay
    // - account_type: Routing type ('tick', 'bin', 'vault', 'ammConfig')
    db.exec(`CREATE TABLE IF NOT EXISTS bootstrap_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        fetch_ts INTEGER,
        slot INTEGER,
        pubkey TEXT,
        owner TEXT,
        data_b64 TEXT,
        lamports TEXT,
        executable INTEGER,
        rent_epoch TEXT,
        pool_pubkey TEXT,
        account_type TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bootstrap_session ON bootstrap_updates(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bootstrap_pubkey ON bootstrap_updates(pubkey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bootstrap_pool ON bootstrap_updates(pool_pubkey)`);

    // =========================================
    // HEALTH SNAPSHOTS TABLE
    // =========================================

    // Stores periodic health snapshots during capture
    db.exec(`CREATE TABLE IF NOT EXISTS health_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        timestamp INTEGER,
        healthy INTEGER,
        orphan_buffer_size INTEGER,
        orphan_reclaim_rate REAL,
        orphan_ticks_claimed INTEGER,
        orphan_bins_claimed INTEGER,
        cache_healthy INTEGER
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_health_session ON health_snapshots(session_id)`);

    // =========================================
    // VALIDATION SUMMARY TABLE
    // =========================================

    // Stores validation results at end of capture for post-analysis
    db.exec(`CREATE TABLE IF NOT EXISTS validation_summary (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        created_at INTEGER,
        metric_name TEXT NOT NULL,
        metric_category TEXT,
        metric_value TEXT,
        metric_count INTEGER,
        metric_pct REAL,
        details TEXT
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_validation_session ON validation_summary(session_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_validation_metric ON validation_summary(metric_name)`);

    return db;
}

// ============================================================================
// STATS
// ============================================================================

interface CaptureStats {
    plane1_updates: number;
    plane2_traces: number;
    plane3_shreds: number;
    plane4_txs: number;
    plane5_topology: number;
    plane6_frozen: number;
    plane7_swaps: number;
    // L2-001: Track decode gaps to understand TRUE_COVERAGE
    plane7_notSwap: number;       // tx doesn't have swap instructions (legitimate)
    plane7_decodeErrors: number;  // decode failures (bugs to fix)
    plane7_noOutput: number;      // decoded but no output found (investigate)
    bootstrap_updates: number;
    stream_events: number;
    slot_consistency: number;
    errors: number;
    startTime: number;
    health_checks: number;
    health_failures: number;
}

function createStats(): CaptureStats {
    return {
        plane1_updates: 0,
        plane2_traces: 0,
        plane3_shreds: 0,
        plane4_txs: 0,
        plane5_topology: 0,
        plane6_frozen: 0,
        plane7_swaps: 0,
        plane7_notSwap: 0,
        plane7_decodeErrors: 0,
        plane7_noOutput: 0,
        bootstrap_updates: 0,
        stream_events: 0,
        slot_consistency: 0,
        errors: 0,
        startTime: Date.now(),
        health_checks: 0,
        health_failures: 0,
    };
}

// ============================================================================
// VALIDATION
// ============================================================================

interface ValidationMetric {
    name: string;
    category: string;
    value?: string;
    count?: number;
    pct?: number;
    details?: string;
}

function runValidation(
    db: Database.Database,
    sessionId: string,
    enqueueWrite: (fn: () => void) => void = (fn: () => void): void => fn()
): ValidationMetric[] {
    const metrics: ValidationMetric[] = [];
    const now = Date.now();

    const stmtInsert = db.prepare(`
        INSERT INTO validation_summary (session_id, created_at, metric_name, metric_category, metric_value, metric_count, metric_pct, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const addMetric = (m: ValidationMetric) => {
        metrics.push(m);
        enqueueWrite(() =>
            stmtInsert.run(sessionId, now, m.name, m.category, m.value ?? null, m.count ?? null, m.pct ?? null, m.details ?? null)
        );
    };

    // 1. Cache traces by type/source
    const tracesByType = db.prepare(`
        SELECT cache_type, source, rejected, COUNT(*) as cnt, COUNT(DISTINCT pubkey) as unique_keys
        FROM cache_traces WHERE session_id = ?
        GROUP BY cache_type, source, rejected
    `).all(sessionId) as any[];

    for (const row of tracesByType) {
        addMetric({
            name: `cache_traces_${row.cache_type}_${row.source}_${row.rejected ? 'rejected' : 'applied'}`,
            category: 'cache_traces',
            count: row.cnt,
            details: `unique_keys=${row.unique_keys}`,
        });
    }

    // 2. Slot consistency
    const slotConsistency = db.prepare(`
        SELECT
            CASE
                WHEN slot_delta = 0 THEN 'consistent'
                WHEN slot_delta <= 2 THEN 'minor'
                WHEN slot_delta <= 5 THEN 'moderate'
                ELSE 'significant'
            END as bucket,
            COUNT(*) as cnt,
            ROUND(AVG(slot_delta), 2) as avg_delta,
            MAX(slot_delta) as max_delta
        FROM snapshot_slot_consistency WHERE session_id = ?
        GROUP BY bucket
    `).all(sessionId) as any[];

    const totalConsistency = slotConsistency.reduce((sum, r) => sum + r.cnt, 0);
    for (const row of slotConsistency) {
        addMetric({
            name: `slot_consistency_${row.bucket}`,
            category: 'slot_consistency',
            count: row.cnt,
            pct: totalConsistency > 0 ? (row.cnt / totalConsistency) * 100 : 0,
            details: `avg_delta=${row.avg_delta} max_delta=${row.max_delta}`,
        });
    }

    // 3. Topology activation rates
    const topoEvents = db.prepare(`
        SELECT
            event_type,
            COUNT(*) as cnt
        FROM topology_events WHERE session_id = ?
        GROUP BY event_type
    `).all(sessionId) as any[];

    for (const row of topoEvents) {
        addMetric({
            name: `topology_${row.event_type}`,
            category: 'topology',
            count: row.cnt,
        });
    }

    // 4. Calculate activation rate
    const discovered = topoEvents.filter(r => r.event_type === 'discover').reduce((s, r) => s + r.cnt, 0);
    const activated = topoEvents.filter(r => r.event_type === 'activate').reduce((s, r) => s + r.cnt, 0);
    addMetric({
        name: 'activation_rate',
        category: 'topology',
        pct: discovered > 0 ? (activated / discovered) * 100 : 0,
        details: `${activated}/${discovered}`,
    });

    // 5. Stream health
    const streamEvents = db.prepare(`
        SELECT stream_type, event_type, COUNT(*) as cnt
        FROM stream_events WHERE session_id = ?
        GROUP BY stream_type, event_type
    `).all(sessionId) as any[];

    for (const row of streamEvents) {
        addMetric({
            name: `stream_${row.stream_type}_${row.event_type}`,
            category: 'stream_health',
            count: row.cnt,
        });
    }

    // 6. Bootstrap coverage
    const bootstrap = db.prepare(`
        SELECT account_type, COUNT(*) as cnt, COUNT(DISTINCT pubkey) as unique_accts
        FROM bootstrap_updates WHERE session_id = ?
        GROUP BY account_type
    `).all(sessionId) as any[];

    for (const row of bootstrap) {
        addMetric({
            name: `bootstrap_${row.account_type ?? 'unknown'}`,
            category: 'bootstrap',
            count: row.cnt,
            details: `unique=${row.unique_accts}`,
        });
    }

    // 7. Rejection analysis
    const rejections = db.prepare(`
        SELECT cache_type, source, COUNT(*) as cnt, ROUND(AVG(existing_slot - slot), 1) as avg_behind
        FROM cache_traces WHERE session_id = ? AND rejected = 1
        GROUP BY cache_type, source
    `).all(sessionId) as any[];

    for (const row of rejections) {
        addMetric({
            name: `rejection_${row.cache_type}_${row.source}`,
            category: 'rejections',
            count: row.cnt,
            details: `avg_slots_behind=${row.avg_behind}`,
        });
    }

    // 8. Bootstrap overwrites by gRPC
    const overwrites = db.prepare(`
        SELECT ct1.cache_type, COUNT(*) as cnt, ROUND(AVG(ct2.slot - ct1.slot), 1) as avg_newer
        FROM cache_traces ct1
        JOIN cache_traces ct2 ON ct1.pubkey = ct2.pubkey AND ct1.cache_type = ct2.cache_type AND ct1.session_id = ct2.session_id
        WHERE ct1.session_id = ?
          AND ct1.source = 'bootstrap' AND ct1.rejected = 0
          AND ct2.source = 'grpc' AND ct2.rejected = 0
          AND ct2.slot > ct1.slot AND ct2.apply_ts > ct1.apply_ts
        GROUP BY ct1.cache_type
    `).all(sessionId) as any[];

    for (const row of overwrites) {
        addMetric({
            name: `overwrite_${row.cache_type}`,
            category: 'overwrites',
            count: row.cnt,
            details: `avg_slots_newer=${row.avg_newer}`,
        });
    }

    // 9. Vaults without gRPC updates
    const vaultStatus = db.prepare(`
        SELECT
            CASE WHEN grpc_count > 0 THEN 'has_grpc' ELSE 'bootstrap_only' END as status,
            COUNT(*) as cnt
        FROM (
            SELECT pubkey, SUM(CASE WHEN source = 'grpc' THEN 1 ELSE 0 END) as grpc_count
            FROM cache_traces WHERE session_id = ? AND cache_type = 'vault' AND rejected = 0
            GROUP BY pubkey
        ) GROUP BY status
    `).all(sessionId) as any[];

    for (const row of vaultStatus) {
        addMetric({
            name: `vault_${row.status}`,
            category: 'vault_coverage',
            count: row.cnt,
        });
    }

    // 10. Slot ranges
    const slotRanges = db.prepare(`
        SELECT cache_type, source, MIN(slot) as min_slot, MAX(slot) as max_slot, MAX(slot) - MIN(slot) as span
        FROM cache_traces WHERE session_id = ? AND rejected = 0
        GROUP BY cache_type, source
    `).all(sessionId) as any[];

    for (const row of slotRanges) {
        addMetric({
            name: `slot_range_${row.cache_type}_${row.source}`,
            category: 'slot_ranges',
            count: row.span,
            details: `min=${row.min_slot} max=${row.max_slot}`,
        });
    }

    // 11. Trust assessment
    const streamIssues = streamEvents.filter(r => r.event_type === 'disconnect' || r.event_type === 'error').reduce((s, r) => s + r.cnt, 0);
    const consistentPct = totalConsistency > 0 ? (slotConsistency.find(r => r.bucket === 'consistent')?.cnt ?? 0) / totalConsistency * 100 : 0;
    const activationPct = discovered > 0 ? (activated / discovered) * 100 : 0;

    let trustStatus = 'OK';
    const trustIssues: string[] = [];

    if (streamIssues > 0) {
        trustIssues.push(`stream_disruptions=${streamIssues}`);
    }
    if (consistentPct < 90) {
        trustIssues.push(`slot_consistency=${consistentPct.toFixed(1)}%`);
    }
    if (activationPct < 90) {
        trustIssues.push(`activation_rate=${activationPct.toFixed(1)}%`);
    }

    if (trustIssues.length > 0) {
        trustStatus = 'WARN';
    }

    addMetric({
        name: 'trust_status',
        category: 'trust',
        value: trustStatus,
        details: trustIssues.length > 0 ? trustIssues.join(', ') : 'all_checks_passed',
    });

    return metrics;
}

// ============================================================================
// MAIN
// ============================================================================

async function main(): Promise<void> {
    const sessionId = randomUUID();
    const scriptHash = computeScriptHash();

    // Prevent concurrent runs writing the same SQLite file
    acquireLock(sessionId);

    // Start watchdog worker thread for hang detection
    startWatchdogWorker();

    // Start canary timer to detect event loop blocks
    const canaryInterval = startCanary();
    console.log('[canary] Event loop block detection started (500ms interval)');

    // Start CPU watchdog to detect CPU spins (BigInt loops, O(n²), decode bombs)
    cpuWatchdogInterval = startCpuWatchdog();
    console.log('[cpu-watchdog] CPU spin detection started (5s interval, >4s threshold)');

    if (DEBUG) {
        console.log('='.repeat(70));
        console.log('EVIDENCE CAPTURE v2.3 — TRACE-BASED');
        console.log('='.repeat(70));
        console.log(`Session ID:        ${sessionId}`);
        console.log(`Script Hash:       ${scriptHash}`);
        console.log(`gRPC Endpoint:     ${GRPC_ENDPOINT}`);
        console.log(`ShredStream:       ${SHRED_ENDPOINT}`);
        console.log(`RPC Endpoint:      ${RPC_ENDPOINT}`);
        console.log(`Capture Duration:  ${CAPTURE_SECONDS > 0 ? CAPTURE_SECONDS + 's' : 'indefinite'}`);
        console.log(`Output:            ${SQLITE_FILE}`);
        console.log('='.repeat(70));
    }

    // Initialize database (better-sqlite3 writes directly to disk)
    const db = initDatabase();
    DEBUG && console.log('[db] SQLite initialized (streaming writes enabled)');

    // ------------------------------------------------------------------------
    // Batched transaction helper to amortize fsync overhead
    // Commits every TXN_BATCH_SIZE writes or on flush
    // ------------------------------------------------------------------------
    // Async-friendly write queue to avoid blocking event loop
    const WRITE_BATCH_SIZE = 200;  // smaller batch to keep event loop responsive
    const WRITE_FLUSH_THRESHOLD = 100; // schedule flush after this many queued items
    let writeQueue: Array<() => void> = [];
    let flushScheduled = false;
    let flushTimer: NodeJS.Timeout | null = null;

    // Flush diagnostics for hang detection
    let lastFlushStartMs = 0;
    let lastFlushEndMs = 0;
    let lastFlushDurationMs = 0;
    let maxFlushDurationMs = 0;
    let flushCount = 0;

    const flushQueue = (): void => {
        flushScheduled = false;
        if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
        }
        if (writeQueue.length === 0) return;

        const batchSize = Math.min(writeQueue.length, WRITE_BATCH_SIZE);
        const batch = writeQueue.splice(0, WRITE_BATCH_SIZE);

        lastFlushStartMs = Date.now();
        trackOp('flush_start', `batch=${batchSize}`);

        try {
            db.exec('BEGIN');
            for (const fn of batch) {
                fn();
            }
            db.exec('COMMIT');
            flushCount++;
        } catch (err) {
            try {
                db.exec('ROLLBACK');
            } catch {
                // ignore rollback failure
            }
            console.error('[db] flush error:', err);
        }

        lastFlushEndMs = Date.now();
        lastFlushDurationMs = lastFlushEndMs - lastFlushStartMs;
        if (lastFlushDurationMs > maxFlushDurationMs) {
            maxFlushDurationMs = lastFlushDurationMs;
        }

        // Warn if flush took too long (could cause event loop stall)
        if (lastFlushDurationMs > 100) {
            console.warn(`[db] Slow flush: ${lastFlushDurationMs}ms for ${batchSize} items`);
        }

        trackOp('flush_done', `dur=${lastFlushDurationMs}ms`);

        if (writeQueue.length > 0 && !flushScheduled) {
            flushScheduled = true;
            setImmediate(flushQueue);
        }
    };

    const enqueueWrite = (fn: () => void): void => {
        writeQueue.push(fn);
        if (!flushScheduled && writeQueue.length >= WRITE_FLUSH_THRESHOLD) {
            flushScheduled = true;
            setImmediate(flushQueue);
        }
        // Periodic safety flush even if threshold not hit (every 250ms)
        if (!flushTimer) {
            flushTimer = setTimeout(() => {
                flushTimer = null;
                if (!flushScheduled && writeQueue.length > 0) {
                    flushScheduled = true;
                    setImmediate(flushQueue);
                }
            }, 250);
        }
    };

    // Insert session record
    enqueueWrite(() => db.prepare(`INSERT INTO capture_sessions
        (id, started_at, script_name, script_version, script_hash, grpc_endpoint, shred_endpoint, warmup_seconds, duration_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sessionId, Date.now(), 'capture-evidence.ts', '2.3.0', scriptHash,
        GRPC_ENDPOINT, SHRED_ENDPOINT, 0, CAPTURE_SECONDS));

    const stats = createStats();

    // ========================================================================
    // PREPARED STATEMENTS
    // better-sqlite3 prepared statements write directly to disk on each .run()
    // No in-memory buffering, no 2GB limit, safe for multi-day capture.
    //
    // CAPTURE PLANES (authoritative ledger data only):
    //   P1: mainnet_updates  — raw account state from gRPC
    //   P2: cache_traces     — cache mutation events
    //   P3: pending_shreds   — pending txs from ShredStream
    //   P4: mainnet_txs      — confirmed txs from gRPC
    //   P5: topology_events  — pool lifecycle transitions
    //   P6: frozen_topologies — topology snapshots at freeze
    // ========================================================================

    const stmtUpdate = db.prepare(
        `INSERT INTO mainnet_updates (session_id, ingest_ts, slot, write_version, pubkey, owner, data_b64, lamports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtTrace = db.prepare(
        `INSERT INTO cache_traces (session_id, apply_ts, cache_type, pubkey, slot, write_version, cache_key, data_length, source, rejected, existing_slot, evicted, out_of_frozen_range)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtShred = db.prepare(
        `INSERT INTO pending_shreds (session_id, receive_ts, slot, signature, raw_message_b64)
         VALUES (?, ?, ?, ?, ?)`);

    const stmtTx = db.prepare(
        `INSERT OR IGNORE INTO mainnet_txs (session_id, confirm_ts, slot, signature, accounts_json, pre_balances_json, post_balances_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const stmtSwap = db.prepare(
        `INSERT INTO parsed_swaps (session_id, confirm_ts, slot, signature, venue, pool_pubkey, direction, input_mint, output_mint, input_amount, min_output_amount, actual_output_amount, tx_fee_lamports, decode_success, instruction_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtTopologyEvent = db.prepare(
        `INSERT INTO topology_events (session_id, event_ts, pool_pubkey, slot, event_type, prev_state, new_state, reason, epoch, details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtFrozenTopology = db.prepare(
        `INSERT INTO frozen_topologies (session_id, pool_pubkey, venue, frozen_at_slot, frozen_at_ms, vault_base, vault_quote, required_tick_arrays, required_bin_arrays, amm_config_pubkey, epoch, tick_range_min, tick_range_max, bin_range_min, bin_range_max)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtBootstrap = db.prepare(
        `INSERT INTO bootstrap_updates (session_id, fetch_ts, slot, pubkey, owner, data_b64, lamports, executable, rent_epoch, pool_pubkey, account_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtStreamEvent = db.prepare(
        `INSERT INTO stream_events (session_id, event_ts, stream_type, event_type, last_slot_seen, error_message, reconnect_attempt, rollback_depth, rollback_from_slot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const stmtSlotConsistency = db.prepare(
        `INSERT INTO snapshot_slot_consistency (session_id, build_ts, pool_pubkey, pool_slot, base_vault_slot, quote_vault_slot, min_tick_slot, min_bin_slot, slot_delta, is_consistent, build_success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    // ========================================================================
    // PHASE3 HANDLER + TRACE HOOKS
    // ========================================================================

    const grpcConsumer = createGrpcConsumer(subscriptionProgramIds, GRPC_ENDPOINT);
    const handler = createPhase3Handler({
        rpcEndpoint: RPC_ENDPOINT,
        grpcConsumer,
        tickArrayRadius: 3,
        binArrayRadius: 3,
    });

    // Track last progress timestamps for diagnostics
    let lastP1At = Date.now();
    let lastP1CountSnapshot = 0;

    // Phase 4.7: Track frozen topology ranges for out_of_frozen_range detection
    // Key: poolHex, Value: { tickMin, tickMax, binMin, binMax }
    const frozenRanges = new Map<string, { tickMin: number | null; tickMax: number | null; binMin: number | null; binMax: number | null }>();

    /**
     * Check if a tick/bin array index is outside the frozen range for its pool
     * Returns true if outside range (or no frozen topology exists yet)
     */
    function isOutOfFrozenRange(cacheKey: string | undefined, cacheType: 'tick' | 'bin'): boolean {
        if (!cacheKey) return false;
        const colonIdx = cacheKey.indexOf(':');
        if (colonIdx === -1) return false;

        const poolHex = cacheKey.slice(0, colonIdx);
        const arrayIndex = parseInt(cacheKey.slice(colonIdx + 1), 10);
        if (isNaN(arrayIndex)) return false;

        const range = frozenRanges.get(poolHex);
        if (!range) return false; // No frozen topology yet - not out of range

        if (cacheType === 'tick') {
            if (range.tickMin === null || range.tickMax === null) return false;
            return arrayIndex < range.tickMin || arrayIndex > range.tickMax;
        } else {
            if (range.binMin === null || range.binMax === null) return false;
            return arrayIndex < range.binMin || arrayIndex > range.binMax;
        }
    }

    // Register stream continuity handler for gRPC (C1 Fix)
    // Records connect/disconnect/reconnect/rollback events to prove session validity
    const continuityHandler = (event: StreamContinuityEvent): void => {
        try {
            enqueueWrite(() =>
                stmtStreamEvent.run(
                    sessionId,
                    event.timestamp,
                    event.streamType,
                    event.eventType,
                    event.lastSlotSeen,
                    event.errorMessage ?? null,
                    event.reconnectAttempt ?? null,
                    event.rollbackDepth ?? null,
                    event.rollbackFromSlot ?? null
                )
            );
            stats.stream_events++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[stream] Error: ${err?.message ?? err}`);
            }
        }
    };
    grpcConsumer.onContinuityEvent(continuityHandler);

    // Register trace handlers on all caches (Plane 2)
    // NOTE: P1 can be > P2 because some mainnet updates don't mutate cache
    // (e.g., duplicate writeVersion, non-DEX accounts in subscription)
    const traceHandler = (event: CacheTraceEvent): void => {
        // Track operation for hang diagnosis
        trackOp(`trace_${event.cacheType}_${event.source}`, event.pubkey);

        // Phase 4.7: Check if tick/bin gRPC update is outside frozen topology range
        let outOfFrozenRange = 0;
        if (event.source === 'grpc' && (event.cacheType === 'tick' || event.cacheType === 'bin')) {
            outOfFrozenRange = isOutOfFrozenRange(event.cacheKey, event.cacheType) ? 1 : 0;
        }

        try {
            enqueueWrite(() =>
                stmtTrace.run(
                    sessionId,
                    event.appliedAtMs,
                    event.cacheType,
                    toHex(event.pubkey),
                    event.slot,
                    event.writeVersion.toString(),
                    event.cacheKey ?? null,
                    event.dataLength,
                    event.source,
                    event.rejected ? 1 : 0,
                    event.existingSlot ?? null,
                    event.evicted ? 1 : 0,
                    outOfFrozenRange
                )
            );
            stats.plane2_traces++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[trace] Error: ${err?.message ?? err}`);
            }
        }
    };

    handler.poolCache.setTraceHandler(traceHandler);
    handler.vaultCache.setTraceHandler(traceHandler);
    handler.tickCache.setTraceHandler(traceHandler);
    handler.binCache.setTraceHandler(traceHandler);
    handler.ammConfigCache.setTraceHandler(traceHandler);
    handler.registry.globalConfig.setTraceHandler(traceHandler);

    // ========================================================================
    // SLOT CONSISTENCY PROBE
    // ========================================================================

    /**
     * Probe slot consistency for a pool at activation time.
     * Records the slot of each component to analyze cross-cache consistency.
     */
    function probeSlotConsistency(poolPubkey: Uint8Array, activationSlot: number): void {
        try {
            // Get pool entry
            const poolEntry = handler.poolCache.get(poolPubkey);
            if (!poolEntry) return;

            const pool = poolEntry.state;
            const poolSlot = poolEntry.slot;

            // Determine vault pubkeys based on venue
            let baseVaultPubkey: Uint8Array;
            let quoteVaultPubkey: Uint8Array;

            switch (pool.venue) {
                case VenueId.PumpSwap:
                    baseVaultPubkey = (pool as any).baseVault;
                    quoteVaultPubkey = (pool as any).quoteVault;
                    break;
                case VenueId.RaydiumV4:
                    baseVaultPubkey = (pool as any).baseVault;
                    quoteVaultPubkey = (pool as any).quoteVault;
                    break;
                case VenueId.RaydiumClmm:
                    baseVaultPubkey = (pool as RaydiumClmmPool).tokenVault0;
                    quoteVaultPubkey = (pool as RaydiumClmmPool).tokenVault1;
                    break;
                case VenueId.MeteoraDlmm:
                    baseVaultPubkey = (pool as MeteoraDlmmPool).vaultX;
                    quoteVaultPubkey = (pool as MeteoraDlmmPool).vaultY;
                    break;
                default:
                    return;
            }

            // Get vault slots
            const baseVault = handler.vaultCache.get(baseVaultPubkey);
            const quoteVault = handler.vaultCache.get(quoteVaultPubkey);
            const baseVaultSlot = baseVault?.slot ?? -1;
            const quoteVaultSlot = quoteVault?.slot ?? -1;

            // Get tick/bin array min slots
            let minTickSlot: number | null = null;
            let minBinSlot: number | null = null;

            if (pool.venue === VenueId.RaydiumClmm) {
                const tickArrays = handler.tickCache.getForPool(toHex(poolPubkey));
                if (tickArrays.length > 0) {
                    minTickSlot = Math.min(...tickArrays.map(t => t.slot));
                }
            }

            if (pool.venue === VenueId.MeteoraDlmm) {
                const binArrays = handler.binCache.getForPool(toHex(poolPubkey));
                if (binArrays.length > 0) {
                    minBinSlot = Math.min(...binArrays.map(b => b.slot));
                }
            }

            // Calculate slot delta (max - min across all components)
            const slots = [poolSlot, baseVaultSlot, quoteVaultSlot];
            if (minTickSlot !== null) slots.push(minTickSlot);
            if (minBinSlot !== null) slots.push(minBinSlot);

            const validSlots = slots.filter(s => s >= 0);
            const slotDelta = validSlots.length > 0
                ? Math.max(...validSlots) - Math.min(...validSlots)
                : 0;

            // Consistency check: all components at same slot
            const isConsistent = slotDelta === 0 ? 1 : 0;

            // Record to database
            enqueueWrite(() =>
                stmtSlotConsistency.run(
                    sessionId,
                    Date.now(),
                    toHex(poolPubkey),
                    poolSlot,
                    baseVaultSlot,
                    quoteVaultSlot,
                    minTickSlot,
                    minBinSlot,
                    slotDelta,
                    isConsistent,
                    1  // build_success = true (we're probing at activation)
                )
            );
            stats.slot_consistency++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[slot-consistency] Error: ${err?.message ?? err}`);
            }
        }
    }

    // Register lifecycle handler for topology events (Plane 5 + 6)
    // Captures pool lifecycle: discover → freeze → activate → refresh_start → freeze → activate
    handler.registry.lifecycle!.setEventHandler((event: LifecycleEvent) => {
        try {
            // Phase 2.1: Build convergence evidence for activate events
            // This proves each dependency source at activation time (gRPC vs bootstrap)
            let details: string | null = null;
            if (event.type === 'activate') {
                const topology = handler.registry.lifecycle!.getTopology(event.poolPubkey);
                if (topology) {
                    const convergence: {
                        pool?: string;
                        vaults?: { base?: string; quote?: string };
                        deps?: { tick?: string[]; bin?: string[] };
                    } = {};

                    // Pool source
                    const poolEntry = handler.registry.pool.getEntry(event.poolPubkey);
                    if (poolEntry?.source) {
                        convergence.pool = poolEntry.source;
                    }

                    // Vault sources
                    const baseVault = handler.registry.vault.getEntry(topology.vaults.base);
                    const quoteVault = handler.registry.vault.getEntry(topology.vaults.quote);
                    if (baseVault?.source || quoteVault?.source) {
                        convergence.vaults = {};
                        if (baseVault?.source) convergence.vaults.base = baseVault.source;
                        if (quoteVault?.source) convergence.vaults.quote = quoteVault.source;
                    }

                    // Tick/bin array sources (only if present)
                    if (topology.requiredTickArrays.length > 0 || topology.requiredBinArrays.length > 0) {
                        convergence.deps = {};
                        if (topology.requiredTickArrays.length > 0) {
                            convergence.deps.tick = topology.requiredTickArrays.map(idx => {
                                const entry = handler.registry.tick.getEntry(topology.poolPubkey, idx);
                                return entry?.source ?? 'virtual';
                            });
                        }
                        if (topology.requiredBinArrays.length > 0) {
                            convergence.deps.bin = topology.requiredBinArrays.map(idx => {
                                const entry = handler.registry.bin.getEntry(topology.poolPubkey, idx);
                                return entry?.source ?? 'virtual';
                            });
                        }
                    }

                    details = JSON.stringify({ convergence });
                }
            }

            // P5: Record lifecycle event (including refresh_start)
            enqueueWrite(() =>
                stmtTopologyEvent.run(
                    sessionId,
                    Date.now(),
                    toHex(event.poolPubkey),
                    event.slot,
                    event.type,
                    event.prevState,
                    event.newState,
                    event.reason ?? null,
                    event.epoch ?? 0,
                    details
                )
            );
            stats.plane5_topology++;

            // P6: Record frozen topology snapshot on freeze events
            if (event.type === 'freeze' && event.topology) {
                const t = event.topology;

                // Phase 4.7: Compute coverage span (min/max tick/bin indexes)
                const tickRangeMin = t.requiredTickArrays.length > 0 ? Math.min(...t.requiredTickArrays) : null;
                const tickRangeMax = t.requiredTickArrays.length > 0 ? Math.max(...t.requiredTickArrays) : null;
                const binRangeMin = t.requiredBinArrays.length > 0 ? Math.min(...t.requiredBinArrays) : null;
                const binRangeMax = t.requiredBinArrays.length > 0 ? Math.max(...t.requiredBinArrays) : null;

                // Phase 4.7: Track frozen ranges for out_of_frozen_range detection
                const poolHex = toHex(t.poolPubkey);
                frozenRanges.set(poolHex, { tickMin: tickRangeMin, tickMax: tickRangeMax, binMin: binRangeMin, binMax: binRangeMax });

                enqueueWrite(() =>
                    stmtFrozenTopology.run(
                        sessionId,
                        poolHex,
                        t.venue,
                        t.frozenAtSlot,
                        t.frozenAtMs,
                        toHex(t.vaults.base),
                        toHex(t.vaults.quote),
                        JSON.stringify(t.requiredTickArrays),
                        JSON.stringify(t.requiredBinArrays),
                        t.ammConfigPubkey ? toHex(t.ammConfigPubkey) : null,
                        event.epoch ?? 0,
                        tickRangeMin,
                        tickRangeMax,
                        binRangeMin,
                        binRangeMax
                    )
                );
                stats.plane6_frozen++;
            }

            // Slot consistency probe on activation
            // Records the actual slot of each component to analyze cross-cache consistency
            if (event.type === 'activate') {
                probeSlotConsistency(event.poolPubkey, event.slot);
            }
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[topology] Error: ${err?.message ?? err}`);
            }
        }
    });

    // Register bootstrap handler for RPC snapshot capture (deterministic replay)
    // This captures the raw bytes from fetchPoolDeps() RPC calls with full account metadata
    setBootstrapHandler((event: BootstrapEvent) => {
        try {
            enqueueWrite(() =>
                stmtBootstrap.run(
                    sessionId,
                    event.fetchedAtMs,
                    event.slot,
                    toHex(event.pubkey),
                    event.owner ? toHex(event.owner) : null,  // Real owner pubkey (hex)
                    event.data ? toBase64(event.data) : null,
                    event.lamports.toString(),                 // Actual lamports
                    event.executable ? 1 : 0,                  // Executable flag
                    event.rentEpoch.toString(),                // Rent epoch
                    toHex(event.poolPubkey),
                    event.accountType                          // Account type for routing
                )
            );
            stats.bootstrap_updates++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[bootstrap] Error: ${err?.message ?? err}`);
            }
        }
    });

    let isCapturing = false;
    let lastSlotSeen = 0;
    let lastSlotSeenAt = Date.now();

    // Wrap handler to capture Plane 1 (mainnet updates)
    // P1 recorded before cache apply so ingest_ts <= apply_ts
    const originalHandle = handler.handle;
    handler.handle = (event: IngestEvent) => {
        if (isCapturing && event.type === 'account') {
            const update = event.update as AccountUpdate;
            const ingestTs = event.ingestTimestampMs ?? Date.now();

            // Track operation for hang diagnosis
            trackOp('p1_account', update.pubkey);

            // Track slot for zombie connection detection
            if (update.slot > lastSlotSeen) {
                lastSlotSeen = update.slot;
                lastSlotSeenAt = Date.now();
            }

            try {
                enqueueWrite(() =>
                    stmtUpdate.run(
                        sessionId,
                        ingestTs,
                        update.slot,
                        update.writeVersion.toString(),
                        toHex(update.pubkey),
                        toHex(update.owner),
                        toBase64(update.data),
                        update.lamports.toString(),
                    )
                );
                stats.plane1_updates++;
                lastP1At = Date.now();
            } catch (err: any) {
                stats.errors++;
                if (stats.errors <= 5) {
                    console.error(`[update] Error: ${err?.message ?? err}`);
                }
            }
        }

        // Track before calling original handler (where decode/commit happens)
        if (event.type === 'account') {
            const update = event.update as AccountUpdate;

            // Capture atomic snapshot BEFORE handler call - survives hang
            lastEventSnapshot = {
                ts: Date.now(),
                eventType: event.type,
                pubkey: toHex(update.pubkey),
                owner: toHex(update.owner),
                slot: update.slot,
                writeVersion: update.writeVersion?.toString() ?? '0',
                dataLength: update.data?.length ?? 0,
            };

            trackOp('handler_start', update.pubkey);

            const t0 = process.hrtime.bigint();
            originalHandle(event);
            const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;

            trackOp('handler_done', update.pubkey);

            // Log stall candidates - any handler taking >100ms is suspicious
            if (dtMs > 100) {
                console.error(
                    `[STALL-CANDIDATE] handler took ${dtMs.toFixed(1)}ms ` +
                    `type=${event.type} pubkey=${toHex(update.pubkey)} slot=${update.slot}`
                );
            }
        } else {
            originalHandle(event);
        }
    };

    grpcConsumer.onEvent(handler.handle);

    // ========================================================================
    // GLOBALCONFIG BOOTSTRAP
    // ========================================================================

    async function bootstrapGlobalConfig(): Promise<void> {
        try {
            // Use fetchWithTimeout to prevent indefinite hangs on RPC
            const response = await fetchWithTimeout(RPC_ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getAccountInfo',
                    params: [PUMPSWAP_GLOBAL_CONFIG, { encoding: 'base64' }],
                }),
            }, RPC_TIMEOUT_MS);
            const json = await response.json() as any;
            if (json.result?.value?.data) {
                const accountInfo = json.result.value;
                const data = new Uint8Array(Buffer.from(accountInfo.data[0], 'base64'));
                const slot = json.result.context?.slot ?? 0;
                const config = decodePumpSwapGlobalConfig(data);

                // Extract full account metadata for deterministic replay
                const owner = accountInfo.owner ?? null;
                const lamports = accountInfo.lamports ?? 0;
                const executable = accountInfo.executable ?? false;
                const rentEpoch = accountInfo.rentEpoch ?? 0;

                /// B4.2: Use commitAccountUpdate instead of separate cache
                commitAccountUpdate(handler.registry, {
                    type: 'globalConfig',
                    config,
                    slot,
                    writeVersion: 0n,  // RPC doesn't provide writeVersion
                    dataLength: data.length,
                    source: 'bootstrap',
                });

                // Record bootstrap update for replay proof (B4.3) with full account metadata
                // All pubkeys stored as hex for consistent joins
                const ownerHex = owner ? toHex(bs58.decode(owner)) : null;
                enqueueWrite(() =>
                    stmtBootstrap.run(
                        sessionId,
                        Date.now(),
                        slot,
                        toHex(PUMPSWAP_GLOBAL_CONFIG_PUBKEY),
                        ownerHex,                           // owner pubkey (hex)
                        toBase64(data),
                        lamports.toString(),                // Actual lamports
                        executable ? 1 : 0,                 // Executable flag
                        rentEpoch.toString(),               // Rent epoch
                        null,                               // no pool association
                        'globalConfig'                      // account type
                    )
                );
                stats.bootstrap_updates++;

                DEBUG && console.log('[bootstrap] GlobalConfig committed via commitAccountUpdate');
            }
        } catch (err: any) {
            // Silenced: GlobalConfig fetch failed (non-fatal)
            DEBUG && console.log('[bootstrap] GlobalConfig fetch failed:', err?.message);
        }
    }

    // ========================================================================
    // GRPC TRANSACTION SUBSCRIPTION (Plane 4)
    // ========================================================================

    const pkgDef = loadSync(GEYSER_PROTO, PROTO_LOADER_OPTS as any);
    const loaded = loadPackageDefinition(pkgDef) as any;
    const geyserSvc = loaded.geyser?.Geyser ?? loaded.solana?.geyser?.Geyser ?? loaded.agave?.geyser?.Geyser;

    if (!geyserSvc) {
        throw new Error(`Geyser service not found in proto at ${GEYSER_PROTO}`);
    }

    const txClient = new geyserSvc(GRPC_ENDPOINT, credentials.createInsecure());

    // ========================================================================
    // SHREDSTREAM CONSUMER (Plane 3)
    // ========================================================================

    const shredConsumer = createShredStreamConsumer(SHRED_ENDPOINT);
    shredConsumer.onContinuityEvent(continuityHandler);  // C1 Fix: reuse same handler

    shredConsumer.onEvent((event: IngestEvent) => {
        if (!isCapturing) return;
        if (event.type !== 'tx') return;

        const tx = event.update as TxUpdate;
        const signature = toHex(tx.signature);

        try {
            enqueueWrite(() =>
                stmtShred.run(
                    sessionId,
                    Date.now(),
                    tx.slot,
                    signature,
                    toBase64(tx.message),
                )
            );
            stats.plane3_shreds++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[shred] Error: ${err?.message ?? err}`);
            }
        }
        // NOTE: Shreds do NOT trigger cache operations
    });

    // ========================================================================
    // CAPTURE PHASE (immediate start)
    // ========================================================================

    DEBUG && console.log(`\n[capture] Starting capture immediately...`);
    isCapturing = true;

    // DIAGNOSTIC: Track startup phases in heartbeat
    updateHeartbeat({ phase: 'startup_grpc' });
    writeHeartbeat();

    // Start handler - this does: gRPC start → full bootstrap → ready
    // The handler is configured with useFullBootstrap: true
    await handler.start();

    // Phase 4.1: Persist grpc_subscription_start_slot for post-hoc convergence validation
    // startSlot is captured after first gRPC response, so it's available after handler.start()
    const grpcStartSlot = grpcConsumer.getGrpcSubscriptionStartSlot();
    enqueueWrite(() =>
        db.prepare(`UPDATE capture_sessions SET grpc_subscription_start_slot = ? WHERE id = ?`)
            .run(grpcStartSlot, sessionId)
    );
    DEBUG && console.log(`[capture] gRPC subscription start slot: ${grpcStartSlot}`);

    // DIAGNOSTIC: Track GlobalConfig bootstrap phase
    updateHeartbeat({ phase: 'startup_globalconfig' });
    writeHeartbeat();

    // GlobalConfig is already handled by fullSnapshotBootstrap, but ensure it's loaded
    await bootstrapGlobalConfig();

    // DIAGNOSTIC: Track ShredStream startup phase
    updateHeartbeat({ phase: 'startup_shredstream' });
    writeHeartbeat();

    // Start ShredStream (Plane 3)
    await shredConsumer.start();
    DEBUG && console.log('[capture] ShredStream connected');

    // DIAGNOSTIC: Track TX subscription startup phase
    updateHeartbeat({ phase: 'startup_txsub' });
    writeHeartbeat();

    // Start TX subscription (Plane 4)
    const txStream = txClient.Subscribe();
    txStream.write({
        transactions: {
            'tx_filter': {
                vote: false,
                failed: false,
                account_include: subscriptionProgramIds,
                account_exclude: [],
            }
        },
        commitment: 1, // CONFIRMED
    });
    DEBUG && console.log('[capture] TX subscription started');

    txStream.on('data', (update: any) => {
        if (!update.transaction) return;
        const txInfo = update.transaction.transaction;
        if (!txInfo) return;

        const tx = txInfo.transaction;
        const meta = txInfo.meta;
        const slot = Number(update.transaction.slot ?? 0);

        if (!tx?.message || !meta || meta.err) return;

        const signature = toHex(toUint8Array(txInfo.signature));
        const msg = tx.message;
        const accountKeys = (msg.account_keys || []).map((k: any) => toHex(toUint8Array(k)));

        const preBalances = meta.pre_token_balances || [];
        const postBalances = meta.post_token_balances || [];

        // Transaction fee from meta (lamports)
        const txFeeLamports = meta.fee ? String(meta.fee) : null;

        try {
            enqueueWrite(() =>
                stmtTx.run(
                    sessionId,
                    Date.now(),
                    slot,
                    signature,
                    JSON.stringify(accountKeys),
                    JSON.stringify(preBalances),
                    JSON.stringify(postBalances),
                )
            );
            stats.plane4_txs++;
        } catch (err: any) {
            stats.errors++;
            if (stats.errors <= 5) {
                console.error(`[tx] Error: ${err?.message ?? err}`);
            }
        }

        // ================================================================
        // PLANE 7 — Parse swap instructions
        // ================================================================
        try {
            // Convert account keys to Uint8Array for decoder
            const accountKeysBytes: Uint8Array[] = (msg.account_keys || []).map((k: any) => toUint8Array(k));

            // Parse instructions from message
            const rawInstructions = msg.instructions || [];
            const compiledInstructions: CompiledInstruction[] = rawInstructions.map((ix: any) => ({
                programIdIndex: ix.program_id_index ?? ix.programIdIndex ?? 0,
                accountKeyIndexes: ix.accounts ?? ix.account_key_indexes ?? [],
                data: toUint8Array(ix.data),
            }));

            // Fast check: does this tx have any swap instructions?
            if (!hasSwapInstructions(compiledInstructions, accountKeysBytes)) {
                // No swaps - track for L2-001 funnel visibility
                stats.plane7_notSwap++;
            } else {
                // Decode swaps
                const decodedTx = { accountKeys: accountKeysBytes };
                const result = extractSwapLegs(decodedTx as any, compiledInstructions);

                if (result.success && result.legs.length > 0) {
                    const confirmTs = Date.now();

                    for (let legIndex = 0; legIndex < result.legs.length; legIndex++) {
                        const leg = result.legs[legIndex]!;
                        // Calculate actual output from balance deltas
                        // Token balances use base58 mints, so convert our bytes to base58.
                        // For placeholder mints (notably RaydiumV4 without pool lookup), resolve from
                        // source/destination token account balance metadata before persistence.
                        let inputMintB58 = bs58.encode(leg.inputMint);
                        let outputMintB58 = bs58.encode(leg.outputMint);
                        const inputMintPlaceholder = leg.inputMint.every(b => b === 0);
                        const outputMintPlaceholder = leg.outputMint.every(b => b === 0);

                        if (inputMintPlaceholder || outputMintPlaceholder) {
                            const RAYDIUM_V4_B58 = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
                            const RAYDIUM_CLMM_B58 = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';

                            // Select matching swap instruction in same-venue ordinal order.
                            const venueProgramB58 = leg.venue === VenueId.RaydiumV4
                                ? RAYDIUM_V4_B58
                                : leg.venue === VenueId.RaydiumClmm
                                    ? RAYDIUM_CLMM_B58
                                    : null;

                            if (venueProgramB58) {
                                const matchingIxs = compiledInstructions.filter((instruction) => {
                                    const progId = accountKeysBytes[instruction.programIdIndex];
                                    if (!progId) return false;
                                    return bs58.encode(progId) === venueProgramB58;
                                });

                                let venueOrdinal = 0;
                                for (let j = 0; j < legIndex; j++) {
                                    if (result.legs[j]?.venue === leg.venue) {
                                        venueOrdinal++;
                                    }
                                }

                                const ix = matchingIxs[venueOrdinal] ?? matchingIxs[0];
                                if (ix) {
                                    let userSourceIdx: number | undefined;
                                    let userDestIdx: number | undefined;

                                    if (venueProgramB58 === RAYDIUM_V4_B58) {
                                        // RaydiumV4: source=15, dest=16
                                        userSourceIdx = ix.accountKeyIndexes[15];
                                        userDestIdx = ix.accountKeyIndexes[16];
                                    } else if (venueProgramB58 === RAYDIUM_CLMM_B58) {
                                        // RaydiumClmm swap_v2: source=3, dest=4
                                        userSourceIdx = ix.accountKeyIndexes[3];
                                        userDestIdx = ix.accountKeyIndexes[4];
                                    }

                                    if (inputMintPlaceholder && userSourceIdx !== undefined) {
                                        const srcAcctBal = preBalances.find((b: any) => b.account_index === userSourceIdx)
                                            ?? postBalances.find((b: any) => b.account_index === userSourceIdx);
                                        if (srcAcctBal?.mint) {
                                            inputMintB58 = srcAcctBal.mint;
                                        }
                                    }

                                    if (outputMintPlaceholder && userDestIdx !== undefined) {
                                        const destAcctBal = postBalances.find((b: any) => b.account_index === userDestIdx)
                                            ?? preBalances.find((b: any) => b.account_index === userDestIdx);
                                        if (destAcctBal?.mint) {
                                            outputMintB58 = destAcctBal.mint;
                                        }
                                    }
                                }
                            }
                        }

                        let actualOutput: string | null = null;

                        // Look through token balances to find output token delta
                        // FIX: Take LARGEST positive delta, not first (fee recipient may appear first)
                        let largestDelta = 0n;
                        for (const postBal of postBalances) {
                            if (!postBal.mint) continue;
                            // postBal.mint is already base58 string
                            if (postBal.mint === outputMintB58) {
                                // Find matching pre balance
                                const preBal = preBalances.find((p: any) => {
                                    if (!p.mint) return false;
                                    return p.mint === outputMintB58 && p.account_index === postBal.account_index;
                                });
                                if (preBal && postBal.ui_token_amount && preBal.ui_token_amount) {
                                    const postAmt = BigInt(postBal.ui_token_amount.amount ?? '0');
                                    const preAmt = BigInt(preBal.ui_token_amount.amount ?? '0');
                                    if (postAmt > preAmt) {
                                        const delta = postAmt - preAmt;
                                        if (delta > largestDelta) {
                                            largestDelta = delta;
                                            actualOutput = String(delta);
                                        }
                                    }
                                }
                            }
                        }

                        // Venue name from VenueId enum
                        const venueNames = ['pumpswap', 'raydiumV4', 'raydiumClmm', 'meteoraDlmm'];
                        const venueName = venueNames[leg.venue] ?? 'unknown';

                        // Track noOutput for L2-001 funnel visibility
                        if (!actualOutput) {
                            stats.plane7_noOutput++;
                        }

                        let persistedInputMintHex = toHex(leg.inputMint);
                        let persistedOutputMintHex = toHex(leg.outputMint);
                        if (inputMintPlaceholder && inputMintB58 !== '11111111111111111111111111111111') {
                            try {
                                persistedInputMintHex = toHex(bs58.decode(inputMintB58));
                            } catch {
                                // Keep placeholder hex on decode failure
                            }
                        }
                        if (outputMintPlaceholder && outputMintB58 !== '11111111111111111111111111111111') {
                            try {
                                persistedOutputMintHex = toHex(bs58.decode(outputMintB58));
                            } catch {
                                // Keep placeholder hex on decode failure
                            }
                        }

                        enqueueWrite(() =>
                            stmtSwap.run(
                                sessionId,
                                confirmTs,
                                slot,
                                signature,
                                venueName,
                                toHex(leg.pool),
                                leg.direction,
                                persistedInputMintHex,
                                persistedOutputMintHex,
                                String(leg.inputAmount),
                                String(leg.minOutputAmount),
                                actualOutput,
                                txFeeLamports,
                                1, // decode_success
                                legIndex // instruction_index
                            )
                        );
                        stats.plane7_swaps++;
                    }
                }
            }
        } catch (swapErr: any) {
            // Don't fail the whole tx capture on swap decode error
            // Track for L2-001 funnel visibility
            stats.plane7_decodeErrors++;
            DEBUG && console.error(`[swap] Decode error: ${swapErr?.message ?? swapErr}`);
        }
    });

    txStream.on('error', (err: any) => {
        if (err.code !== 1) {
            console.error('[capture] TX stream error:', err.message);
        }
    });

    // Progress reporting with guardrails
    const MAX_RSS_BYTES = 5 * 1024 * 1024 * 1024; // 5GB hard limit
    const SLOT_STALE_MS = 30000; // 30s without new slot = zombie warning
    const P1_STALL_MS = 30000; // 30s without P1 growth triggers diagnostics

    // Event loop delay monitor for stall diagnostics
    const eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();

    let lastP1Count = 0;
    let lastP1CheckAt = Date.now();
    let lastProgressAt = Date.now();  // Track when progress callback last ran
    let progressCallbackCount = 0;

    // Heartbeat interval (separate from progress, more frequent for forensics)
    let heartbeatCount = 0;
    const heartbeatInterval = setInterval(() => {
        // Tick watchdog to prove main thread is alive
        tickWatchdog();
        heartbeatCount++;

        // Periodic PASSIVE checkpoint every ~60s (30 heartbeats at 2s interval)
        // Keeps WAL file manageable during long captures without blocking writers
        // DIAGNOSTIC: Set SKIP_CHECKPOINT=1 to disable and test if this causes hangs
        if (heartbeatCount % 30 === 0 && !process.env.SKIP_CHECKPOINT) {
            trackOp('checkpoint_start', `hb=${heartbeatCount}`);
            const ckptStart = Date.now();
            try {
                db.pragma('wal_checkpoint(PASSIVE)');
                const ckptDur = Date.now() - ckptStart;
                trackOp('checkpoint_done', `dur=${ckptDur}ms`);
                if (ckptDur > 100) {
                    console.warn(`[checkpoint] PASSIVE took ${ckptDur}ms at heartbeat ${heartbeatCount}`);
                }
            } catch (err: any) {
                trackOp('checkpoint_error', err?.message ?? 'unknown');
                DEBUG && console.warn('[checkpoint] PASSIVE failed:', err?.message);
            }
        }

        const elapsed = (Date.now() - stats.startTime) / 1000;
        const rss = process.memoryUsage().rss;
        const eldP99 = eld.percentile(99) / 1e6;  // Convert ns to ms

        // Calculate gRPC stream staleness
        const grpcStaleMs = lastP1At > 0 ? Date.now() - lastP1At : 0;

        // Get gRPC entry point metrics for hang localization
        const grpcMetrics = grpcConsumer.getMetrics();
        const grpcEntryStaleness = grpcMetrics.lastGrpcEntryTs > 0 ? Date.now() - grpcMetrics.lastGrpcEntryTs : 0;

        // Warn if gRPC stream appears stale (no data for 10s)
        if (grpcStaleMs > 10000 && stats.plane1_updates > 0) {
            console.warn(`[GRPC-STALE] No gRPC data for ${(grpcStaleMs / 1000).toFixed(1)}s - stream may be hung`);
        }

        updateHeartbeat({
            elapsed,
            phase: 'capturing',
            lastProgressAt,
            lastP1At,
            p1Count: stats.plane1_updates,
            p2Count: stats.plane2_traces,
            p3Count: stats.plane3_shreds,
            p4Count: stats.plane4_txs,
            writeQueueSize: writeQueue.length,
            eventLoopLagMs: eldP99,
            rssBytes: rss,
            activeRpcCalls: 0,  // Would need to track this from handler
            lastSlot: lastSlotSeen,
            lastFlushDurationMs,
            maxFlushDurationMs,
            flushCount,
            grpcLastDataAt: lastP1At,
            grpcStaleMs,
            // gRPC entry point tracking - shows if freeze is before/during handleResponse
            grpcEntryTs: grpcMetrics.lastGrpcEntryTs,
            grpcEntrySlot: grpcMetrics.lastGrpcEntrySlot,
            grpcEntryCount: grpcMetrics.grpcEntryCount,
            grpcEntryStaleness,
        });
        writeHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    const progressInterval = setInterval(() => {
        // DIAGNOSTIC: Record callback entry time for interval skip detection
        const callbackEntryTime = Date.now();
        const timeSinceLastProgress = callbackEntryTime - lastProgressAt;

        // DIAGNOSTIC: Detect if interval callback was delayed (event loop blocked)
        if (timeSinceLastProgress > INTERVAL_SKIP_WARN_MS && progressCallbackCount > 0) {
            console.error(`[HANG-DIAG] Progress callback delayed by ${timeSinceLastProgress}ms (expected ~5000ms)`);
            console.error(`[HANG-DIAG] This indicates event loop was blocked!`);
            console.error(`[HANG-DIAG] writeQueue.length=${writeQueue.length}`);
            writeNodeReport('interval_delayed');
        }

        progressCallbackCount++;
        lastProgressAt = callbackEntryTime;

        const elapsed = (Date.now() - stats.startTime) / 1000;
        const rss = process.memoryUsage().rss;
        const rssMB = (rss / 1024 / 1024).toFixed(0);
        const slotAge = Date.now() - lastSlotSeenAt;
        const p1Delta = stats.plane1_updates - lastP1Count;

        // DIAGNOSTIC: Get event loop lag from histogram
        const eldP99 = eld.percentile(99) / 1e6;  // Convert ns to ms
        const eldMax = eld.max / 1e6;

        // Base status line
        let statusLine =
            `[capture ${elapsed.toFixed(0)}s] ` +
            `P1=${stats.plane1_updates} ` +
            `P2=${stats.plane2_traces} ` +
            `P3=${stats.plane3_shreds} ` +
            `P4=${stats.plane4_txs} ` +
            `P5=${stats.plane5_topology} ` +
            `P6=${stats.plane6_frozen} ` +
            `P7=${stats.plane7_swaps} ` +
            `boot=${stats.bootstrap_updates} ` +
            `stream=${stats.stream_events} ` +
            `slots=${stats.slot_consistency} ` +
            `err=${stats.errors} ` +
            `rss=${rssMB}MB`;

        // DIAGNOSTIC: Add lag indicator if event loop is slow
        if (eldP99 > EVENT_LOOP_LAG_WARN_MS) {
            statusLine += ` LAG=${eldP99.toFixed(0)}ms`;
        }

        // DIAGNOSTIC: Add write queue size if backlogged
        if (writeQueue.length > 500) {
            statusLine += ` WQ=${writeQueue.length}`;
        }

        // DIAGNOSTIC: Add max flush duration if significant
        if (maxFlushDurationMs > 50) {
            statusLine += ` maxFlush=${maxFlushDurationMs}ms`;
        }

        // DIAGNOSTIC: Add gRPC staleness if concerning
        const grpcStale = Date.now() - lastP1At;
        if (grpcStale > 5000 && stats.plane1_updates > 0) {
            statusLine += ` grpcStale=${(grpcStale / 1000).toFixed(1)}s`;
        }

        // DIAGNOSTIC: Add canary max delay if there were any blocks
        if (canaryState.maxDelayMs > 100) {
            statusLine += ` canaryMax=${canaryState.maxDelayMs}ms`;
        }
        if (canaryState.blockEvents.length > 0) {
            statusLine += ` blocks=${canaryState.blockEvents.length}`;
        }

        console.log(statusLine);

        // DIAGNOSTIC: Event loop lag warnings
        if (eldP99 > EVENT_LOOP_LAG_FATAL_MS) {
            console.error(`[HANG-DIAG] CRITICAL: Event loop lag ${eldP99.toFixed(0)}ms exceeds ${EVENT_LOOP_LAG_FATAL_MS}ms threshold!`);
            console.error(`[HANG-DIAG] max=${eldMax.toFixed(0)}ms writeQueue=${writeQueue.length}`);
            writeNodeReport('event_loop_lag');
        } else if (eldP99 > EVENT_LOOP_LAG_WARN_MS) {
            console.warn(`[HANG-DIAG] Event loop lag ${eldP99.toFixed(0)}ms (max=${eldMax.toFixed(0)}ms)`);
        }

        // Stall watchdog: if P1 hasn't advanced in P1_STALL_MS, dump a report
        if (stats.plane1_updates === lastP1Count) {
            if (Date.now() - lastP1CheckAt >= P1_STALL_MS) {
                console.error(`[watchdog] P1 stalled for ${P1_STALL_MS / 1000}s; writing diagnostics...`);
                console.error(`[watchdog] writeQueue.length=${writeQueue.length} eldP99=${eldP99.toFixed(0)}ms`);
                try {
                    flushQueue(); // ensure DB not holding long txn
                } catch {
                    // ignore
                }
                writeNodeReport('watchdog');
                try {
                    const handles = (process as any)._getActiveHandles?.() ?? [];
                    console.error(`[watchdog] Active handles: ${handles.length}`);
                    // Log handle types for forensics
                    const handleTypes: Record<string, number> = {};
                    for (const h of handles) {
                        const type = h?.constructor?.name ?? 'unknown';
                        handleTypes[type] = (handleTypes[type] ?? 0) + 1;
                    }
                    console.error(`[watchdog] Handle types: ${JSON.stringify(handleTypes)}`);
                } catch {
                    // ignore
                }
                // Reset timer to avoid repeated spam; continue observing
                lastP1CheckAt = Date.now();
            }
        } else {
            lastP1Count = stats.plane1_updates;
            lastP1CheckAt = Date.now();
        }

        // Capture health snapshot every 10s (every other interval)
        if (Math.floor(elapsed / 5) % 2 === 0) {
            const handlerStats = handler.getStats?.();
            if (handlerStats) {
                try {
                    enqueueWrite(() =>
                        db.prepare(`INSERT INTO health_snapshots
                            (session_id, timestamp, healthy, orphan_buffer_size, orphan_reclaim_rate,
                             orphan_ticks_claimed, orphan_bins_claimed, cache_healthy)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
                            .run(
                                sessionId,
                                Date.now(),
                                handlerStats.cacheHealthy ? 1 : 0,
                                handlerStats.orphanBufferSize ?? 0,
                                handlerStats.orphanReclaimRate ?? 1.0,
                                handlerStats.orphanTicksClaimed ?? 0,
                                handlerStats.orphanBinsClaimed ?? 0,
                                handlerStats.cacheHealthy ? 1 : 0
                            )
                    );
                    stats.health_checks++;
                    if (!handlerStats.cacheHealthy) {
                        stats.health_failures++;
                    }
                } catch (err: any) {
                    if (stats.errors <= 5) {
                        console.error(`[health] Error: ${err?.message ?? err}`);
                    }
                }
            }
        }

        // Guardrail: memory limit
        if (rss > MAX_RSS_BYTES) {
            console.error(`[FATAL] RSS ${rssMB}MB exceeds 5GB limit. Exiting to prevent OOM.`);
            process.exit(1);
        }

        // Guardrail: zombie connection detection
        if (slotAge > SLOT_STALE_MS && stats.plane1_updates > 0) {
            console.warn(`[WARN] No new slot in ${(slotAge / 1000).toFixed(0)}s. gRPC may be stale.`);
        }
    }, 5000);  // Heartbeat every 5s

    // Wait for capture duration (or run indefinitely if CAPTURE_SECONDS === 0)
    if (CAPTURE_SECONDS > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, CAPTURE_SECONDS * 1000));
    } else {
        await new Promise<void>(() => { }); // Run indefinitely
    }

    // ========================================================================
    // SHUTDOWN
    // ========================================================================

    DEBUG && console.log('\n[shutdown] Stopping capture...');
    isCapturing = false;

    // Clear all intervals
    clearInterval(progressInterval);
    clearInterval(heartbeatInterval);
    clearInterval(canaryInterval);
    stopCpuWatchdog();

    // Stop watchdog worker
    stopWatchdogWorker();

    // Update heartbeat for forensics
    updateHeartbeat({ phase: 'shutdown' });
    writeHeartbeat();

    txStream.cancel();
    await shredConsumer.stop();
    await grpcConsumer.stop();

    // Detach handlers to prevent late events from touching a closed DB
    grpcConsumer.onContinuityEvent(() => { /* detached */ });
    shredConsumer.onContinuityEvent(() => { /* detached */ });
    setBootstrapHandler(null);

    // Update session with final stats and commit immediately
    enqueueWrite(() =>
        db.prepare(`UPDATE capture_sessions SET ended_at = ?, stats_json = ? WHERE id = ?`)
            .run(Date.now(), JSON.stringify(stats), sessionId)
    );
    flushQueue();

    // Print summary BEFORE heavy validation so the run isn't "silent"
    console.log(`Capture complete after ${CAPTURE_SECONDS} seconds`);

    console.log('\n' + '='.repeat(70));
    console.log('CAPTURE COMPLETE');
    console.log('='.repeat(70));
    console.log(`Session:           ${sessionId}`);
    console.log(`Script Hash:       ${scriptHash}`);
    console.log(`Duration:          ${CAPTURE_SECONDS}s`);
    console.log('');
    console.log('CAPTURED DATA:');
    console.log(`  Plane 1 (Mainnet Updates):   ${stats.plane1_updates}`);
    console.log(`  Plane 2 (Cache Traces):      ${stats.plane2_traces}`);
    console.log(`  Plane 3 (Pending Shreds):    ${stats.plane3_shreds}`);
    console.log(`  Plane 4 (Confirmed Txs):     ${stats.plane4_txs}`);
    console.log(`  Plane 5 (Topology Events):   ${stats.plane5_topology}`);
    console.log(`  Plane 6 (Frozen Topologies): ${stats.plane6_frozen}`);
    console.log(`  Plane 7 (Parsed Swaps):      ${stats.plane7_swaps}`);
    console.log(`  Bootstrap Updates:           ${stats.bootstrap_updates}`);
    console.log(`  Stream Events:               ${stats.stream_events}`);
    console.log(`  Slot Consistency Probes:     ${stats.slot_consistency}`);
    console.log('');
    // L2-001: Track decode gaps for TRUE_COVERAGE analysis
    console.log('DECODE FUNNEL (L2-001):');
    console.log(`  Confirmed Txs (P4):          ${stats.plane4_txs}`);
    console.log(`  ├─ Not swap (legitimate):    ${stats.plane7_notSwap}`);
    console.log(`  ├─ Decode errors (bugs):     ${stats.plane7_decodeErrors}`);
    console.log(`  └─ Parsed swaps (P7):        ${stats.plane7_swaps}`);
    console.log(`     └─ No output found:       ${stats.plane7_noOutput}`);
    const swapRate = stats.plane4_txs > 0 ? (stats.plane7_swaps / stats.plane4_txs * 100).toFixed(1) : '0';
    const outputRate = stats.plane7_swaps > 0 ? ((stats.plane7_swaps - stats.plane7_noOutput) / stats.plane7_swaps * 100).toFixed(1) : '0';
    console.log(`  Swap detection rate:         ${swapRate}%`);
    console.log(`  Output extraction rate:      ${outputRate}%`);
    console.log('');
    console.log(`Errors:            ${stats.errors}`);
    console.log(`Database:          ${SQLITE_FILE}`);
    console.log('='.repeat(70));

    // Run validation only if explicitly enabled
    if (RUN_VALIDATION) {
        console.log('[shutdown] RUN_VALIDATION=1 set - running validation...');
        runValidation(db, sessionId, enqueueWrite);
        flushQueue();
    } else {
        console.log('[shutdown] RUN_VALIDATION not set - skipping validation step');
    }

    // Flush any remaining queued writes before closing
    flushQueue();

    // Final TRUNCATE checkpoint to shrink WAL file
    try {
        db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err: any) {
        console.warn('[shutdown] TRUNCATE checkpoint failed:', err?.message);
    }

    // Integrity check before close
    try {
        const checkResult = db.pragma('quick_check') as any[];
        if (checkResult[0]?.quick_check !== 'ok') {
            console.error('[shutdown] Database integrity check FAILED:', checkResult);
        } else {
            DEBUG && console.log('[shutdown] Database integrity check: OK');
        }
    } catch (err: any) {
        console.error('[shutdown] Integrity check error:', err?.message);
    }

    // Close database (already written to disk via WAL)
    db.close();

    // Release single-run lock
    releaseLock();

    // Final safety: mark that session ended at least once
    process.env.__CAPTURE_ENDED = '1';
}

main().catch((err) => {
    // On fatal error, try to write node report
    writeNodeReport('main_catch');
    releaseLock();
    console.error('Capture failed:', err);
    process.exit(1);
});
