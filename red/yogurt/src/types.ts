/**
 * Core type definitions for yogurt baseline pipeline
 * These interfaces define module boundaries and phase contracts
 */

// ============================================================================
// VENUE IDENTIFIERS
// ============================================================================

export const VenueId = {
    PumpSwap: 0,
    RaydiumV4: 1,
    RaydiumClmm: 2,
    MeteoraDlmm: 3,
} as const;

export type VenueId = (typeof VenueId)[keyof typeof VenueId];

export const PROGRAM_IDS: Record<VenueId, string> = {
    [VenueId.PumpSwap]: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    [VenueId.RaydiumV4]: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    [VenueId.RaydiumClmm]: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    [VenueId.MeteoraDlmm]: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
};

// ============================================================================
// INGEST TYPES (Phase 1, Phase 4)
// ============================================================================

/** Raw account update from gRPC confirmed stream */
export interface AccountUpdate {
    slot: number;
    writeVersion: bigint;
    pubkey: Uint8Array;    // 32 bytes
    owner: Uint8Array;     // 32 bytes
    data: Uint8Array;
    lamports: bigint;
}

/** Raw transaction from gRPC or ShredStream */
export interface TxUpdate {
    slot: number;
    signature: Uint8Array; // 64 bytes
    isVote: boolean;
    message: Uint8Array;   // Raw message bytes
    meta?: TxMeta;         // Present only for confirmed
}

export interface TxMeta {
    err: boolean;
    fee: bigint;
    preBalances: bigint[];
    postBalances: bigint[];
    preTokenBalances: TokenBalance[];
    postTokenBalances: TokenBalance[];
    innerInstructions: InnerInstruction[];
}

export interface TokenBalance {
    accountIndex: number;
    mint: Uint8Array;
    owner: Uint8Array;
    amount: bigint;
    decimals: number;
}

export interface InnerInstruction {
    index: number;
    instructions: CompiledInstruction[];
}

export interface CompiledInstruction {
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array;
}

/** Union type for ingest events */
export type IngestEvent =
    | { type: 'account'; update: AccountUpdate; ingestTimestampMs?: number }
    | { type: 'tx'; update: TxUpdate; source: 'confirmed' | 'pending'; ingestTimestampMs?: number };

// ============================================================================
// CACHE TYPES (Phase 2, Phase 3, Phase 4)
// ============================================================================

/** Wrapper for cached entries with metadata */
export interface CacheEntry<T> {
    state: T;
    slot: number;
    writeVersion: bigint;
    updatedAtNs: bigint;   // process.hrtime.bigint()
    /** Phase 2: Source of update for convergence validation */
    source?: 'grpc' | 'bootstrap';
}

// --- Pool State Types ---

export interface PumpSwapPool {
    venue: typeof VenueId.PumpSwap;
    pool: Uint8Array;
    baseMint: Uint8Array;
    quoteMint: Uint8Array;
    baseVault: Uint8Array;
    quoteVault: Uint8Array;
    lpMint: Uint8Array;
    lpSupply: bigint;
    // Note: reserves come from vault token accounts, not pool state
    // Fees come from GlobalConfig, not pool state
    // Runtime-injected fields (from vault balances and config)
    baseReserve?: bigint;
    quoteReserve?: bigint;
    lpFeeBps?: bigint;
    protocolFeeBps?: bigint;
}

export interface RaydiumV4Pool {
    venue: typeof VenueId.RaydiumV4;
    pool: Uint8Array;
    baseMint: Uint8Array;
    quoteMint: Uint8Array;
    baseVault: Uint8Array;
    quoteVault: Uint8Array;
    lpMint: Uint8Array;
    openOrders: Uint8Array;
    targetOrders: Uint8Array;
    nonce: number;
    baseDecimal: number;
    quoteDecimal: number;
    status: bigint;
    // Fee from pool account
    swapFeeNumerator: bigint;
    swapFeeDenominator: bigint;
    // PnL adjustments (subtract from vault balances for true reserves)
    baseNeedTakePnl: bigint;
    quoteNeedTakePnl: bigint;
    // Runtime-injected fields (from vault balances)
    baseReserve?: bigint;
    quoteReserve?: bigint;
    // Computed fee fields (derived from numerator/denominator)
    lpFeeBps?: bigint;
    protocolFeeBps?: bigint;
}

export interface RaydiumClmmPool {
    venue: typeof VenueId.RaydiumClmm;
    pool: Uint8Array;
    ammConfig: Uint8Array;
    tokenMint0: Uint8Array;
    tokenMint1: Uint8Array;
    tokenVault0: Uint8Array;
    tokenVault1: Uint8Array;
    sqrtPriceX64: bigint;
    liquidity: bigint;
    tickCurrent: number;
    tickSpacing: number;
    mintDecimals0: number;
    mintDecimals1: number;
    status: number;
    /**
     * Tick array initialization bitmap (1024 bits = 16 × u64)
     * Each bit represents a tick array. Bit=1 means initialized.
     * Covers tick arrays from -512 to +511 relative to center (0).
     * For tick arrays outside this range, need TickArrayBitmapExtension account.
     */
    tickArrayBitmap: BigUint64Array;
    // Fee rate from ammConfig account (Phase 5)
    // Runtime-injected from ammConfig
    feeRate?: bigint;  // In basis points
}

export interface MeteoraDlmmPool {
    venue: typeof VenueId.MeteoraDlmm;
    pool: Uint8Array;
    tokenXMint: Uint8Array;
    tokenYMint: Uint8Array;
    vaultX: Uint8Array;
    vaultY: Uint8Array;
    binStep: number;
    activeId: number;
    // Fee params
    baseFactor: bigint;
    protocolShare: bigint;
    // Variable fee params (needed for dynamic fee calc)
    volatilityAccumulator: number;
    volatilityReference: number;
    variableFeeFactor?: bigint;  // For dynamic fee calculation
    // Status
    status: number;
    /**
     * Bin array initialization bitmap (1024 bits = 16 × i64)
     * Each bit represents a bin array's initialization status.
     * Covers bin arrays from index -512 to +511 relative to center.
     * For bin arrays outside this range, need BinArrayBitmapExtension account.
     */
    binArrayBitmap: BigInt64Array;
}

export type PoolState = PumpSwapPool | RaydiumV4Pool | RaydiumClmmPool | MeteoraDlmmPool;

// --- Dependency Types (Phase 3) ---

export interface TickArrayKey {
    pool: Uint8Array;
    startTickIndex: number;
}

export interface TickArray {
    poolId: Uint8Array;       // from decoder
    startTickIndex: number;
    ticks: Tick[];
}

export interface Tick {
    tick: number;             // i32 tick index
    liquidityNet: bigint;     // i128 - change when crossing
    liquidityGross: bigint;   // u128 - total liquidity at tick
    initialized: boolean;     // derived: liquidityGross !== 0n
}

export interface BinArrayKey {
    pool: Uint8Array;
    index: number;
}

export interface BinArray {
    lbPair: Uint8Array;       // pool pubkey
    index: bigint;            // i64 array index
    startBinId: number;       // index * 70
    bins: Bin[];
}

export interface Bin {
    amountX: bigint;          // u64
    amountY: bigint;          // u64
}

// --- ALT Types (Phase 4) ---

export interface AddressLookupTable {
    pubkey: Uint8Array;
    addresses: Uint8Array[];
    slot: number;
}

// ============================================================================
// DECODE TYPES (Phase 5)
// ============================================================================

/** Direction of swap */
export const SwapDirection = {
    AtoB: 0,
    BtoA: 1,
} as const;

export type SwapDirection = (typeof SwapDirection)[keyof typeof SwapDirection];

/**
 * Decoded swap instruction
 *
 * IMPORTANT: PumpSwap BUY vs SELL have different semantics:
 *
 * SELL (AtoB): User specifies EXACT input, accepts minimum output
 *   - inputAmount: EXACT (user sends exactly this)
 *   - minOutputAmount: MINIMUM (user accepts at least this)
 *   - exactSide: 'input'
 *
 * BUY (BtoA): User specifies EXACT output, accepts maximum input
 *   - inputAmount: MAXIMUM (user pays at most this, usually less)
 *   - minOutputAmount: EXACT (user receives exactly this)
 *   - exactSide: 'output'
 *
 * For Layer 3 victim simulation:
 *   - If exactSide === 'input': simulate forward (input → output)
 *   - If exactSide === 'output': back-calculate input from desired output
 */
export interface SwapLeg {
    venue: VenueId;
    pool: Uint8Array;
    direction: SwapDirection;
    inputMint: Uint8Array;
    outputMint: Uint8Array;
    inputAmount: bigint;
    minOutputAmount: bigint;
    /**
     * Which side has the EXACT amount (not slippage-protected):
     * - 'input': inputAmount is exact (SELL instruction)
     * - 'output': minOutputAmount is exact (BUY instruction)
     *
     * This determines how to simulate the swap:
     * - exactSide='input': calculate output from input
     * - exactSide='output': back-calculate input from desired output
     *
     * Optional for now - only PumpSwap provides this field.
     * Other venues will be updated when we work on them.
     */
    exactSide?: 'input' | 'output';
    /** Raydium CLMM: sqrt price limit (u128, Q64). 0 = no limit. */
    sqrtPriceLimitX64?: bigint;
    /** Vault pubkeys from swap instruction (for reserve lookup) */
    baseVault?: Uint8Array;
    quoteVault?: Uint8Array;
}

/** Decoded transaction with swap legs */
export interface DecodedTx {
    signature: Uint8Array;
    slot: number;
    payer: Uint8Array;
    legs: SwapLeg[];
    accountKeys: Uint8Array[];  // Resolved (including ALT)
}

// ============================================================================
// SIMULATION TYPES (Phase 5)
// ============================================================================

export interface SimInput {
    pool: Uint8Array;
    venue: VenueId;
    direction: SwapDirection;
    inputAmount: bigint;
    poolState: PoolState;
    tickArrays?: TickArray[];   // For CLMM
    binArrays?: BinArray[];     // For DLMM
    /** Raydium CLMM: sqrt price limit (u128, Q64). 0/undefined = use protocol bounds. */
    sqrtPriceLimitX64?: bigint;
}

export interface SimResult {
    success: boolean;
    outputAmount: bigint;
    newPoolState: PoolState;
    priceImpactBps: number;
    feePaid: bigint;
    error?: ErrorClass;
    latencyUs: number;
}

/** Multi-leg simulation result */
export interface MultiSimResult {
    success: boolean;
    legs: SimResult[];
    netInput: bigint;
    netOutput: bigint;
    totalLatencyUs: number;
}

// ============================================================================
// ERROR TYPES (Phase 6)
// ============================================================================

export const ErrorClass = {
    Slippage: 'SLIPPAGE',
    InsufficientLiquidity: 'INSUFFICIENT_LIQUIDITY',
    StaleState: 'STALE_STATE',
    InvalidAccount: 'INVALID_ACCOUNT',
    InsufficientFunds: 'INSUFFICIENT_FUNDS',
    MathOverflow: 'MATH_OVERFLOW',
    Unknown: 'UNKNOWN',
} as const;

export type ErrorClass = (typeof ErrorClass)[keyof typeof ErrorClass];

export interface ClassifiedError {
    class: ErrorClass;
    programId: Uint8Array;
    errorCode?: number;
    rawHex?: string;
    message?: string;
}

// ============================================================================
// EXECUTION TYPES (Phase 8)
// ============================================================================

/** Opportunity ready for execution */
export interface Opportunity {
    id: bigint;                  // Unique ID for tracing
    pool: Uint8Array;
    venue: VenueId;
    direction: SwapDirection;
    inputMint: Uint8Array;
    outputMint: Uint8Array;
    inputAmount: bigint;
    expectedOutput: bigint;
    minOutput: bigint;           // After slippage tolerance
    slotDeadline: number;
    triggerTxSignature: Uint8Array;  // Pending tx that triggered this
    simLatencyUs: number;
    createdAtNs: bigint;
}

/** Bundle construction config */
export interface BundleConfig {
    tipLamports: bigint;
    computeUnitLimit: number;
    computeUnitPrice: bigint;
    maxRetries: number;
    timeoutMs: number;
}

/** Submission result */
export interface BundleResult {
    bundleId: string;
    submitted: boolean;
    landed?: boolean;
    slot?: number;
    error?: string;
    latencyMs: number;
}

// ============================================================================
// INSTRUMENTATION TYPES (Phase 7)
// ============================================================================

/** Timing trace for a single pending tx path */
export interface TimingTrace {
    signature: Uint8Array;
    t0_recvNs: bigint;           // Shred/gRPC recv
    t1_decodeNs: bigint;         // Decode complete
    t2_simNs: bigint;            // Sim complete
    t3_decisionNs: bigint;       // Decision made
    t4_bundleNs?: bigint;        // Bundle ready (if opportunity)
    isOpportunity: boolean;
}

export interface LatencyHistogram {
    count: number;
    p50Us: number;
    p95Us: number;
    p99Us: number;
    maxUs: number;
}

export interface Metrics {
    // Phase 1
    accountUpdatesReceived: bigint;
    accountUpdatesProcessed: bigint;
    backpressureDrops: bigint;
    orderingViolations: bigint;

    // Phase 2
    decodeSuccessCount: bigint;
    decodeFailureCount: bigint;
    cacheSize: number;

    // Phase 4
    altHits: bigint;
    altMisses: bigint;
    pendingTxsReceived: bigint;
    pendingTxsDecoded: bigint;

    // Phase 5
    simsExecuted: bigint;
    simsSucceeded: bigint;
    simsFailed: bigint;
    multiHopCount: bigint;

    // Phase 6
    errorsClassified: bigint;
    errorsUnknown: bigint;

    // Phase 7
    decodeLatency: LatencyHistogram;
    simLatency: LatencyHistogram;
    decisionLatency: LatencyHistogram;
    bundleLatency: LatencyHistogram;
    totalLatency: LatencyHistogram;

    // Phase 8
    bundlesSubmitted: bigint;
    bundlesLanded: bigint;
    bundlesFailed: bigint;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

/** Buffer pool for zero-allocation hot path */
export interface BufferPool {
    acquire(size: number): Uint8Array;
    release(buf: Uint8Array): void;
    stats(): { allocated: number; available: number; maxSize: number };
}

/** Pubkey comparison without base58 encoding */
export function pubkeyEquals(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== 32 || b.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

/** Convert Uint8Array to hex for logging (not hot path) */
export function toHex(buf: Uint8Array): string {
    return Buffer.from(buf).toString('hex');
}