// src/execution/executionEngine.ts
// REFACTORED: Added SimGate - RPC-based profit simulation
// This is now the single source of truth for trade validation
// All profit calculation is done via simulateTransaction against local validator
//
// PARSING STRATEGIES (in order of reliability):
// 1. innerInstructions - Parse actual Token Program transfer instruction data
// 2. accountState - Compare pre/post WSOL balance via accounts option
// 3. logs - Pattern match program logs for amounts
// 4. estimate - CPMM math fallback using reserve ratios
//
// Architecture:
// Detection (0ms) -> SimGate (~3-5ms) -> Execute if profitable

import {
    Connection,
    Keypair,
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import { promises as fs } from "node:fs";

import {
    type OpportunityInput,
    type GateConfig,
    DEFAULT_GATE_CONFIG,
    getGateStats,
    incrementStat,
} from "./executionGate.js";

import {
    type CapitalConfig,
    DEFAULT_CONFIG,
    openPosition,
    closePosition,
    getPositionSummary,
    clearAllPositions,
    getPositionCount,
    hasOpenPositionForToken,
    type OpenPosition,
} from "./positionSizer.js";

import {
    type PoolState,
    calculateDynamicTip,
    getConstrainingLiquidity,
    TIP_STRATEGY,
} from "./profitSimulator.js";

import {
    buildArbitrageBundle,
    submitBundleWithRetry,
    waitForBundleConfirmation,
    validateBundle,
    trackBundle,
    getBundleStats,
    type ArbitrageBundle
} from "./jitoBundle.js";

import {
    buildPumpSwapBuyInstruction,
    buildPumpSwapSellInstruction,
    buildMeteoraSwapInstruction,
    getATA,
    SOL_MINT,
    type PumpSwapAccounts,
    type MeteoraAccounts,
} from "./swapBuilder.js";

// ============================================================================
// ENGINE CONFIGURATION
// ============================================================================

export interface EngineConfig {
    walletPath: string;
    rpcEndpoint: string;
    jitoEndpoint: string;
    capitalConfig: CapitalConfig;
    gateConfig: GateConfig;
    dryRun: boolean;
    paperTrade: boolean;
    logDir: string;
    verboseLogging: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    walletPath: "./wallet.json",
    rpcEndpoint: "http://127.0.0.1:8899",
    jitoEndpoint: "https://mainnet.block-engine.jito.wtf",
    capitalConfig: DEFAULT_CONFIG,
    gateConfig: DEFAULT_GATE_CONFIG,
    dryRun: true,
    paperTrade: false,
    logDir: "./logs/execution",
    verboseLogging: true
};

// ============================================================================
// SIMGATE RESULT (RPC Simulation Output)
// ============================================================================

export interface SimGateResult {
    success: boolean;
    tradeSizeLamports: bigint;
    tradeSizeSol: number;
    tokensReceived: bigint;      // From simulation
    solReceived: bigint;         // From simulation
    grossProfitLamports: bigint;
    netProfitLamports: bigint;   // After tip
    netProfitBps: number;
    tipAmountLamports: bigint;
    minTokensOut: bigint;        // With slippage tolerance
    minSolOut: bigint;           // With slippage tolerance
    simulationUnitsConsumed: number;
    parseMethod: "innerInstructions" | "accountState" | "logs" | "estimate";
    error: string | null;
}

// ============================================================================
// EXECUTION RESULT
// ============================================================================

export interface ExecutionResult {
    success: boolean;
    simGateResult: SimGateResult | null;
    bundleId?: string | undefined;
    error?: string | undefined;
    profitLamports?: bigint | undefined;
    executionTimeMs: number;
}

// ============================================================================
// ENGINE STATE
// ============================================================================

interface EngineState {
    initialized: boolean;
    wallet: Keypair | null;
    connection: Connection | null;
    config: EngineConfig;
    startTime: number;
    opportunitiesEvaluated: number;
    simulationsRun: number;
    executionsAttempted: number;
    executionsSuccessful: number;
    totalProfitLamports: bigint;
    totalLossLamports: bigint;
    lastOpportunityTime: number | null;
    lastExecutionTime: number | null;
    lastError: string | null;
}

let state: EngineState = {
    initialized: false,
    wallet: null,
    connection: null,
    config: DEFAULT_ENGINE_CONFIG,
    startTime: Date.now(),
    opportunitiesEvaluated: 0,
    simulationsRun: 0,
    executionsAttempted: 0,
    executionsSuccessful: 0,
    totalProfitLamports: 0n,
    totalLossLamports: 0n,
    lastOpportunityTime: null,
    lastExecutionTime: null,
    lastError: null
};

// ============================================================================
// INITIALIZATION
// ============================================================================

export async function initializeEngine(config: Partial<EngineConfig> = {}): Promise<void> {
    state.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

    try {
        const walletData = await fs.readFile(state.config.walletPath, "utf-8");
        const secretKey = Uint8Array.from(JSON.parse(walletData));
        state.wallet = Keypair.fromSecretKey(secretKey);
        log(`Wallet loaded: ${state.wallet.publicKey.toBase58()}`);
    } catch (error) {
        throw new Error(`Failed to load wallet: ${error}`);
    }

    state.connection = new Connection(state.config.rpcEndpoint, "confirmed");

    try {
        const slot = await state.connection.getSlot();
        log(`Connected to RPC at slot ${slot}`);
    } catch (error) {
        log(`Warning: RPC test failed: ${error}`, "WARN");
    }

    try {
        await fs.mkdir(state.config.logDir, { recursive: true });
    } catch {
        // Directory may exist
    }

    state.initialized = true;
    state.startTime = Date.now();

    log(`Engine initialized in ${state.config.dryRun ? "DRY RUN" : state.config.paperTrade ? "PAPER TRADE" : "LIVE"} mode`);
    log(`SimGate: RPC simulation enabled via ${state.config.rpcEndpoint}`);
}

// ============================================================================
// SIMGATE: RPC-BASED PROFIT SIMULATION
// ============================================================================

/**
 * SimGate: Simulate the arbitrage trade via RPC and return exact profit
 * Uses 4 parsing strategies for maximum reliability
 */
async function simulateAndValidate(
    opportunity: OpportunityInput,
    tradeSizeLamports: bigint,
    isFreshPool: boolean
): Promise<SimGateResult> {
    if (!state.connection || !state.wallet) {
        return createFailedSimResult(tradeSizeLamports, "Engine not initialized", "estimate");
    }

    state.simulationsRun++;
    incrementStat("simulated");

    try {
        const userPubkey = state.wallet.publicKey;

        // Get user's WSOL ATA for balance tracking
        const userWsolAta = getATA(SOL_MINT, userPubkey);

        // Get pre-simulation balance (for delta calculation)
        let preBalance = 0n;
        try {
            const balanceInfo = await state.connection.getTokenAccountBalance(userWsolAta);
            preBalance = BigInt(balanceInfo.value.amount);
        } catch {
            // ATA might not exist yet - that's fine, balance is 0
            preBalance = 0n;
        }

        // STEP 1: Build buy instruction with minOut = 0 (simulation mode)
        const buyInstruction = await buildBuyInstruction(
            opportunity.buyPool,
            userPubkey,
            tradeSizeLamports,
            0n  // minOut = 0 for simulation
        );

        // STEP 2: Build sell instruction with minOut = 0 (simulation mode)
        const sellInstruction = await buildSellInstruction(
            opportunity.sellPool,
            userPubkey,
            0n,  // Will be filled by program
            0n   // minOut = 0 for simulation
        );

        // STEP 3: Create simulation transaction
        const { blockhash } = await state.connection.getLatestBlockhash("confirmed");

        const message = new TransactionMessage({
            payerKey: userPubkey,
            recentBlockhash: blockhash,
            instructions: [buyInstruction, sellInstruction],
        }).compileToV0Message();

        const tx = new VersionedTransaction(message);

        // STEP 4: Run simulation with innerInstructions enabled
        const simResult = await state.connection.simulateTransaction(tx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
            accounts: {
                encoding: "base64",
                addresses: [userWsolAta.toBase58()]
            },
            innerInstructions: true,
        });

        // STEP 5: Check for errors
        if (simResult.value.err) {
            const errStr = typeof simResult.value.err === "string"
                ? simResult.value.err
                : JSON.stringify(simResult.value.err);

            return createFailedSimResult(tradeSizeLamports, `Simulation error: ${errStr}`, "estimate");
        }

        const logs = simResult.value.logs || [];
        const unitsConsumed = simResult.value.unitsConsumed || 0;
        const innerInstructions = simResult.value.innerInstructions || [];
        const accounts = simResult.value.accounts || [];

        // ==========================================
        // DIAGNOSTIC LOGGING - Remove after validation
        // ==========================================
        if (state.config.verboseLogging) {
            log(`[SIMGATE RAW] Token: ${opportunity.tokenMint.substring(0, 8)}... | Size: ${Number(tradeSizeLamports) / 1e9} SOL | Units: ${unitsConsumed}`, "WARN");

            log(`[SIMGATE RAW] === LOGS (${logs.length}) ===`, "WARN");
            logs.forEach((l, i) => {
                // Only log program logs, not invoke/success messages
                if (l.includes("Program log:") || l.includes("Transfer") || l.includes("amount")) {
                    log(`  [${i}] ${l}`, "WARN");
                }
            });

            log(`[SIMGATE RAW] === INNER INSTRUCTIONS (${innerInstructions.length} outer) ===`, "WARN");
            for (const outer of innerInstructions) {
                log(`  [ix ${outer.index}] ${outer.instructions.length} inner instructions`, "WARN");
                for (let i = 0; i < Math.min(outer.instructions.length, 5); i++) {
                    const inner = outer.instructions[i] as { data?: string; programId?: unknown };
                    const dataPreview = inner.data ? inner.data.substring(0, 20) + "..." : "(parsed)";
                    log(`    [${i}] data=${dataPreview}`, "WARN");
                }
                if (outer.instructions.length > 5) {
                    log(`    ... and ${outer.instructions.length - 5} more`, "WARN");
                }
            }

            log(`[SIMGATE RAW] === ACCOUNTS (${accounts.length}) ===`, "WARN");
            if (accounts.length > 0 && accounts[0]) {
                const acc = accounts[0];
                if (acc.data && acc.data[0]) {
                    const dataPreview = acc.data[0].substring(0, 40);
                    log(`  [0] owner=${acc.owner} lamports=${acc.lamports} data=${dataPreview}...`, "WARN");
                }
            }

            log(`[SIMGATE RAW] === END RAW ===`, "WARN");
        }

        // ==========================================
        // STRATEGY 1: Parse inner instructions (MOST RELIABLE)
        // Token Program Transfer/TransferChecked contain exact amounts
        // ==========================================
        let tokensReceived = 0n;
        let solReceived = 0n;
        let parseMethod: "innerInstructions" | "accountState" | "logs" | "estimate" = "estimate";

        const innerResult = parseInnerInstructions(innerInstructions);
        if (innerResult.tokensReceived > 0n && innerResult.solReceived > 0n) {
            tokensReceived = innerResult.tokensReceived;
            solReceived = innerResult.solReceived;
            parseMethod = "innerInstructions";
            logVerbose(`[SimGate] ✓ innerInstructions: tokens=${tokensReceived}, sol=${solReceived}`);
        } else {
            logVerbose(`[SimGate] ✗ innerInstructions: tokens=${innerResult.tokensReceived}, sol=${innerResult.solReceived} (insufficient)`);
        }

        // ==========================================
        // STRATEGY 2: Use account state delta (VERY RELIABLE)
        // Compare post-simulation WSOL balance to pre-balance
        // ==========================================
        if (parseMethod === "estimate" && accounts.length > 0) {
            const accountResult = parseAccountState(accounts, preBalance, tradeSizeLamports);
            if (accountResult.solReceived > 0n) {
                solReceived = accountResult.solReceived;
                // Estimate tokens since we only tracked WSOL
                if (tokensReceived === 0n) {
                    tokensReceived = estimateTokensFromSolDelta(
                        opportunity.buyPool,
                        tradeSizeLamports
                    );
                }
                parseMethod = "accountState";
                logVerbose(`[SimGate] ✓ accountState: sol=${solReceived}, preBalance=${preBalance}`);
            } else {
                logVerbose(`[SimGate] ✗ accountState: no balance delta detected`);
            }
        }

        // ==========================================
        // STRATEGY 3: Parse logs (FALLBACK)
        // Pattern match for amount values in program logs
        // ==========================================
        if (parseMethod === "estimate") {
            const logResult = parseSimulationLogs(logs);
            if (logResult.tokensReceived > 0n || logResult.solReceived > 0n) {
                if (logResult.tokensReceived > 0n) tokensReceived = logResult.tokensReceived;
                if (logResult.solReceived > 0n) solReceived = logResult.solReceived;
                parseMethod = "logs";
                logVerbose(`[SimGate] ✓ logs: tokens=${tokensReceived}, sol=${solReceived}`);
            } else {
                logVerbose(`[SimGate] ✗ logs: no amounts found in ${logs.length} log lines`);
            }
        }

        // ==========================================
        // STRATEGY 4: Estimate from reserves (LAST RESORT)
        // Use CPMM math with known fees
        // ==========================================
        if (tokensReceived <= 0n || solReceived <= 0n) {
            const estimated = estimateFromReserves(
                opportunity.buyPool,
                opportunity.sellPool,
                tradeSizeLamports
            );

            if (tokensReceived <= 0n) tokensReceived = estimated.tokensReceived;
            if (solReceived <= 0n) solReceived = estimated.solReceived;
            parseMethod = "estimate";
            logVerbose(`[SimGate] ⚠ estimate (fallback): tokens=${tokensReceived}, sol=${solReceived}`);
        }

        // Validate we have a profit
        if (solReceived <= tradeSizeLamports) {
            return createFailedSimResult(
                tradeSizeLamports,
                `No profit: received ${solReceived} <= input ${tradeSizeLamports}`,
                parseMethod
            );
        }

        // ==========================================
        // DIAGNOSTIC: Show final parsed values
        // ==========================================
        if (state.config.verboseLogging) {
            log(`[SIMGATE PARSED] method=${parseMethod} | tokens=${tokensReceived} | solOut=${solReceived} | solIn=${tradeSizeLamports} | grossProfit=${solReceived - tradeSizeLamports}`, "WARN");
        }

        // STEP 6: Build result with extracted amounts
        return buildSimResult(
            tradeSizeLamports,
            tokensReceived,
            solReceived,
            isFreshPool,
            unitsConsumed,
            state.config.gateConfig.slippageTolerance,
            parseMethod
        );

    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        return createFailedSimResult(tradeSizeLamports, `Simulation failed: ${errMsg}`, "estimate");
    }
}

// ============================================================================
// PARSING STRATEGIES
// ============================================================================

/**
 * STRATEGY 1: Parse inner instructions for token transfers
 * 
 * Token Program instructions:
 * - Transfer (discriminator=3): [3, amount(8 bytes LE)]
 * - TransferChecked (discriminator=12): [12, amount(8 bytes LE), decimals(1 byte)]
 * 
 * For an arb (buy then sell):
 * - First Transfer TO user = tokens received from buy
 * - Last Transfer TO user = SOL received from sell
 * 
 * Note: innerInstructions from simulateTransaction can be:
 * - ParsedInstruction (has `parsed` field, no `data`)
 * - PartiallyDecodedInstruction (has `data` field as base58 string)
 */
function parseInnerInstructions(
    innerInstructions: Array<{
        index: number;
        instructions: Array<unknown>;
    }> | null | undefined
): { tokensReceived: bigint; solReceived: bigint } {
    if (!innerInstructions || innerInstructions.length === 0) {
        return { tokensReceived: 0n, solReceived: 0n };
    }

    const allTransfers: Array<{ index: number; amount: bigint }> = [];

    for (const outer of innerInstructions) {
        for (const inner of outer.instructions) {
            try {
                // Check if this is a PartiallyDecodedInstruction (has `data` field)
                const instruction = inner as { data?: string; parsed?: unknown };

                if (typeof instruction.data !== "string") {
                    // This is a ParsedInstruction - check if it's a parsed transfer
                    if (instruction.parsed && typeof instruction.parsed === "object") {
                        const parsed = instruction.parsed as { type?: string; info?: { amount?: string } };
                        if (parsed.type === "transfer" || parsed.type === "transferChecked") {
                            const amountStr = parsed.info?.amount;
                            if (amountStr) {
                                const amount = BigInt(amountStr);
                                if (amount > 0n) {
                                    allTransfers.push({ index: outer.index, amount });
                                }
                            }
                        }
                    }
                    continue;
                }

                // Decode base58 instruction data from PartiallyDecodedInstruction
                const data = decodeBase58(instruction.data);
                if (!data || data.length < 9) continue;

                // Transfer instruction (discriminator = 3)
                if (data[0] === 3 && data.length >= 9) {
                    const amount = readU64LE(data, 1);
                    if (amount > 0n) {
                        allTransfers.push({ index: outer.index, amount });
                    }
                }

                // TransferChecked instruction (discriminator = 12)
                if (data[0] === 12 && data.length >= 10) {
                    const amount = readU64LE(data, 1);
                    if (amount > 0n) {
                        allTransfers.push({ index: outer.index, amount });
                    }
                }
            } catch {
                // Skip unparseable instructions
            }
        }
    }

    // Heuristic: For arb (buy @ index 0, sell @ index 1)
    // - Transfers from index 0 = tokens received
    // - Transfers from index 1 = SOL received
    let tokensReceived = 0n;
    let solReceived = 0n;

    for (const transfer of allTransfers) {
        if (transfer.index === 0 && tokensReceived === 0n) {
            tokensReceived = transfer.amount;
        } else if (transfer.index === 1) {
            // Take the LAST transfer from sell instruction as SOL output
            solReceived = transfer.amount;
        }
    }

    return { tokensReceived, solReceived };
}

/**
 * STRATEGY 2: Parse account state to get balance delta
 * 
 * SPL Token Account layout: amount is at offset 64, 8 bytes LE
 */
function parseAccountState(
    accounts: Array<{ data: [string, string] | string[] | null } | null>,
    preBalance: bigint,
    solIn: bigint
): { solReceived: bigint } {
    try {
        const accountData = accounts[0];
        if (!accountData || !accountData.data || !accountData.data[0]) {
            return { solReceived: 0n };
        }

        // Decode token account data (base64)
        const data = Buffer.from(accountData.data[0], "base64");

        // SPL Token Account layout: amount is at offset 64, 8 bytes LE
        if (data.length >= 72) {
            const postBalance = data.readBigUInt64LE(64);

            // For WSOL in an arb:
            // - We start with preBalance
            // - We spend solIn (wrapped)
            // - We receive solReceived (wrapped)
            // So: postBalance = preBalance - solIn + solReceived
            // Therefore: solReceived = postBalance - preBalance + solIn

            const solReceived = postBalance - preBalance + solIn;
            return { solReceived: solReceived > 0n ? solReceived : 0n };
        }
    } catch {
        // Failed to parse
    }

    return { solReceived: 0n };
}

/**
 * STRATEGY 3: Parse simulation logs for transfer amounts
 * Enhanced with multiple patterns for different programs
 */
function parseSimulationLogs(
    logs: string[]
): { tokensReceived: bigint; solReceived: bigint } {
    const amounts: bigint[] = [];

    for (const log of logs) {
        // Skip non-program logs
        if (!log.includes("Program log:") && !log.includes("Program data:")) {
            continue;
        }

        // Pattern 1: "amount: 1234567" or "amount=1234567"
        const amountMatch = log.match(/amount[=:\s]+(\d+)/i);
        if (amountMatch?.[1]) {
            const val = BigInt(amountMatch[1]);
            if (val > 1000n) amounts.push(val); // Filter dust
        }

        // Pattern 2: "amount_out: 1234567"
        const outMatch = log.match(/amount[_\s]*out[=:\s]+(\d+)/i);
        if (outMatch?.[1]) {
            const val = BigInt(outMatch[1]);
            if (val > 1000n) amounts.push(val);
        }

        // Pattern 3: "received: 1234567" or "output: 1234567"
        const recvMatch = log.match(/(?:received|output)[=:\s]+(\d+)/i);
        if (recvMatch?.[1]) {
            const val = BigInt(recvMatch[1]);
            if (val > 1000n) amounts.push(val);
        }

        // Pattern 4: Standalone large numbers (might be amounts)
        const standaloneMatch = log.match(/:\s*(\d{7,})\s*$/);
        if (standaloneMatch?.[1]) {
            const val = BigInt(standaloneMatch[1]);
            if (val > 1_000_000n) amounts.push(val); // At least 0.001 of something
        }
    }

    // Deduplicate and take first (tokens) and last (SOL)
    const unique = [...new Set(amounts.map(a => a.toString()))].map(s => BigInt(s));

    let tokensReceived = 0n;
    let solReceived = 0n;

    if (unique.length >= 2) {
        tokensReceived = unique[0]!;
        solReceived = unique[unique.length - 1]!;
    } else if (unique.length === 1) {
        solReceived = unique[0]!;
    }

    return { tokensReceived, solReceived };
}

/**
 * STRATEGY 4: Estimate from reserves using CPMM math
 * dy = y * dx / (x + dx) where x=quoteReserve, y=baseReserve
 */
function estimateFromReserves(
    buyPool: PoolState,
    sellPool: PoolState,
    solIn: bigint
): { tokensReceived: bigint; solReceived: bigint } {
    // Buy: SOL -> Token
    const buyFee = buyPool.feeRate || 0.003;
    const solInAfterFee = Number(solIn) * (1 - buyFee);

    const buyQuoteReserve = Number(buyPool.quoteReserve || 1n);
    const buyBaseReserve = Number(buyPool.baseReserve || 1n);

    // CPMM: tokensOut = baseReserve * solIn / (quoteReserve + solIn)
    const tokensOut = (buyBaseReserve * solInAfterFee) / (buyQuoteReserve + solInAfterFee);
    const tokensReceived = BigInt(Math.floor(tokensOut));

    // Sell: Token -> SOL
    const sellFee = sellPool.feeRate || 0.003;
    const tokensInAfterFee = tokensOut * (1 - sellFee);

    const sellQuoteReserve = Number(sellPool.quoteReserve || 1n);
    const sellBaseReserve = Number(sellPool.baseReserve || 1n);

    // CPMM: solOut = quoteReserve * tokensIn / (baseReserve + tokensIn)
    const solOut = (sellQuoteReserve * tokensInAfterFee) / (sellBaseReserve + tokensInAfterFee);
    const solReceived = BigInt(Math.floor(solOut));

    return { tokensReceived, solReceived };
}

/**
 * Estimate tokens from known SOL input (used when we only have SOL delta)
 */
function estimateTokensFromSolDelta(
    buyPool: PoolState,
    solIn: bigint
): bigint {
    const buyFee = buyPool.feeRate || 0.003;
    const solInAfterFee = Number(solIn) * (1 - buyFee);

    const buyQuoteReserve = Number(buyPool.quoteReserve || 1n);
    const buyBaseReserve = Number(buyPool.baseReserve || 1n);

    const tokensOut = (buyBaseReserve * solInAfterFee) / (buyQuoteReserve + solInAfterFee);
    return BigInt(Math.floor(tokensOut));
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(str: string): Uint8Array | null {
    try {
        const bytes: number[] = [];
        for (const char of str) {
            let carry = BASE58_ALPHABET.indexOf(char);
            if (carry < 0) return null;
            for (let i = 0; i < bytes.length; i++) {
                carry += bytes[i]! * 58;
                bytes[i] = carry & 0xff;
                carry >>= 8;
            }
            while (carry > 0) {
                bytes.push(carry & 0xff);
                carry >>= 8;
            }
        }
        // Add leading zeros
        for (const char of str) {
            if (char !== '1') break;
            bytes.push(0);
        }
        return new Uint8Array(bytes.reverse());
    } catch {
        return null;
    }
}

function readU64LE(data: Uint8Array, offset: number): bigint {
    let result = 0n;
    for (let i = 0; i < 8; i++) {
        result |= BigInt(data[offset + i]!) << BigInt(i * 8);
    }
    return result;
}

// ============================================================================
// RESULT BUILDERS
// ============================================================================

function buildSimResult(
    solIn: bigint,
    tokensReceived: bigint,
    solReceived: bigint,
    isFreshPool: boolean,
    unitsConsumed: number,
    slippageTolerance: number,
    parseMethod: "innerInstructions" | "accountState" | "logs" | "estimate"
): SimGateResult {
    const grossProfit = solReceived - solIn;
    const spreadPercent = Number(grossProfit) / Number(solIn) * 100;

    const tipAmount = calculateDynamicTip(grossProfit, isFreshPool, spreadPercent);
    const netProfit = grossProfit - tipAmount;
    const netProfitBps = Math.round((Number(netProfit) / Number(solIn)) * 10000);

    // Calculate minOut with slippage tolerance
    const slippageMultiplier = BigInt(Math.floor((1 - slippageTolerance) * 10000));
    const minTokensOut = (tokensReceived * slippageMultiplier) / 10000n;
    const minSolOut = (solReceived * slippageMultiplier) / 10000n;

    const success = netProfit >= TIP_STRATEGY.MIN_NET_PROFIT_LAMPORTS;

    return {
        success,
        tradeSizeLamports: solIn,
        tradeSizeSol: Number(solIn) / 1e9,
        tokensReceived,
        solReceived,
        grossProfitLamports: grossProfit,
        netProfitLamports: netProfit,
        netProfitBps,
        tipAmountLamports: tipAmount,
        minTokensOut,
        minSolOut,
        simulationUnitsConsumed: unitsConsumed,
        parseMethod,
        error: success ? null : `Net profit too low: ${netProfit} lamports`
    };
}

function createFailedSimResult(
    tradeSizeLamports: bigint,
    error: string,
    parseMethod: "innerInstructions" | "accountState" | "logs" | "estimate"
): SimGateResult {
    return {
        success: false,
        tradeSizeLamports,
        tradeSizeSol: Number(tradeSizeLamports) / 1e9,
        tokensReceived: 0n,
        solReceived: 0n,
        grossProfitLamports: 0n,
        netProfitLamports: 0n,
        netProfitBps: 0,
        tipAmountLamports: 0n,
        minTokensOut: 0n,
        minSolOut: 0n,
        simulationUnitsConsumed: 0,
        parseMethod,
        error
    };
}

// ============================================================================
// OPTIMAL SIZE FINDER
// ============================================================================

async function findOptimalSizeViaSimulation(
    opportunity: OpportunityInput,
    maxCapitalLamports: bigint,
    isFreshPool: boolean
): Promise<{ optimalSize: bigint; bestResult: SimGateResult }> {
    const liquidity = getConstrainingLiquidity(opportunity.buyPool, opportunity.sellPool);

    const maxSize = liquidity.recommendedMaxSize < maxCapitalLamports
        ? liquidity.recommendedMaxSize
        : maxCapitalLamports;

    const minSize = 100_000_000n; // 0.1 SOL minimum

    if (maxSize < minSize) {
        return {
            optimalSize: 0n,
            bestResult: createFailedSimResult(0n, "Max size below minimum", "estimate")
        };
    }

    // Test 4 sizes: 25%, 50%, 75%, 100% of max
    const testSizes = [
        (maxSize * 25n) / 100n,
        (maxSize * 50n) / 100n,
        (maxSize * 75n) / 100n,
        maxSize
    ].filter(s => s >= minSize);

    let bestSize = minSize;
    let bestResult: SimGateResult | null = null;
    let bestProfit = 0n;

    for (const size of testSizes) {
        const result = await simulateAndValidate(opportunity, size, isFreshPool);

        if (result.success && result.netProfitLamports > bestProfit) {
            bestProfit = result.netProfitLamports;
            bestSize = size;
            bestResult = result;
        }
    }

    if (!bestResult) {
        bestResult = await simulateAndValidate(opportunity, minSize, isFreshPool);
        bestSize = minSize;
    }

    return { optimalSize: bestSize, bestResult };
}

// ============================================================================
// MAIN EXECUTION FLOW
// ============================================================================

export async function processOpportunity(
    opportunity: OpportunityInput
): Promise<ExecutionResult> {
    const startTime = Date.now();
    state.opportunitiesEvaluated++;
    state.lastOpportunityTime = startTime;
    incrementStat("evaluated");

    if (!state.initialized || !state.wallet || !state.connection) {
        return {
            success: false,
            simGateResult: null,
            error: "Engine not initialized",
            executionTimeMs: Date.now() - startTime
        };
    }

    const config = state.config.gateConfig;

    // ==========================================
    // QUICK CHECKS (Before simulation)
    // ==========================================

    const opportunityAgeMs = Date.now() - opportunity.detectedAt;
    if (opportunityAgeMs > config.maxOpportunityAgeMs) {
        incrementStat("skippedAge");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Too old (${Math.round(opportunityAgeMs / 1000)}s)`);
        return { success: false, simGateResult: null, executionTimeMs: Date.now() - startTime };
    }

    if (getPositionCount() >= config.maxConcurrentTrades) {
        incrementStat("skippedConcurrency");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Max concurrent trades`);
        return { success: false, simGateResult: null, executionTimeMs: Date.now() - startTime };
    }

    if (config.skipDuplicateTokens && hasOpenPositionForToken(opportunity.tokenMint)) {
        incrementStat("skippedDuplicate");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Already trading`);
        return { success: false, simGateResult: null, executionTimeMs: Date.now() - startTime };
    }

    const minLiquidity = opportunity.buyPool.quoteReserve < opportunity.sellPool.quoteReserve
        ? opportunity.buyPool.quoteReserve
        : opportunity.sellPool.quoteReserve;

    if (minLiquidity < config.minPoolLiquidityLamports) {
        incrementStat("skippedLiquidity");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Low liquidity`);
        return { success: false, simGateResult: null, executionTimeMs: Date.now() - startTime };
    }

    // ==========================================
    // SIMGATE: RPC SIMULATION
    // ==========================================

    const isFreshPool = opportunity.createdAt !== null &&
        opportunity.createdAt !== undefined &&
        (Date.now() - opportunity.createdAt) < config.freshPoolThresholdMs;

    const { optimalSize, bestResult } = await findOptimalSizeViaSimulation(
        opportunity,
        state.config.capitalConfig.maxPerTradeLamports,
        isFreshPool
    );

    if (!bestResult.success) {
        incrementStat("skippedSimulation");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Simulation: ${bestResult.error}`);
        return { success: false, simGateResult: bestResult, executionTimeMs: Date.now() - startTime };
    }

    if (bestResult.netProfitBps < config.minNetProfitBps) {
        incrementStat("skippedProfit");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Low profit (${bestResult.netProfitBps} bps)`);
        return { success: false, simGateResult: bestResult, executionTimeMs: Date.now() - startTime };
    }

    if (bestResult.netProfitLamports < config.minNetProfitLamports) {
        incrementStat("skippedProfit");
        logVerbose(`SKIP: ${opportunity.tokenMint.substring(0, 8)}... - Absolute profit too low`);
        return { success: false, simGateResult: bestResult, executionTimeMs: Date.now() - startTime };
    }

    // ==========================================
    // APPROVED FOR EXECUTION
    // ==========================================

    log(`✅ APPROVED: ${opportunity.tokenMint.substring(0, 8)}... | ` +
        `${bestResult.tradeSizeSol.toFixed(3)} SOL | ` +
        `${bestResult.netProfitBps} bps | ` +
        `${(Number(bestResult.netProfitLamports) / 1e9).toFixed(6)} SOL profit | ` +
        `parse=${bestResult.parseMethod}`);

    if (state.config.dryRun) {
        logVerbose(`[DRY RUN] Would execute trade`);
        return { success: true, simGateResult: bestResult, executionTimeMs: Date.now() - startTime };
    }

    state.executionsAttempted++;
    state.lastExecutionTime = Date.now();
    incrementStat("executed");

    // ==========================================
    // BUILD EXECUTION INSTRUCTIONS
    // ==========================================

    let buyInstruction;
    let sellInstruction;

    try {
        buyInstruction = await buildBuyInstruction(
            opportunity.buyPool,
            state.wallet.publicKey,
            optimalSize,
            bestResult.minTokensOut
        );

        sellInstruction = await buildSellInstruction(
            opportunity.sellPool,
            state.wallet.publicKey,
            bestResult.tokensReceived,
            bestResult.minSolOut
        );
    } catch (error) {
        state.lastError = `Instruction build failed: ${error}`;
        return { success: false, simGateResult: bestResult, error: state.lastError, executionTimeMs: Date.now() - startTime };
    }

    if (state.config.paperTrade) {
        log(`[PAPER TRADE] Built instructions successfully`);

        const positionId = `paper_${Date.now()}`;
        const position: OpenPosition = {
            id: positionId,
            tokenMint: opportunity.tokenMint,
            amountLamports: optimalSize,
            openedAt: Date.now(),
            buyPool: opportunity.buyPool.pubkey,
            sellPool: opportunity.sellPool.pubkey,
            expectedProfit: bestResult.netProfitLamports
        };
        openPosition(position);

        setTimeout(() => {
            closePosition(positionId);
            state.totalProfitLamports += bestResult.netProfitLamports;
            state.executionsSuccessful++;
        }, 1000);

        return {
            success: true,
            simGateResult: bestResult,
            bundleId: `paper_${Date.now()}`,
            profitLamports: bestResult.netProfitLamports,
            executionTimeMs: Date.now() - startTime
        };
    }

    // ==========================================
    // BUILD AND SUBMIT JITO BUNDLE
    // ==========================================

    let bundle: ArbitrageBundle;

    try {
        bundle = await buildArbitrageBundle(
            state.connection,
            state.wallet,
            buyInstruction,
            sellInstruction,
            bestResult.tipAmountLamports
        );
    } catch (error) {
        state.lastError = `Bundle build failed: ${error}`;
        return { success: false, simGateResult: bestResult, error: state.lastError, executionTimeMs: Date.now() - startTime };
    }

    const validation = validateBundle(bundle);
    if (!validation.valid) {
        state.lastError = `Bundle validation failed: ${validation.error}`;
        return { success: false, simGateResult: bestResult, error: state.lastError, executionTimeMs: Date.now() - startTime };
    }

    const positionId = bundle.id;
    const position: OpenPosition = {
        id: positionId,
        tokenMint: opportunity.tokenMint,
        amountLamports: optimalSize,
        openedAt: Date.now(),
        buyPool: opportunity.buyPool.pubkey,
        sellPool: opportunity.sellPool.pubkey,
        expectedProfit: bestResult.netProfitLamports
    };
    openPosition(position);

    log(`Submitting bundle ${bundle.id}...`);
    const submitResult = await submitBundleWithRetry(bundle);
    trackBundle(bundle, submitResult);

    if (!submitResult.success) {
        closePosition(positionId);
        state.lastError = `Bundle submission failed: ${submitResult.error}`;
        return {
            success: false,
            simGateResult: bestResult,
            bundleId: bundle.id,
            error: state.lastError,
            executionTimeMs: Date.now() - startTime
        };
    }

    log(`Bundle submitted: ${submitResult.bundleId}`);

    const bundleIdForStatus = submitResult.bundleId || bundle.id;
    const statusResult = await waitForBundleConfirmation(bundleIdForStatus, 30000);
    trackBundle(bundle, undefined, statusResult);

    closePosition(positionId);

    if (statusResult.status === "landed") {
        state.executionsSuccessful++;
        state.totalProfitLamports += bestResult.netProfitLamports;

        log(`✅ Bundle landed at slot ${statusResult.slot}! Profit: ${Number(bestResult.netProfitLamports) / 1e9} SOL`);

        return {
            success: true,
            simGateResult: bestResult,
            bundleId: submitResult.bundleId,
            profitLamports: bestResult.netProfitLamports,
            executionTimeMs: Date.now() - startTime
        };
    } else {
        state.lastError = `Bundle failed: ${statusResult.error || statusResult.status}`;
        log(`❌ Bundle failed: ${statusResult.status}`);

        return {
            success: false,
            simGateResult: bestResult,
            bundleId: submitResult.bundleId,
            error: state.lastError,
            executionTimeMs: Date.now() - startTime
        };
    }
}

// ============================================================================
// INSTRUCTION BUILDERS
// ============================================================================

async function buildBuyInstruction(
    pool: PoolState,
    user: PublicKey,
    amountIn: bigint,
    minOut: bigint
) {
    switch (pool.venue) {
        case "PumpSwap": {
            const accounts: PumpSwapAccounts = {
                pool: new PublicKey(pool.pubkey),
                user,
                userBaseAta: getATA(new PublicKey(pool.baseMint), user),
                userQuoteAta: getATA(SOL_MINT, user),
                poolBaseVault: getATA(new PublicKey(pool.baseMint), new PublicKey(pool.pubkey)),
                poolQuoteVault: getATA(SOL_MINT, new PublicKey(pool.pubkey)),
                baseMint: new PublicKey(pool.baseMint),
                quoteMint: new PublicKey(pool.quoteMint),
            };
            return buildPumpSwapBuyInstruction(accounts, amountIn, minOut);
        }

        case "Raydium": {
            throw new Error("Raydium instruction building requires full pool account data from cache");
        }

        case "Meteora": {
            const accounts: MeteoraAccounts = {
                lbPair: new PublicKey(pool.pubkey),
                user,
                userTokenX: getATA(new PublicKey(pool.baseMint), user),
                userTokenY: getATA(new PublicKey(pool.quoteMint), user),
                reserveX: getATA(new PublicKey(pool.baseMint), new PublicKey(pool.pubkey)),
                reserveY: getATA(new PublicKey(pool.quoteMint), new PublicKey(pool.pubkey)),
                tokenXMint: new PublicKey(pool.baseMint),
                tokenYMint: new PublicKey(pool.quoteMint),
                oracle: new PublicKey(pool.pubkey),
            };
            return buildMeteoraSwapInstruction(accounts, amountIn, minOut, true);
        }

        default:
            throw new Error(`Unsupported buy venue: ${pool.venue}`);
    }
}

async function buildSellInstruction(
    pool: PoolState,
    user: PublicKey,
    amountIn: bigint,
    minOut: bigint
) {
    switch (pool.venue) {
        case "PumpSwap": {
            const accounts: PumpSwapAccounts = {
                pool: new PublicKey(pool.pubkey),
                user,
                userBaseAta: getATA(new PublicKey(pool.baseMint), user),
                userQuoteAta: getATA(SOL_MINT, user),
                poolBaseVault: getATA(new PublicKey(pool.baseMint), new PublicKey(pool.pubkey)),
                poolQuoteVault: getATA(SOL_MINT, new PublicKey(pool.pubkey)),
                baseMint: new PublicKey(pool.baseMint),
                quoteMint: new PublicKey(pool.quoteMint),
            };
            return buildPumpSwapSellInstruction(accounts, amountIn, minOut);
        }

        case "Raydium": {
            throw new Error("Raydium instruction building requires full pool account data from cache");
        }

        case "Meteora": {
            const accounts: MeteoraAccounts = {
                lbPair: new PublicKey(pool.pubkey),
                user,
                userTokenX: getATA(new PublicKey(pool.baseMint), user),
                userTokenY: getATA(new PublicKey(pool.quoteMint), user),
                reserveX: getATA(new PublicKey(pool.baseMint), new PublicKey(pool.pubkey)),
                reserveY: getATA(new PublicKey(pool.quoteMint), new PublicKey(pool.pubkey)),
                tokenXMint: new PublicKey(pool.baseMint),
                tokenYMint: new PublicKey(pool.quoteMint),
                oracle: new PublicKey(pool.pubkey),
            };
            return buildMeteoraSwapInstruction(accounts, amountIn, minOut, false);
        }

        default:
            throw new Error(`Unsupported sell venue: ${pool.venue}`);
    }
}

// ============================================================================
// STATUS & UTILITIES
// ============================================================================

export function getEngineStatus() {
    const mode = state.config.dryRun ? "DRY_RUN" :
        state.config.paperTrade ? "PAPER_TRADE" : "LIVE";

    return {
        initialized: state.initialized,
        mode,
        uptime: Date.now() - state.startTime,
        wallet: state.wallet?.publicKey.toBase58() || null,
        stats: {
            evaluated: state.opportunitiesEvaluated,
            simulated: state.simulationsRun,
            attempted: state.executionsAttempted,
            successful: state.executionsSuccessful,
            successRate: state.executionsAttempted > 0
                ? (state.executionsSuccessful / state.executionsAttempted) * 100
                : 0,
            profitSol: Number(state.totalProfitLamports) / 1e9,
            lossSol: Number(state.totalLossLamports) / 1e9,
            netProfitSol: Number(state.totalProfitLamports - state.totalLossLamports) / 1e9
        },
        positions: getPositionSummary(state.config.capitalConfig),
        gate: getGateStats(),
        bundles: getBundleStats(),
        lastError: state.lastError
    };
}

export function printStatus(): void {
    const status = getEngineStatus();

    console.log("\n=== EXECUTION ENGINE STATUS ===");
    console.log(`Mode: ${status.mode}`);
    console.log(`Uptime: ${Math.round(status.uptime / 1000)}s`);
    console.log(`Wallet: ${status.wallet || "not loaded"}`);
    console.log("\n--- Stats ---");
    console.log(`Evaluated: ${status.stats.evaluated}`);
    console.log(`Simulated: ${status.stats.simulated}`);
    console.log(`Attempted: ${status.stats.attempted}`);
    console.log(`Successful: ${status.stats.successful}`);
    console.log(`Net Profit: ${status.stats.netProfitSol.toFixed(6)} SOL`);
    console.log("===============================\n");
}

export async function shutdownEngine(): Promise<void> {
    log("Shutting down engine...");
    clearAllPositions();
    state.initialized = false;
    printStatus();
    log("Engine shutdown complete");
}

function log(message: string, level: "INFO" | "WARN" | "ERROR" = "INFO"): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

function logVerbose(message: string): void {
    if (state.config.verboseLogging) {
        log(message);
    }
}

export { state as engineState };

export default {
    DEFAULT_ENGINE_CONFIG,
    initializeEngine,
    processOpportunity,
    getEngineStatus,
    printStatus,
    shutdownEngine
};