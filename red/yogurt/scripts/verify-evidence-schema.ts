#!/usr/bin/env tsx

/**
 * Sprint 1 / S1-T0
 * Evidence Database Schema Verification
 *
 * Validates that the evidence DB contains the minimum schema required for simulation validation:
 *   - mainnet_txs
 *   - parsed_swaps
 *   - cache_traces
 *
 * Supports either:
 *   1) a single combined DB (--db), or
 *   2) split DBs (--swap-db, --cache-db).
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type TableSchema = Record<
    string,
    {
        requiredColumns: Array<{ name: string; type?: string }>;
    }
>;

const DEFAULT_DB_PATH = 'data/evidence/capture.db';

function usage(): string {
    return `
verify-evidence-schema

Usage:
  pnpm verify:evidence --db data/evidence/capture.db
  pnpm verify:evidence --swap-db data/evidence/capture.db --cache-db data/evidence/capture.db
  pnpm verify:evidence --help

Options:
  --db <path>         Combined evidence DB path (default: ${DEFAULT_DB_PATH})
  --swap-db <path>    Swap/tx DB path (if split)
  --cache-db <path>   Cache/topology DB path (if split)
  --strict            Also validate helpful but optional tables (mainnet_updates, frozen_topologies)
  -h, --help          Show this help
`.trim();
}

function parseArgs(argv: string[]): {
    db: string;
    swapDb?: string;
    cacheDb?: string;
    strict: boolean;
    help: boolean;
} {
    const out = {
        db: DEFAULT_DB_PATH,
        swapDb: undefined as string | undefined,
        cacheDb: undefined as string | undefined,
        strict: false,
        help: false,
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--db') out.db = String(argv[++i] ?? '');
        else if (a === '--swap-db') out.swapDb = String(argv[++i] ?? '');
        else if (a === '--cache-db') out.cacheDb = String(argv[++i] ?? '');
        else if (a === '--strict') out.strict = true;
        else if (a === '-h' || a === '--help') out.help = true;
        else {
            console.error(`Unknown argument: ${a}`);
            out.help = true;
        }
    }

    return out;
}

function resolveDbPath(dbPath: string): string {
    const p = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    return p;
}

function openDb(dbPath: string): Database.Database {
    const resolved = resolveDbPath(dbPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`DB not found: ${resolved}`);
    }
    return new Database(resolved, { readonly: true, fileMustExist: true });
}

function tableExists(db: Database.Database, tableName: string): boolean {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as
        | { name?: string }
        | undefined;
    return row?.name === tableName;
}

function readColumns(db: Database.Database, tableName: string): Array<{ name: string; type: string }> {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string; type: string }>;
    return rows.map((r) => ({ name: r.name, type: (r.type ?? '').toUpperCase() }));
}

function assertSchema(db: Database.Database, dbLabel: string, schema: TableSchema): void {
    for (const [table, spec] of Object.entries(schema)) {
        if (!tableExists(db, table)) {
            throw new Error(`[${dbLabel}] missing table: ${table}`);
        }
        const cols = readColumns(db, table);
        const byName = new Map(cols.map((c) => [c.name, c.type] as const));

        for (const rc of spec.requiredColumns) {
            const actualType = byName.get(rc.name);
            if (!actualType) throw new Error(`[${dbLabel}] ${table} missing column: ${rc.name}`);
            if (rc.type) {
                const want = rc.type.toUpperCase();
                if (actualType !== want) {
                    throw new Error(`[${dbLabel}] ${table}.${rc.name} type mismatch: want ${want}, got ${actualType}`);
                }
            }
        }
    }
}

function countRows(db: Database.Database, tableName: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get() as { c: number };
    return row.c;
}

function main(): void {
    const opts = parseArgs(process.argv);
    if (opts.help) {
        console.log(usage());
        process.exit(0);
    }

    const combined = opts.db;
    const swapPath = opts.swapDb ?? combined;
    const cachePath = opts.cacheDb ?? combined;

    const swapDb = openDb(swapPath);
    const cacheDb = cachePath === swapPath ? swapDb : openDb(cachePath);

    const swapSchema: TableSchema = {
        mainnet_txs: {
            requiredColumns: [
                { name: 'session_id' },
                { name: 'confirm_ts' },
                { name: 'slot' },
                { name: 'signature' },
                { name: 'accounts_json' },
                // NOTE: despite the column name, capture-evidence stores token balances here.
                { name: 'pre_balances_json' },
                { name: 'post_balances_json' },
            ],
        },
        parsed_swaps: {
            requiredColumns: [
                { name: 'session_id' },
                { name: 'confirm_ts' },
                { name: 'slot' },
                { name: 'signature' },
                { name: 'venue' },
                { name: 'pool_pubkey' },
                { name: 'direction' },
                { name: 'input_mint' },
                { name: 'output_mint' },
                { name: 'input_amount' },
                { name: 'min_output_amount' },
                { name: 'actual_output_amount' },
                { name: 'decode_success' },
            ],
        },
    };

    const cacheSchema: TableSchema = {
        cache_traces: {
            requiredColumns: [
                { name: 'session_id' },
                { name: 'apply_ts' },
                { name: 'cache_type' },
                { name: 'pubkey' },
                { name: 'slot' },
                { name: 'write_version' },
                { name: 'source' },
                { name: 'rejected' },
            ],
        },
    };

    const optionalSchema: TableSchema = {
        frozen_topologies: {
            requiredColumns: [{ name: 'session_id' }, { name: 'pool_pubkey' }, { name: 'venue' }, { name: 'vault_base' }, { name: 'vault_quote' }],
        },
        mainnet_updates: {
            requiredColumns: [{ name: 'session_id' }, { name: 'ingest_ts' }, { name: 'slot' }, { name: 'write_version' }, { name: 'pubkey' }, { name: 'data_b64' }],
        },
    };

    console.log('Evidence Schema Check');
    console.log(`  swap-db : ${resolveDbPath(swapPath)}`);
    console.log(`  cache-db: ${resolveDbPath(cachePath)}`);
    console.log('');

    assertSchema(swapDb, 'swap-db', swapSchema);
    assertSchema(cacheDb, 'cache-db', cacheSchema);

    if (opts.strict) {
        // Optional tables are not required for initial Sprint 1 proof, but are very useful.
        assertSchema(cacheDb, 'cache-db (optional)', optionalSchema);
    }

    console.log('Tables present ✅');
    console.log('');

    const swapTables = Object.keys(swapSchema);
    const cacheTables = Object.keys(cacheSchema);

    for (const t of swapTables) console.log(`  swap-db  ${t}: ${countRows(swapDb, t).toLocaleString()} rows`);
    for (const t of cacheTables) console.log(`  cache-db ${t}: ${countRows(cacheDb, t).toLocaleString()} rows`);

    if (opts.strict) {
        console.log('');
        for (const t of Object.keys(optionalSchema)) {
            if (tableExists(cacheDb, t)) console.log(`  cache-db ${t}: ${countRows(cacheDb, t).toLocaleString()} rows`);
        }
    }

    console.log('');
    console.log('OK');

    if (cacheDb !== swapDb) cacheDb.close();
    swapDb.close();
}

main();
