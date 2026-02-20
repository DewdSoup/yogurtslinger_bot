/**
 * Jito Bundle Submission (Phase 8)
 *
 * Submits bundles to Jito block engine via gRPC using jito-ts SDK.
 * Handles retry logic and result tracking.
 */

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { searcherClient as createSearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import { Bundle } from 'jito-ts/dist/sdk/block-engine/types.js';
import type { SearcherClient } from 'jito-ts/dist/sdk/block-engine/searcher.js';
import type { BundleResult } from '../types.js';
import type { BundleRequest, JitoConfig } from './types.js';

export type BundleResultState = 'accepted' | 'rejected' | 'processed' | 'finalized' | 'dropped';

export interface BundleResultEvent {
    bundleId: string;
    state: BundleResultState;
    slot?: number;
    validatorIdentity?: string;
    reason?: string;
}

export class JitoClient {
    private config: JitoConfig;
    private client: SearcherClient | null = null;
    private bundlesSent = 0n;
    private bundlesLanded = 0n;
    private bundlesFailed = 0n;
    private bundlesAccepted = 0n;
    private bundlesRejected = 0n;
    private bundlesProcessed = 0n;
    private bundlesFinalized = 0n;
    private bundlesDropped = 0n;
    private bundleResultsLoopStarted = false;
    private bundleResultsLoopActive = false;
    private acceptedSeen = new Set<string>();
    private rejectedSeen = new Set<string>();
    private processedSeen = new Set<string>();
    private finalizedSeen = new Set<string>();
    private droppedSeen = new Set<string>();
    private landedSeen = new Set<string>();
    private sentBundleIds = new Set<string>();
    private bundleResultListener?: (event: BundleResultEvent) => void;

    constructor(config: JitoConfig) {
        this.config = config;
    }

    /**
     * Lazily connect to block engine. Call before first submission.
     */
    connect(authKeypair?: Keypair): void {
        if (this.client) return;
        this.client = createSearcherClient(
            this.config.endpoint,
            authKeypair,
        );
    }

    /**
     * Submit bundle to Jito
     */
    async submitBundle(request: BundleRequest): Promise<BundleResult> {
        const startMs = Date.now();

        if (!this.client) {
            return {
                bundleId: '',
                submitted: false,
                error: 'JitoClient not connected — call connect() first',
                latencyMs: Date.now() - startMs,
            };
        }

        try {
            // Deserialize our transactions
            const txs: VersionedTransaction[] = request.transactions.map(bt =>
                VersionedTransaction.deserialize(bt.transaction),
            );

            // Create jito-ts Bundle
            const bundle = new Bundle(txs, txs.length);

            // Send to block engine
            const result = await this.client.sendBundle(bundle);

            if ('value' in result && typeof result.value === 'string') {
                this.bundlesSent++;
                this.sentBundleIds.add(result.value);
                return {
                    bundleId: result.value,
                    submitted: true,
                    latencyMs: Date.now() - startMs,
                };
            }

            // Error case
            this.bundlesFailed++;
            const errMsg = 'error' in result ? String(result.error) : 'Unknown submission error';
            return {
                bundleId: '',
                submitted: false,
                error: errMsg,
                latencyMs: Date.now() - startMs,
            };

        } catch (e) {
            this.bundlesFailed++;
            return {
                bundleId: '',
                submitted: false,
                error: String(e),
                latencyMs: Date.now() - startMs,
            };
        }
    }

    /**
     * Subscribe to bundle results. Call once after connect().
     * Tracks landed bundles via the onBundleResult streaming callback.
     */
    subscribeBundleResults(): void {
        if (!this.client) return;
        if (this.bundleResultsLoopStarted) return;
        this.bundleResultsLoopStarted = true;
        this.bundleResultsLoopActive = true;
        void this.runBundleResultsLoop();
    }

    setBundleResultListener(listener: ((event: BundleResultEvent) => void) | undefined): void {
        this.bundleResultListener = listener;
    }

    private emitBundleResult(event: BundleResultEvent): void {
        try {
            this.bundleResultListener?.(event);
        } catch {}
    }

    private async runBundleResultsLoop(): Promise<void> {
        while (this.bundleResultsLoopActive) {
            if (!this.client) return;
            try {
                for await (const _ of this.client.bundleResults((e: Error) => {
                    console.warn(`[jito] bundle result stream error: ${e.message}`);
                })) {
                    const result = _ as any;
                    const bundleId = typeof result?.bundleId === 'string' ? result.bundleId : '';
                    if (!bundleId || !this.sentBundleIds.has(bundleId)) {
                        if (!this.bundleResultsLoopActive) return;
                        continue;
                    }

                    if (result?.accepted && !this.acceptedSeen.has(bundleId)) {
                        this.acceptedSeen.add(bundleId);
                        this.bundlesAccepted++;
                        this.emitBundleResult({
                            bundleId,
                            state: 'accepted',
                            slot: result.accepted.slot,
                            validatorIdentity: result.accepted.validatorIdentity,
                        });
                    }
                    if (result?.rejected && !this.rejectedSeen.has(bundleId)) {
                        this.rejectedSeen.add(bundleId);
                        this.bundlesRejected++;
                        this.emitBundleResult({
                            bundleId,
                            state: 'rejected',
                            reason: describeRejectedReason(result.rejected),
                        });
                    }
                    if (result?.processed && !this.processedSeen.has(bundleId)) {
                        this.processedSeen.add(bundleId);
                        this.bundlesProcessed++;
                        this.emitBundleResult({
                            bundleId,
                            state: 'processed',
                            slot: result.processed.slot,
                            validatorIdentity: result.processed.validatorIdentity,
                        });
                    }
                    if (result?.finalized && !this.finalizedSeen.has(bundleId)) {
                        this.finalizedSeen.add(bundleId);
                        this.bundlesFinalized++;
                        this.emitBundleResult({
                            bundleId,
                            state: 'finalized',
                            slot: result.finalized.slot,
                            validatorIdentity: result.finalized.validatorIdentity,
                        });
                    }
                    if (result?.dropped && !this.droppedSeen.has(bundleId)) {
                        this.droppedSeen.add(bundleId);
                        this.bundlesDropped++;
                        this.emitBundleResult({
                            bundleId,
                            state: 'dropped',
                            reason: describeDroppedReason(result.dropped?.reason),
                        });
                    }

                    if (
                        !this.landedSeen.has(bundleId) &&
                        result?.finalized
                    ) {
                        this.landedSeen.add(bundleId);
                        this.bundlesLanded++;
                    }
                    if (!this.bundleResultsLoopActive) return;
                }
                if (this.bundleResultsLoopActive) {
                    console.warn('[jito] bundle result stream ended, reconnecting');
                    await sleep(1000);
                }
            } catch (e) {
                if (!this.bundleResultsLoopActive) return;
                console.warn(`[jito] bundle result stream restart after error: ${String(e)}`);
                await sleep(1000);
            }
        }
    }

    /**
     * Submit bundle with retry
     */
    async submitWithRetry(request: BundleRequest): Promise<BundleResult> {
        let lastResult: BundleResult | null = null;

        for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
            const result = await this.submitBundle(request);
            lastResult = result;

            if (result.submitted) {
                return result;
            }

            // Exponential backoff
            const delay = Math.min(100 * Math.pow(2, attempt), 1000);
            await sleep(delay);
        }

        this.bundlesFailed++;
        return lastResult ?? {
            bundleId: '',
            submitted: false,
            error: 'Max retries exceeded',
            latencyMs: 0,
        };
    }

    /**
     * Get submission statistics
     */
    getStats() {
        return {
            bundlesSent: this.bundlesSent,
            bundlesLanded: this.bundlesLanded,
            bundlesFailed: this.bundlesFailed,
            bundlesAccepted: this.bundlesAccepted,
            bundlesRejected: this.bundlesRejected,
            bundlesProcessed: this.bundlesProcessed,
            bundlesFinalized: this.bundlesFinalized,
            bundlesDropped: this.bundlesDropped,
            landingRate: this.bundlesSent > 0n
                ? Number((this.bundlesLanded * 10000n) / this.bundlesSent) / 100
                : 0,
        };
    }
}

/**
 * Create Jito client
 */
export function createJitoClient(config: JitoConfig): JitoClient {
    return new JitoClient(config);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function describeDroppedReason(reason: unknown): string {
    if (reason === 0) return 'BlockhashExpired';
    if (reason === 1) return 'PartiallyProcessed';
    if (reason === 2) return 'NotFinalized';
    return `UnknownDroppedReason(${String(reason)})`;
}

function describeRejectedReason(rejected: any): string {
    if (!rejected) return 'unknown';
    if (rejected.stateAuctionBidRejected) {
        return `stateAuctionBidRejected:${rejected.stateAuctionBidRejected.msg ?? ''}`;
    }
    if (rejected.winningBatchBidRejected) {
        return `winningBatchBidRejected:${rejected.winningBatchBidRejected.msg ?? ''}`;
    }
    if (rejected.simulationFailure) {
        return `simulationFailure:${rejected.simulationFailure.msg ?? ''}`;
    }
    if (rejected.internalError) {
        return `internalError:${rejected.internalError.msg ?? ''}`;
    }
    if (rejected.droppedBundle) {
        return `droppedBundle:${rejected.droppedBundle.msg ?? ''}`;
    }
    return 'unknown';
}
