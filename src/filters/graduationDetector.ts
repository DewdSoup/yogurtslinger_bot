// src/filters/graduationDetector.ts
// Detects token graduations from Pump.fun to PumpSwap
// Used to identify brand new fragmentation opportunities

import { PublicKey } from "@solana/web3.js";

// Migration authority used for Pump.fun → PumpSwap transitions
const MIGRATION_AUTHORITY = new PublicKey("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");

// PumpSwap program for identifying new pools
const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

export interface GraduationEvent {
    pumpCurve: string;       // Original Pump.fun curve address
    tokenMint: string;        // Token mint address
    pumpSwapPool: string;     // New PumpSwap pool address
    slot: number;             // Slot when graduation occurred
    timestamp: number;        // Timestamp when detected
    signature: string;        // Transaction signature
}

export interface GraduationStats {
    totalGraduations: number;
    recentGraduations: number;  // Last 5 minutes
    graduationsThisHour: number;
    averageIntervalMs: number | null;
}

const MAX_RECENT_GRADUATIONS = 1000;
const RECENT_WINDOW_MS = 5 * 60 * 1000;  // 5 minutes

export class GraduationDetector {
    private graduations = new Map<string, GraduationEvent>();  // tokenMint -> event
    private recentGraduations: GraduationEvent[] = [];          // Time-ordered list
    private graduationTimes: number[] = [];                      // For interval calculation

    /**
     * Check if a transaction involves the migration authority
     * This is a quick filter before deeper parsing
     */
    isGraduationTx(tx: any): boolean {
        const accounts = tx.transaction?.message?.accountKeys || [];
        const staticAccounts = tx.transaction?.message?.staticAccountKeys || [];

        // Check both account formats
        const allAccounts = [...accounts, ...staticAccounts];

        return allAccounts.some((key: any) => {
            const pubkey = key.toBase58?.() ?? key.pubkey?.toBase58?.() ?? key;
            return pubkey === MIGRATION_AUTHORITY.toBase58();
        });
    }

    /**
     * Check if a transaction creates a new PumpSwap pool
     */
    isPumpSwapPoolCreation(tx: any): boolean {
        const accounts = tx.transaction?.message?.accountKeys || [];
        const staticAccounts = tx.transaction?.message?.staticAccountKeys || [];
        const allAccounts = [...accounts, ...staticAccounts];

        // Check if PumpSwap program is involved
        return allAccounts.some((key: any) => {
            const pubkey = key.toBase58?.() ?? key.pubkey?.toBase58?.() ?? key;
            return pubkey === PUMPSWAP_PROGRAM_ID;
        });
    }

    /**
     * Extract graduation event from a transaction
     * Returns null if extraction fails
     */
    extractGraduationEvent(tx: any): GraduationEvent | null {
        try {
            const signature = tx.signature || tx.transaction?.signatures?.[0];
            const slot = tx.slot || 0;

            if (!signature) return null;

            // Parse account keys
            const accounts = tx.transaction?.message?.accountKeys || [];
            const staticAccounts = tx.transaction?.message?.staticAccountKeys || [];
            const allAccounts = [...accounts, ...staticAccounts];

            // Extract pubkeys as strings
            const pubkeys: string[] = allAccounts.map((key: any) =>
                key.toBase58?.() ?? key.pubkey?.toBase58?.() ?? String(key)
            ).filter((k: string) => k && k.length > 0);

            // Look for token mint (usually first non-program account)
            // PumpSwap pools have a specific structure we can identify
            let tokenMint: string | null = null;
            let pumpSwapPool: string | null = null;
            let pumpCurve: string | null = null;

            // Common patterns in graduation txs:
            // - Token mint is referenced early in accounts
            // - PumpSwap pool is one of the created accounts
            // - Pump curve is being closed/migrated

            for (const pubkey of pubkeys) {
                // Skip known programs
                if (pubkey === PUMPSWAP_PROGRAM_ID ||
                    pubkey === MIGRATION_AUTHORITY.toBase58() ||
                    pubkey === "11111111111111111111111111111111" ||
                    pubkey === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
                    continue;
                }

                // First 32+ char account that's not a program is likely the token
                if (!tokenMint && pubkey.length >= 32) {
                    // Could be token mint - mark as candidate
                    tokenMint = pubkey;
                }
            }

            if (!tokenMint) return null;

            const event: GraduationEvent = {
                pumpCurve: pumpCurve || "unknown",
                tokenMint,
                pumpSwapPool: pumpSwapPool || "unknown",
                slot,
                timestamp: Date.now(),
                signature: typeof signature === "string" ? signature : Buffer.from(signature).toString("base64")
            };

            return event;
        } catch (e) {
            console.error("[GraduationDetector] Failed to extract event:", e);
            return null;
        }
    }

    /**
     * Register a graduation event
     * Called when we detect a token graduation
     */
    registerGraduation(event: GraduationEvent): void {
        // Store by token mint (dedup)
        const existing = this.graduations.get(event.tokenMint);
        if (existing) {
            // Update if this is more recent
            if (event.slot > existing.slot) {
                this.graduations.set(event.tokenMint, event);
            }
            return;
        }

        this.graduations.set(event.tokenMint, event);
        this.recentGraduations.push(event);
        this.graduationTimes.push(event.timestamp);

        // Prune old entries
        while (this.recentGraduations.length > MAX_RECENT_GRADUATIONS) {
            this.recentGraduations.shift();
        }
        while (this.graduationTimes.length > MAX_RECENT_GRADUATIONS) {
            this.graduationTimes.shift();
        }
    }

    /**
     * Register a graduation by token mint only
     * Used when we detect a PumpSwap pool for a token
     */
    registerGraduationSimple(tokenMint: string, pumpSwapPool: string, slot: number): void {
        this.registerGraduation({
            pumpCurve: "detected-from-pool",
            tokenMint,
            pumpSwapPool,
            slot,
            timestamp: Date.now(),
            signature: "detected-from-pool"
        });
    }

    /**
     * Check if a token has recently graduated
     */
    isRecentGraduate(tokenMint: string, maxAgeMs: number = RECENT_WINDOW_MS): boolean {
        const event = this.graduations.get(tokenMint);
        if (!event) return false;

        return Date.now() - event.timestamp <= maxAgeMs;
    }

    /**
     * Get graduation event for a token
     */
    getGraduation(tokenMint: string): GraduationEvent | undefined {
        return this.graduations.get(tokenMint);
    }

    /**
     * Get all recent graduations (within time window)
     */
    getRecentGraduations(maxAgeMs: number = RECENT_WINDOW_MS): GraduationEvent[] {
        const cutoff = Date.now() - maxAgeMs;
        return this.recentGraduations.filter(e => e.timestamp >= cutoff);
    }

    /**
     * Get all known graduations
     */
    getAllGraduations(): GraduationEvent[] {
        return Array.from(this.graduations.values());
    }

    /**
     * Get statistics about graduations
     */
    getStats(): GraduationStats {
        const now = Date.now();
        const recentCount = this.recentGraduations.filter(
            e => now - e.timestamp < RECENT_WINDOW_MS
        ).length;
        const hourCount = this.recentGraduations.filter(
            e => now - e.timestamp < 60 * 60 * 1000
        ).length;

        // Calculate average interval between graduations
        let avgInterval: number | null = null;
        if (this.graduationTimes.length >= 2) {
            const intervals: number[] = [];
            for (let i = 1; i < this.graduationTimes.length; i++) {
                intervals.push(this.graduationTimes[i]! - this.graduationTimes[i - 1]!);
            }
            avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
        }

        return {
            totalGraduations: this.graduations.size,
            recentGraduations: recentCount,
            graduationsThisHour: hourCount,
            averageIntervalMs: avgInterval
        };
    }

    /**
     * Clear old graduations to free memory
     */
    pruneOld(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        for (const [tokenMint, event] of this.graduations) {
            if (event.timestamp < cutoff) {
                this.graduations.delete(tokenMint);
                removed++;
            }
        }

        this.recentGraduations = this.recentGraduations.filter(
            e => e.timestamp >= cutoff
        );

        return removed;
    }
}

// Singleton instance for global use
export const graduationDetector = new GraduationDetector();

export default GraduationDetector;