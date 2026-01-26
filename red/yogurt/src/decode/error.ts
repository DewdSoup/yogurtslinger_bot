/**
 * Program Error Decoder (Phase 6)
 * 
 * Decodes and classifies program errors from:
 * - Simulation failures
 * - Execution failures
 * - Transaction meta
 * 
 * Gate requirements:
 * - Classification rate ≥95%
 */

import type { ClassifiedError, ErrorClass, VenueId } from '../types.js';
import { ErrorClass as E, VenueId as V } from '../types.js';

/** Known error codes per venue */
interface ErrorMapping {
    code: number;
    class: ErrorClass;
    message: string;
}

const PUMPSWAP_ERRORS: ErrorMapping[] = [
    { code: 6000, class: E.Slippage, message: 'Slippage exceeded' },
    { code: 6001, class: E.InsufficientLiquidity, message: 'Insufficient liquidity' },
    // TODO: Complete error mappings from IDL
];

const RAYDIUM_V4_ERRORS: ErrorMapping[] = [
    { code: 0, class: E.Slippage, message: 'Slippage tolerance exceeded' },
    { code: 1, class: E.InsufficientLiquidity, message: 'Insufficient output amount' },
    // TODO: Complete error mappings
];

const RAYDIUM_CLMM_ERRORS: ErrorMapping[] = [
    // TODO: Complete error mappings from IDL
];

const METEORA_DLMM_ERRORS: ErrorMapping[] = [
    // TODO: Complete error mappings from IDL
];

const ERROR_MAPS: Map<VenueId, ErrorMapping[]> = new Map([
    [V.PumpSwap, PUMPSWAP_ERRORS],
    [V.RaydiumV4, RAYDIUM_V4_ERRORS],
    [V.RaydiumClmm, RAYDIUM_CLMM_ERRORS],
    [V.MeteoraDlmm, METEORA_DLMM_ERRORS],
]);

/**
 * Classify an error from a program
 */
export function classifyError(
    programId: Uint8Array,
    venue: VenueId | null,
    errorData: Uint8Array
): ClassifiedError {
    // Anchor error format: 8-byte discriminator + error code (u32)
    if (errorData.length >= 12) {
        const discriminator = errorData.slice(0, 8);
        const errorCode = new DataView(errorData.buffer, errorData.byteOffset + 8, 4).getUint32(0, true);

        if (venue !== null) {
            const mapping = findErrorMapping(venue, errorCode);
            if (mapping) {
                return {
                    class: mapping.class,
                    programId,
                    errorCode,
                    message: mapping.message,
                };
            }
        }

        // Unknown error code
        return {
            class: E.Unknown,
            programId,
            errorCode,
            rawHex: Buffer.from(errorData).toString('hex'),
        };
    }

    // Non-standard error format
    return {
        class: E.Unknown,
        programId,
        rawHex: Buffer.from(errorData).toString('hex'),
    };
}

/**
 * Parse transaction error from meta
 */
export function parseTransactionError(err: unknown): ClassifiedError {
    // TODO: Handle various error formats
    // - InstructionError
    // - Custom program error
    // - System errors

    return {
        class: E.Unknown,
        programId: new Uint8Array(32),
        rawHex: JSON.stringify(err),
    };
}

/**
 * Classify simulation error
 */
export function classifySimError(
    venue: VenueId,
    errorMessage: string
): ClassifiedError {
    // Pattern matching for common simulation errors
    const msg = errorMessage.toLowerCase();

    if (msg.includes('slippage') || msg.includes('amount out below minimum')) {
        return { class: E.Slippage, programId: new Uint8Array(32), message: errorMessage };
    }

    if (msg.includes('insufficient') || msg.includes('not enough')) {
        return { class: E.InsufficientLiquidity, programId: new Uint8Array(32), message: errorMessage };
    }

    if (msg.includes('overflow')) {
        return { class: E.MathOverflow, programId: new Uint8Array(32), message: errorMessage };
    }

    return { class: E.Unknown, programId: new Uint8Array(32), message: errorMessage };
}

// --- Internal ---

function findErrorMapping(venue: VenueId, code: number): ErrorMapping | null {
    const mappings = ERROR_MAPS.get(venue);
    if (!mappings) return null;
    return mappings.find(m => m.code === code) ?? null;
}