/**
 * Transaction Decoder (Phase 4, Phase 5)
 *
 * Handles:
 * - v0 transaction ALT resolution
 * - Legacy transaction parsing
 * - Account key extraction
 * - Instruction parsing
 *
 * Gate requirements:
 * - ALT resolution: ≥99.9% hit rate
 * - Decode latency: p99 < 200μs
 *
 * Design:
 * - Zero-copy where possible
 * - Synchronous hot path (no async in decode)
 * - ALT misses reported but don't block
 */

import type {
    TxUpdate,
    DecodedTx,
    AddressLookupTable,
    CompiledInstruction,
} from '../types.js';

// ============================================================================
// INTERFACES
// ============================================================================

/** ALT cache interface */
export interface AltCache {
    get(pubkey: Uint8Array): AddressLookupTable | null;
    getAsync(pubkey: Uint8Array): Promise<AddressLookupTable | null>;
}

export interface TxDecodeResult {
    success: boolean;
    tx?: DecodedTx;
    error?: string;
    altMisses?: Uint8Array[];  // ALT pubkeys that were missing
}

/** Parsed message header */
interface MessageHeader {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
}

/** Parsed address table lookup */
interface AddressTableLookup {
    accountKey: Uint8Array;
    writableIndexes: number[];
    readonlyIndexes: number[];
}

/** Internal parse result */
interface ParsedMessage {
    header: MessageHeader;
    staticAccountKeys: Uint8Array[];
    recentBlockhash: Uint8Array;
    instructions: ParsedInstruction[];
    addressTableLookups: AddressTableLookup[];
    isVersioned: boolean;
}

interface ParsedInstruction {
    programIdIndex: number;
    accountIndexes: number[];
    data: Uint8Array;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Decode transaction message
 * Resolves ALT addresses for v0 transactions synchronously
 */
export function decodeTx(
    update: TxUpdate,
    altCache: AltCache
): TxDecodeResult {
    const message = update.message;

    if (message.length < 4) {
        return { success: false, error: 'Message too short' };
    }

    // Check version byte
    const firstByte = message[0]!;

    if ((firstByte & 0x80) !== 0) {
        // Versioned transaction (v0)
        const version = firstByte & 0x7f;
        if (version !== 0) {
            return { success: false, error: `Unsupported message version: ${version}` };
        }
        return decodeV0Tx(update, message.slice(1), altCache);
    } else {
        // Legacy transaction
        return decodeLegacyTx(update, message);
    }
}

/**
 * Decode transaction without ALT resolution (for confirmed txs with meta)
 */
export function decodeTxWithLoadedAddresses(
    update: TxUpdate,
    loadedWritable: Uint8Array[],
    loadedReadonly: Uint8Array[]
): TxDecodeResult {
    const message = update.message;

    if (message.length < 4) {
        return { success: false, error: 'Message too short' };
    }

    const firstByte = message[0]!;
    const isVersioned = (firstByte & 0x80) !== 0;
    const msgBytes = isVersioned ? message.slice(1) : message;

    const parsed = parseMessageBody(msgBytes, isVersioned);
    if (!parsed) {
        return { success: false, error: 'Failed to parse message body' };
    }

    // Combine static + loaded addresses
    const accountKeys: Uint8Array[] = [
        ...parsed.staticAccountKeys,
        ...loadedWritable,
        ...loadedReadonly,
    ];

    return buildDecodedTx(update, parsed, accountKeys);
}

// ============================================================================
// V0 DECODER
// ============================================================================

function decodeV0Tx(
    update: TxUpdate,
    messageBody: Uint8Array,
    altCache: AltCache
): TxDecodeResult {
    const parsed = parseMessageBody(messageBody, true);
    if (!parsed) {
        return { success: false, error: 'Failed to parse v0 message body' };
    }

    // Resolve ALT addresses
    const altMisses: Uint8Array[] = [];
    const loadedWritable: Uint8Array[] = [];
    const loadedReadonly: Uint8Array[] = [];

    for (const lookup of parsed.addressTableLookups) {
        const alt = altCache.get(lookup.accountKey);

        if (!alt) {
            altMisses.push(lookup.accountKey);
            continue;
        }

        // Extract writable addresses
        for (const idx of lookup.writableIndexes) {
            if (idx < alt.addresses.length) {
                loadedWritable.push(alt.addresses[idx]!);
            } else {
                return {
                    success: false,
                    error: `ALT index out of bounds: ${idx} >= ${alt.addresses.length}`,
                    altMisses,
                };
            }
        }

        // Extract readonly addresses
        for (const idx of lookup.readonlyIndexes) {
            if (idx < alt.addresses.length) {
                loadedReadonly.push(alt.addresses[idx]!);
            } else {
                return {
                    success: false,
                    error: `ALT index out of bounds: ${idx} >= ${alt.addresses.length}`,
                    altMisses,
                };
            }
        }
    }

    // If we have ALT misses, we can't fully decode
    if (altMisses.length > 0) {
        return {
            success: false,
            error: `Missing ${altMisses.length} ALT(s)`,
            altMisses,
        };
    }

    // Combine static + loaded addresses
    const accountKeys: Uint8Array[] = [
        ...parsed.staticAccountKeys,
        ...loadedWritable,
        ...loadedReadonly,
    ];

    return buildDecodedTx(update, parsed, accountKeys);
}

// ============================================================================
// LEGACY DECODER
// ============================================================================

function decodeLegacyTx(
    update: TxUpdate,
    message: Uint8Array
): TxDecodeResult {
    const parsed = parseMessageBody(message, false);
    if (!parsed) {
        return { success: false, error: 'Failed to parse legacy message' };
    }

    return buildDecodedTx(update, parsed, parsed.staticAccountKeys);
}

// ============================================================================
// MESSAGE PARSER
// ============================================================================

function parseMessageBody(
    data: Uint8Array,
    isVersioned: boolean
): ParsedMessage | null {
    let offset = 0;

    // Header: 3 bytes
    if (data.length < offset + 3) return null;
    const header: MessageHeader = {
        numRequiredSignatures: data[offset]!,
        numReadonlySignedAccounts: data[offset + 1]!,
        numReadonlyUnsignedAccounts: data[offset + 2]!,
    };
    offset += 3;

    // Static account keys: compact-u16 length + 32 bytes each
    const accountKeysResult = readCompactU16(data, offset);
    if (!accountKeysResult) return null;
    const numAccountKeys = accountKeysResult.value;
    offset = accountKeysResult.offset;

    const staticAccountKeys: Uint8Array[] = [];
    for (let i = 0; i < numAccountKeys; i++) {
        if (data.length < offset + 32) return null;
        staticAccountKeys.push(data.slice(offset, offset + 32));
        offset += 32;
    }

    // Recent blockhash: 32 bytes
    if (data.length < offset + 32) return null;
    const recentBlockhash = data.slice(offset, offset + 32);
    offset += 32;

    // Instructions: compact-u16 length + each instruction
    const numInstructionsResult = readCompactU16(data, offset);
    if (!numInstructionsResult) return null;
    const numInstructions = numInstructionsResult.value;
    offset = numInstructionsResult.offset;

    const instructions: ParsedInstruction[] = [];
    for (let i = 0; i < numInstructions; i++) {
        const ixResult = parseInstruction(data, offset);
        if (!ixResult) return null;
        instructions.push(ixResult.instruction);
        offset = ixResult.offset;
    }

    // Address table lookups (v0 only)
    const addressTableLookups: AddressTableLookup[] = [];
    if (isVersioned) {
        const numLookupsResult = readCompactU16(data, offset);
        if (!numLookupsResult) return null;
        const numLookups = numLookupsResult.value;
        offset = numLookupsResult.offset;

        for (let i = 0; i < numLookups; i++) {
            const lookupResult = parseAddressTableLookup(data, offset);
            if (!lookupResult) return null;
            addressTableLookups.push(lookupResult.lookup);
            offset = lookupResult.offset;
        }
    }

    return {
        header,
        staticAccountKeys,
        recentBlockhash,
        instructions,
        addressTableLookups,
        isVersioned,
    };
}

function parseInstruction(
    data: Uint8Array,
    offset: number
): { instruction: ParsedInstruction; offset: number } | null {
    // Program ID index: 1 byte
    if (data.length < offset + 1) return null;
    const programIdIndex = data[offset]!;
    offset += 1;

    // Account indexes: compact-u16 length + bytes
    const numAccountsResult = readCompactU16(data, offset);
    if (!numAccountsResult) return null;
    const numAccounts = numAccountsResult.value;
    offset = numAccountsResult.offset;

    if (data.length < offset + numAccounts) return null;
    const accountIndexes: number[] = [];
    for (let i = 0; i < numAccounts; i++) {
        accountIndexes.push(data[offset + i]!);
    }
    offset += numAccounts;

    // Data: compact-u16 length + bytes
    const dataLenResult = readCompactU16(data, offset);
    if (!dataLenResult) return null;
    const dataLen = dataLenResult.value;
    offset = dataLenResult.offset;

    if (data.length < offset + dataLen) return null;
    const ixData = data.slice(offset, offset + dataLen);
    offset += dataLen;

    return {
        instruction: {
            programIdIndex,
            accountIndexes,
            data: ixData,
        },
        offset,
    };
}

function parseAddressTableLookup(
    data: Uint8Array,
    offset: number
): { lookup: AddressTableLookup; offset: number } | null {
    // Account key: 32 bytes
    if (data.length < offset + 32) return null;
    const accountKey = data.slice(offset, offset + 32);
    offset += 32;

    // Writable indexes: compact-u16 length + bytes
    const numWritableResult = readCompactU16(data, offset);
    if (!numWritableResult) return null;
    const numWritable = numWritableResult.value;
    offset = numWritableResult.offset;

    if (data.length < offset + numWritable) return null;
    const writableIndexes: number[] = [];
    for (let i = 0; i < numWritable; i++) {
        writableIndexes.push(data[offset + i]!);
    }
    offset += numWritable;

    // Readonly indexes: compact-u16 length + bytes
    const numReadonlyResult = readCompactU16(data, offset);
    if (!numReadonlyResult) return null;
    const numReadonly = numReadonlyResult.value;
    offset = numReadonlyResult.offset;

    if (data.length < offset + numReadonly) return null;
    const readonlyIndexes: number[] = [];
    for (let i = 0; i < numReadonly; i++) {
        readonlyIndexes.push(data[offset + i]!);
    }
    offset += numReadonly;

    return {
        lookup: {
            accountKey,
            writableIndexes,
            readonlyIndexes,
        },
        offset,
    };
}

// ============================================================================
// COMPACT-U16
// ============================================================================

function readCompactU16(
    data: Uint8Array,
    offset: number
): { value: number; offset: number } | null {
    if (data.length <= offset) return null;

    const byte0 = data[offset]!;
    if ((byte0 & 0x80) === 0) {
        return { value: byte0, offset: offset + 1 };
    }

    if (data.length <= offset + 1) return null;
    const byte1 = data[offset + 1]!;
    if ((byte1 & 0x80) === 0) {
        const value = (byte0 & 0x7f) | (byte1 << 7);
        return { value, offset: offset + 2 };
    }

    if (data.length <= offset + 2) return null;
    const byte2 = data[offset + 2]!;
    const value = (byte0 & 0x7f) | ((byte1 & 0x7f) << 7) | (byte2 << 14);
    return { value, offset: offset + 3 };
}

// ============================================================================
// RESULT BUILDER
// ============================================================================

function buildDecodedTx(
    update: TxUpdate,
    parsed: ParsedMessage,
    accountKeys: Uint8Array[]
): TxDecodeResult {
    // Convert parsed instructions to CompiledInstruction
    const instructions: CompiledInstruction[] = parsed.instructions.map(ix => ({
        programIdIndex: ix.programIdIndex,
        accountKeyIndexes: ix.accountIndexes,
        data: ix.data,
    }));

    // Determine payer (first signer)
    const payer = accountKeys[0] ?? new Uint8Array(32);

    const tx: DecodedTx = {
        signature: update.signature,
        slot: update.slot,
        payer,
        legs: [], // Populated by swap decoder (Phase 5)
        accountKeys,
    };

    return { success: true, tx };
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

/**
 * Extract account keys from a decoded transaction
 */
export function getAccountKey(
    tx: DecodedTx,
    index: number
): Uint8Array | null {
    if (index < 0 || index >= tx.accountKeys.length) return null;
    return tx.accountKeys[index]!;
}

/**
 * Get program ID for an instruction
 */
export function getInstructionProgramId(
    tx: DecodedTx,
    instruction: CompiledInstruction
): Uint8Array | null {
    return getAccountKey(tx, instruction.programIdIndex);
}

/**
 * Get account keys for an instruction
 */
export function getInstructionAccounts(
    tx: DecodedTx,
    instruction: CompiledInstruction
): Uint8Array[] {
    return instruction.accountKeyIndexes
        .map(idx => getAccountKey(tx, idx))
        .filter((k): k is Uint8Array => k !== null);
}