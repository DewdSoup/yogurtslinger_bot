// src/brain/fragmentationTracker.ts
// Real-time tracking of token fragmentation across venues
//
// PURPOSE:
// - Track when tokens graduate from PumpFun to PumpSwap
// - Detect when tokens become "fragmented" (exist on 2+ venues)
// - Emit events for immediate arb detection on NEW_FRAGMENTATION
// - O(1) lookup for isFragmented() check in hot path
//
// VENUES:
// - pumpSwap: Graduated tokens from PumpFun bonding curve
// - raydiumV4: Raydium AMM V4 pools
// - raydiumClmm: Raydium Concentrated Liquidity pools
// - meteora: Meteora DLMM pools

// ============================================================================
// TYPES
// ============================================================================

export type VenueType = "pumpSwap" | "raydiumV4" | "raydiumClmm" | "meteora";

export interface FragmentationEvent {
    type: "GRADUATION" | "NEW_FRAGMENTATION" | "VENUE_ADDED";
    tokenMint: string;
    venue: VenueType;
    poolPubkey: string;
    slot: bigint;
    allVenues: VenueType[];
    venueCount: number;
    timestamp: number;
}

export interface TokenVenueInfo {
    venue: VenueType;
    poolPubkey: string;
    firstSeenSlot: bigint;
    firstSeenTs: number;
    lastUpdatedSlot: bigint;
    lastUpdatedTs: number;
}

export interface TokenFragmentationState {
    tokenMint: string;
    venues: Map<VenueType, TokenVenueInfo>;
    firstSeenTs: number;
    becameFragmentedTs: number | null;
    becameFragmentedSlot: bigint | null;
}

type EventCallback = (event: FragmentationEvent) => void;

// ============================================================================
// FRAGMENTATION TRACKER
// ============================================================================

class FragmentationTracker {
    // Main state: tokenMint -> fragmentation state
    private readonly tokens = new Map<string, TokenFragmentationState>();

    // O(1) lookup for fragmented tokens (2+ venues)
    private readonly fragmentedTokens = new Set<string>();

    // Event subscribers
    private readonly subscribers: EventCallback[] = [];

    // Stats
    private graduationCount = 0;
    private newFragmentationCount = 0;
    private venueAddedCount = 0;

    // Recent fragmentations (last 60 seconds)
    private readonly recentFragmentations: { tokenMint: string; ts: number }[] = [];
    private readonly RECENT_WINDOW_MS = 60_000;

    /**
     * Record a venue for a token. This is called from ingest.ts when a pool is discovered.
     * 
     * Emits events:
     * - GRADUATION: First time we see a token on PumpSwap (graduated from bonding curve)
     * - NEW_FRAGMENTATION: Token goes from 1 venue to 2+ venues (arb opportunity!)
     * - VENUE_ADDED: Token already fragmented, but another venue added
     */
    recordVenue(
        tokenMint: string,
        venue: VenueType,
        poolPubkey: string,
        slot: bigint
    ): void {
        const now = Date.now();

        let state = this.tokens.get(tokenMint);

        if (!state) {
            // First time seeing this token
            state = {
                tokenMint,
                venues: new Map(),
                firstSeenTs: now,
                becameFragmentedTs: null,
                becameFragmentedSlot: null,
            };
            this.tokens.set(tokenMint, state);
        }

        const existingVenue = state.venues.get(venue);
        const previousVenueCount = state.venues.size;

        if (!existingVenue) {
            // New venue for this token
            state.venues.set(venue, {
                venue,
                poolPubkey,
                firstSeenSlot: slot,
                firstSeenTs: now,
                lastUpdatedSlot: slot,
                lastUpdatedTs: now,
            });

            const newVenueCount = state.venues.size;
            const allVenues = Array.from(state.venues.keys());

            // Check for graduation (first PumpSwap appearance)
            if (venue === "pumpSwap" && previousVenueCount === 0) {
                this.graduationCount++;
                this.emit({
                    type: "GRADUATION",
                    tokenMint,
                    venue,
                    poolPubkey,
                    slot,
                    allVenues,
                    venueCount: newVenueCount,
                    timestamp: now,
                });
            }

            // Check for new fragmentation (1 -> 2 venues)
            if (previousVenueCount === 1 && newVenueCount === 2) {
                state.becameFragmentedTs = now;
                state.becameFragmentedSlot = slot;
                this.fragmentedTokens.add(tokenMint);
                this.newFragmentationCount++;

                // Track recent fragmentation
                this.recentFragmentations.push({ tokenMint, ts: now });
                this.pruneRecentFragmentations();

                this.emit({
                    type: "NEW_FRAGMENTATION",
                    tokenMint,
                    venue,
                    poolPubkey,
                    slot,
                    allVenues,
                    venueCount: newVenueCount,
                    timestamp: now,
                });
            }
            // Additional venue added to already fragmented token
            else if (previousVenueCount >= 2) {
                this.venueAddedCount++;
                this.emit({
                    type: "VENUE_ADDED",
                    tokenMint,
                    venue,
                    poolPubkey,
                    slot,
                    allVenues,
                    venueCount: newVenueCount,
                    timestamp: now,
                });
            }
        } else {
            // Update existing venue
            existingVenue.lastUpdatedSlot = slot;
            existingVenue.lastUpdatedTs = now;
        }
    }

    /**
     * O(1) check if token is fragmented (exists on 2+ venues).
     * Used in hot path for deciding whether to trigger arb detection.
     */
    isFragmented(tokenMint: string): boolean {
        return this.fragmentedTokens.has(tokenMint);
    }

    /**
     * Get all venues for a token.
     */
    getVenues(tokenMint: string): VenueType[] {
        const state = this.tokens.get(tokenMint);
        if (!state) return [];
        return Array.from(state.venues.keys());
    }

    /**
     * Get detailed venue info for a token.
     */
    getVenueInfo(tokenMint: string): TokenVenueInfo[] {
        const state = this.tokens.get(tokenMint);
        if (!state) return [];
        return Array.from(state.venues.values());
    }

    /**
     * Get full fragmentation state for a token.
     */
    getState(tokenMint: string): TokenFragmentationState | undefined {
        return this.tokens.get(tokenMint);
    }

    /**
     * Get all fragmented tokens (2+ venues).
     */
    getAllFragmented(): string[] {
        return Array.from(this.fragmentedTokens);
    }

    /**
     * Get all tokens on a specific venue.
     */
    getTokensOnVenue(venue: VenueType): string[] {
        const result: string[] = [];
        for (const [tokenMint, state] of this.tokens) {
            if (state.venues.has(venue)) {
                result.push(tokenMint);
            }
        }
        return result;
    }

    /**
     * Subscribe to fragmentation events.
     */
    subscribe(callback: EventCallback): void {
        this.subscribers.push(callback);
    }

    /**
     * Unsubscribe from fragmentation events.
     */
    unsubscribe(callback: EventCallback): void {
        const idx = this.subscribers.indexOf(callback);
        if (idx >= 0) {
            this.subscribers.splice(idx, 1);
        }
    }

    /**
     * Get summary stats for logging.
     */
    getSummary(): {
        total: number;
        fragmented: number;
        by2Venues: number;
        by3Venues: number;
        by4Venues: number;
        recentFragmentations: number;
    } {
        let by2 = 0, by3 = 0, by4 = 0;

        for (const tokenMint of this.fragmentedTokens) {
            const state = this.tokens.get(tokenMint);
            if (!state) continue;

            const count = state.venues.size;
            if (count === 2) by2++;
            else if (count === 3) by3++;
            else if (count >= 4) by4++;
        }

        this.pruneRecentFragmentations();

        return {
            total: this.tokens.size,
            fragmented: this.fragmentedTokens.size,
            by2Venues: by2,
            by3Venues: by3,
            by4Venues: by4,
            recentFragmentations: this.recentFragmentations.length,
        };
    }

    /**
     * Get detailed stats.
     */
    getStats(): {
        graduations: number;
        newFragmentations: number;
        venueAdditions: number;
        totalTokens: number;
        fragmentedTokens: number;
        subscriberCount: number;
    } {
        return {
            graduations: this.graduationCount,
            newFragmentations: this.newFragmentationCount,
            venueAdditions: this.venueAddedCount,
            totalTokens: this.tokens.size,
            fragmentedTokens: this.fragmentedTokens.size,
            subscriberCount: this.subscribers.length,
        };
    }

    /**
     * Get tokens that became fragmented in the last N milliseconds.
     */
    getRecentlyFragmented(maxAgeMs: number = 60_000): string[] {
        const cutoff = Date.now() - maxAgeMs;
        const result: string[] = [];

        for (const tokenMint of this.fragmentedTokens) {
            const state = this.tokens.get(tokenMint);
            if (state && state.becameFragmentedTs && state.becameFragmentedTs >= cutoff) {
                result.push(tokenMint);
            }
        }

        return result;
    }

    /**
     * Reset all state (for testing or reconnection).
     */
    reset(): void {
        this.tokens.clear();
        this.fragmentedTokens.clear();
        this.recentFragmentations.length = 0;
        this.graduationCount = 0;
        this.newFragmentationCount = 0;
        this.venueAddedCount = 0;
    }

    // ========================================================================
    // PRIVATE METHODS
    // ========================================================================

    private emit(event: FragmentationEvent): void {
        for (const callback of this.subscribers) {
            try {
                callback(event);
            } catch (err) {
                console.error("[FragmentationTracker] Subscriber error:", err);
            }
        }
    }

    private pruneRecentFragmentations(): void {
        const cutoff = Date.now() - this.RECENT_WINDOW_MS;
        while (this.recentFragmentations.length > 0 && this.recentFragmentations[0]!.ts < cutoff) {
            this.recentFragmentations.shift();
        }
    }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

export const fragmentationTracker = new FragmentationTracker();

export default fragmentationTracker;