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

export class JitoClient {
    private config: JitoConfig;
    private client: SearcherClient | null = null;
    private bundlesSent = 0n;
    private bundlesLanded = 0n;
    private bundlesFailed = 0n;

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
        this.client.onBundleResult(
            () => { this.bundlesLanded++; },
            () => { /* stream errors are non-fatal */ },
        );
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
