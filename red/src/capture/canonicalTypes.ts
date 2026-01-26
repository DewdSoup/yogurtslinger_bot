// src/capture/canonicalTypes.ts

export type Venue = "pumpswap" | "raydium_v4" | "raydium_clmm" | "meteora_dlmm";

export interface RawAccountStateJson {
    pubkey: string;
    owner: string;
    lamports: string;     // u64 as string
    executable: boolean;
    rentEpoch: string;    // u64 as string
    dataBase64: string;
}

export interface TokenBalanceChangeJson {
    account: string;      // pubkey
    mint: string;
    decimals: number;
    preAmount: string;    // raw integer as string
    postAmount: string;   // raw integer as string
    owner?: string;
    programId?: string;
}

export interface LamportBalanceChangeJson {
    account: string;       // pubkey
    preLamports: string;   // u64 as string
    postLamports: string;  // u64 as string
}

export interface CanonicalSwapCase {
    signature: string;
    slot: number;
    blockTime?: number;

    venue: Venue;
    programId: string;

    // Deterministic, pre-swap bytes for ALL accounts required by the simulator.
    preAccounts: Record<string, RawAccountStateJson>;

    // Optional, but very useful for debugging mismatches.
    // Only include accounts that were updated by this txn (post state bytes).
    postAccounts?: Record<string, RawAccountStateJson>;

    // Truth source for vault deltas, indexed by pubkey (NOT by accountIndex).
    tokenBalances: Record<string, TokenBalanceChangeJson>;
    lamportBalances: Record<string, LamportBalanceChangeJson>;

    // Minimal debug payload (do NOT rely on for semantics)
    // Keep this lean; you can always re-fetch full tx by signature.
    tx: {
        accountKeys: string[]; // flattened list (static + loaded addresses if any)
        err: unknown | null;
        logMessages?: string[];
    };
}
