// src/utils/runConfig.ts
// UNIFIED RUN CONFIGURATION - Single source of truth for run directories
//
// Both ingest.ts and view_markets.ts import from here to ensure
// consistent run directory paths across the system.

import path from "node:path";
import { promises as fs } from "node:fs";

export const RUNS_BASE = path.resolve(process.cwd(), "src", "data", "runs");

// Generate ISO timestamp with dashes instead of colons (filesystem-safe)
function generateRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

// For processes that CREATE runs (ingest.ts)
export function createNewRun(): { runId: string; runDir: string } {
    const runId = generateRunId();
    const runDir = path.join(RUNS_BASE, runId);
    return { runId, runDir };
}

// For processes that READ from existing runs (view_markets.ts)
export async function findLatestRunDir(): Promise<{ runId: string; runDir: string } | null> {
    try {
        const dirs = await fs.readdir(RUNS_BASE);
        const sorted = dirs.filter(d => !d.startsWith(".")).sort().reverse();
        
        for (const dir of sorted) {
            const snapshotPath = path.join(RUNS_BASE, dir, "markets_snapshot.json");
            try {
                await fs.access(snapshotPath);
                return { runId: dir, runDir: path.join(RUNS_BASE, dir) };
            } catch {
                continue;
            }
        }
    } catch {
        // RUNS_BASE doesn't exist
    }
    return null;
}

export async function ensureRunDir(runDir: string): Promise<void> {
    await fs.mkdir(runDir, { recursive: true });
}

export function getRunPath(runDir: string, filename: string): string {
    return path.join(runDir, filename);
}

// Standard filenames
export const RUN_FILES = {
    MARKETS_SNAPSHOT: "markets_snapshot.json",
    MARKETS_EVENTS: "markets_events.jsonl",
    METADATA: "metadata.json",
    LATEST: "latest.json"
} as const;
