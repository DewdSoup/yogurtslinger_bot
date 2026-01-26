// src/investigate_graduation.ts
//
// Simple helper to inspect a graduated mint on-chain.
// Usage:
//   node dist/investigate_graduation.js <GRADUATED_MINT>

/// <reference types="node" />

// TS doesn't know about dotenv here unless it's installed;
// keep runtime behavior (still imports dotenv) but silence TS.
// @ts-ignore
import dotenv from "dotenv";
import { Connection, PublicKey } from "@solana/web3.js";

dotenv.config();

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";

// Pump program (currently unused, but kept for reference)
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
// Mark as used so TS doesn't complain about 6133
void PUMP_PROGRAM;

function usage(): never {
    console.error(
        "Usage: node dist/investigate_graduation.js <GRADUATED_MINT_PUBKEY>"
    );
    process.exit(1);
}

async function main(): Promise<void> {
    const arg = process.argv[2];
    if (!arg) {
        usage();
    }

    let GRADUATED_MINT: PublicKey;
    try {
        GRADUATED_MINT = new PublicKey(arg);
    } catch (err) {
        console.error(
            "[investigate_graduation] Invalid mint pubkey:",
            (err as Error).message
        );
        usage();
    }

    console.log("[investigate_graduation] RPC_URL =", RPC_URL);
    console.log(
        "[investigate_graduation] Graduated mint =",
        GRADUATED_MINT.toBase58()
    );

    const connection = new Connection(RPC_URL, "confirmed");

    const info = await connection.getParsedAccountInfo(
        GRADUATED_MINT,
        "confirmed"
    );

    console.log(
        "[investigate_graduation] Parsed mint account info:\n",
        JSON.stringify(info.value, null, 2)
    );
}

main().catch((err) => {
    console.error("[investigate_graduation] Fatal error:", err);
    process.exit(1);
});
