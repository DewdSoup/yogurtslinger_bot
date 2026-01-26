/**
 * Execution module types
 */

export {
    Opportunity,
    BundleConfig,
    BundleResult
} from '../types.js';

/** Bundle transaction wrapper */
export interface BundleTransaction {
    transaction: Uint8Array;  // Serialized transaction
    signers: Uint8Array[];    // Required signers (keypairs)
}

/** Bundle submission request */
export interface BundleRequest {
    transactions: BundleTransaction[];
    tipLamports: bigint;
}

/** Jito RPC config */
export interface JitoConfig {
    endpoint: string;
    uuid?: string;
    timeoutMs: number;
    maxRetries: number;
}