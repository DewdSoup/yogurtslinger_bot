// src/capture/convertSwapDecodeToCanonical.ts
//
// Converts swap_decode JSON files to canonical test case NDJSON format
// for regression testing.

import fs from "fs";
import path from "path";
import type { CanonicalSwapCase, Venue, RawAccountStateJson, TokenBalanceChangeJson, LamportBalanceChangeJson } from "./canonicalTypes";

// Programs (used for reference)
// const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
// const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

interface TokenChange {
    accountIndex: number;
    account: string;
    mint: string;
    owner: string;
    programId: string;
    preAmount: string;
    postAmount: string;
    change: string;
    decimals: number;
    uiChange: number;
}

interface SwapDecodeCase {
    signature: string;
    slot: number;
    blockTime?: number;
    program: string;
    programId: string;
    input: {
        mint: string;
        amount: string;
        decimals: number;
        account: string;
        owner: string;
    };
    output: {
        mint: string;
        amount: string;
        decimals: number;
        account: string;
        owner: string;
    };
    fee?: number;
    computeUnitsConsumed?: number;
    accounts?: Array<{
        pubkey: string;
        signer: boolean;
        writable: boolean;
        source: string;
    }>;
    logs?: string[];
    tokenChanges?: TokenChange[];
    accountStates?: Record<string, {
        owner: string;
        lamports: number;
        executable: boolean;
        rentEpoch: number;
        data: string;
        dataEncoding: string;
        dataLength: number;
        role?: string;
    }>;
    accountRoles?: Record<string, string>;
}

interface SwapDecodeFile {
    collectedAt: string;
    program: string;
    programId: string;
    cases: SwapDecodeCase[];
}

function ensureDirForFile(p: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
}

function programToVenue(program: string): Venue | null {
    const normalized = program.toLowerCase().replace(/[_-]/g, '');
    if (normalized.includes("clmm")) return "raydium_clmm";
    if (normalized.includes("dlmm")) return "meteora_dlmm";
    if (normalized.includes("raydiumv4") || normalized === "raydium") return "raydium_v4";
    if (normalized.includes("pumpswap")) return "pumpswap";
    return null;
}

function convertCase(c: SwapDecodeCase): CanonicalSwapCase | null {
    const venue = programToVenue(c.program);
    if (!venue) {
        console.log(`  Skipping: unknown program ${c.program}`);
        return null;
    }

    if (!c.accountStates || Object.keys(c.accountStates).length === 0) {
        console.log(`  Skipping: no accountStates for ${c.signature.slice(0, 16)}`);
        return null;
    }

    if (!c.tokenChanges || c.tokenChanges.length === 0) {
        console.log(`  Skipping: no tokenChanges for ${c.signature.slice(0, 16)}`);
        return null;
    }

    // Build preAccounts from accountStates
    const preAccounts: Record<string, RawAccountStateJson> = {};
    for (const [pubkey, state] of Object.entries(c.accountStates)) {
        if (state.dataLength === 0 || !state.data) continue;

        preAccounts[pubkey] = {
            pubkey,
            owner: state.owner,
            lamports: BigInt(state.lamports).toString(),
            executable: state.executable,
            rentEpoch: BigInt(state.rentEpoch ?? 0).toString(),
            dataBase64: state.data, // Already base64 encoded
        };
    }

    if (Object.keys(preAccounts).length === 0) {
        console.log(`  Skipping: no valid preAccounts for ${c.signature.slice(0, 16)}`);
        return null;
    }

    // Build tokenBalances from tokenChanges (has actual pre/post amounts!)
    const tokenBalances: Record<string, TokenBalanceChangeJson> = {};
    for (const tc of c.tokenChanges) {
        tokenBalances[tc.account] = {
            account: tc.account,
            mint: tc.mint,
            decimals: tc.decimals,
            preAmount: tc.preAmount,
            postAmount: tc.postAmount,
            owner: tc.owner,
            programId: tc.programId,
        };
    }

    // Build lamportBalances (simplified - we don't have post lamports in swap_decode)
    const lamportBalances: Record<string, LamportBalanceChangeJson> = {};
    for (const [pubkey, state] of Object.entries(c.accountStates)) {
        lamportBalances[pubkey] = {
            account: pubkey,
            preLamports: BigInt(state.lamports).toString(),
            postLamports: BigInt(state.lamports).toString(), // No change (simplified)
        };
    }

    // Build account keys from accounts array or accountStates
    const accountKeys = c.accounts?.map(a => a.pubkey) ?? Object.keys(c.accountStates);

    const txObj: CanonicalSwapCase["tx"] = {
        accountKeys,
        err: null,
    };
    if (c.logs && c.logs.length > 0) {
        txObj.logMessages = c.logs;
    }

    const canonical: CanonicalSwapCase = {
        signature: c.signature,
        slot: c.slot,
        venue,
        programId: c.programId,
        preAccounts,
        tokenBalances,
        lamportBalances,
        tx: txObj,
    };

    if (typeof c.blockTime === "number") {
        canonical.blockTime = c.blockTime;
    }

    return canonical;
}

async function main() {
    const inputPath = process.argv[2];
    const outputPath = process.argv[3] ?? "./data/canonical_cases.ndjson";

    if (!inputPath) {
        console.error("Usage: pnpm exec ts-node src/capture/convertSwapDecodeToCanonical.ts <swap_decode.json> [output.ndjson]");
        process.exit(1);
    }

    if (!fs.existsSync(inputPath)) {
        console.error(`Input file not found: ${inputPath}`);
        process.exit(1);
    }

    ensureDirForFile(outputPath);

    console.log(`Converting ${inputPath} to ${outputPath}`);

    const data: SwapDecodeFile = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    console.log(`Found ${data.cases.length} cases for program: ${data.program}`);

    // Read existing signatures to avoid duplicates
    const existingSigs = new Set<string>();
    if (fs.existsSync(outputPath)) {
        const existing = fs.readFileSync(outputPath, "utf8");
        for (const line of existing.split("\n")) {
            const s = line.trim();
            if (!s) continue;
            try {
                const obj = JSON.parse(s);
                if (typeof obj?.signature === "string") existingSigs.add(obj.signature);
            } catch {
                // ignore
            }
        }
    }

    const out = fs.createWriteStream(outputPath, { flags: "a" });
    let written = 0;
    let skipped = 0;

    for (const c of data.cases) {
        if (existingSigs.has(c.signature)) {
            skipped++;
            continue;
        }

        const canonical = convertCase(c);
        if (canonical) {
            out.write(JSON.stringify(canonical) + "\n");
            existingSigs.add(c.signature);
            written++;
        } else {
            skipped++;
        }
    }

    out.end();
    console.log(`Done. Written: ${written}, Skipped: ${skipped}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
