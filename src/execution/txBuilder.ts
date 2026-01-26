// src/execution/txBuilder.ts
//
// Minimal stub so bot.ts compiles. Real swap wiring will be implemented later.

import { Connection, Keypair, Transaction } from "@solana/web3.js";

export type Venue = "pumpswap" | "raydium" | "meteora";
export type Side = "buy" | "sell";

export class TransactionBuilder {
    constructor(
        private readonly connection: Connection,
        private readonly payer: Keypair
    ) {
        // Mark as used to avoid TS noUnusedLocals / 6138 warnings
        void this.connection;
        void this.payer;
    }

    /**
     * Build a swap transaction for the given venue/pool.
     * Currently returns an empty Transaction as a placeholder so that
     * plumbing compiles without adding any execution logic.
     */
    async buildSwap(
        venue: Venue,
        poolPubkey: string,
        sizeSol: number,
        side: Side
    ): Promise<Transaction> {
        // Placeholder: real swap construction will be wired in later.
        void venue;
        void poolPubkey;
        void sizeSol;
        void side;

        const tx = new Transaction();
        return tx;
    }
}
