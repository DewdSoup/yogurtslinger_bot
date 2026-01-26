// src/brain/simulation/simGate.ts
// =============================================================================
// SIMGATE - Low-Latency RPC Simulation for Arbitrage Validation
// =============================================================================
//
// LATENCY OPTIMIZATIONS:
//   1. replaceRecentBlockhash: true (skip blockhash fetch)
//   2. commitment: "processed" (fastest)
//   3. Pre-computed instruction templates
//   4. Single simulateTransaction call for full arb
//   5. Parse logs for actual output amounts
//
// =============================================================================

import {
    Connection,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
    ComputeBudgetProgram,
    SystemProgram,
} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createSyncNativeInstruction
} from "@solana/spl-token";

// =============================================================================
// CONFIGURATION
// =============================================================================

const SIMULATION_TIMEOUT_MS = 2000;
const MAX_COMPUTE_UNITS = 400_000;
const COMPUTE_UNIT_PRICE = 1_000; // microLamports per CU

// Program IDs
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_AMM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const METEORA_DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// Instruction discriminators
const PUMPSWAP_BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);
const PUMPSWAP_SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);
const METEORA_SWAP_DISCRIMINATOR = Buffer.from([0xf8, 0xc6, 0x9e, 0x91, 0xe1, 0x75, 0x87, 0xc8]);

// =============================================================================
// TYPES
// =============================================================================

export interface PoolInfo {
    venue: "pumpswap" | "raydium" | "meteora";
    poolPubkey: string;
    tokenMint: string;
    quoteMint: string;
    tokenVault: string;
    quoteVault: string;
    poolState?: Record<string, unknown>;
    activeId?: number;
    binStep?: number;
}

export interface SimulationInput {
    wallet: PublicKey;
    buyPool: PoolInfo;
    sellPool: PoolInfo;
    amountInLamports: bigint;
    minProfitLamports: bigint;
}

export interface SimulationResult {
    success: boolean;
    profitable: boolean;
    inputAmount: bigint;
    intermediateAmount: bigint;
    outputAmount: bigint;
    netProfitLamports: bigint;
    computeUnits: number;
    gasCostLamports: bigint;
    simulationTimeMs: number;
    error?: string;
    logs: string[];
}

// =============================================================================
// SIMGATE CLASS
// =============================================================================

export class SimGate {
    private readonly connection: Connection;

    // Stats
    public simulations = 0;
    public successes = 0;
    public failures = 0;
    public profitable = 0;
    public totalTimeMs = 0;

    constructor(rpcEndpoint: string) {
        this.connection = new Connection(rpcEndpoint, {
            commitment: "processed",
            confirmTransactionInitialTimeout: SIMULATION_TIMEOUT_MS
        });
    }

    /**
     * Simulate an arbitrage opportunity
     */
    async simulate(input: SimulationInput): Promise<SimulationResult> {
        const startTime = performance.now();
        this.simulations++;

        try {
            const { instructions } = await this.buildArbInstructions(input);

            const computeIxs = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE })
            ];

            const allInstructions = [...computeIxs, ...instructions];

            const message = new TransactionMessage({
                payerKey: input.wallet,
                recentBlockhash: "11111111111111111111111111111111",
                instructions: allInstructions
            }).compileToV0Message();

            const tx = new VersionedTransaction(message);

            const simResult = await this.connection.simulateTransaction(tx, {
                replaceRecentBlockhash: true,
                commitment: "processed",
                sigVerify: false
            });

            const simulationTimeMs = performance.now() - startTime;
            this.totalTimeMs += simulationTimeMs;

            if (simResult.value.err) {
                this.failures++;
                return {
                    success: false,
                    profitable: false,
                    inputAmount: input.amountInLamports,
                    intermediateAmount: 0n,
                    outputAmount: 0n,
                    netProfitLamports: 0n,
                    computeUnits: simResult.value.unitsConsumed ?? 0,
                    gasCostLamports: 0n,
                    simulationTimeMs,
                    error: JSON.stringify(simResult.value.err),
                    logs: simResult.value.logs ?? []
                };
            }

            const amounts = this.parseSwapLogs(simResult.value.logs ?? []);
            const computeUnits = simResult.value.unitsConsumed ?? MAX_COMPUTE_UNITS;
            const gasCostLamports = BigInt(Math.ceil(computeUnits * COMPUTE_UNIT_PRICE / 1_000_000));
            const netProfitLamports = amounts.outputAmount - input.amountInLamports - gasCostLamports;
            const isProfitable = netProfitLamports >= input.minProfitLamports;

            this.successes++;
            if (isProfitable) this.profitable++;

            return {
                success: true,
                profitable: isProfitable,
                inputAmount: input.amountInLamports,
                intermediateAmount: amounts.intermediateAmount,
                outputAmount: amounts.outputAmount,
                netProfitLamports,
                computeUnits,
                gasCostLamports,
                simulationTimeMs,
                logs: simResult.value.logs ?? []
            };

        } catch (e) {
            const simulationTimeMs = performance.now() - startTime;
            this.totalTimeMs += simulationTimeMs;
            this.failures++;

            return {
                success: false,
                profitable: false,
                inputAmount: input.amountInLamports,
                intermediateAmount: 0n,
                outputAmount: 0n,
                netProfitLamports: 0n,
                computeUnits: 0,
                gasCostLamports: 0n,
                simulationTimeMs,
                error: (e as Error).message,
                logs: []
            };
        }
    }

    private async buildArbInstructions(input: SimulationInput): Promise<{
        instructions: TransactionInstruction[];
        intermediateTokenAccount: PublicKey;
    }> {
        const instructions: TransactionInstruction[] = [];
        const tokenMint = new PublicKey(input.buyPool.tokenMint);
        const tokenAta = getAssociatedTokenAddressSync(tokenMint, input.wallet);
        const wsolAta = getAssociatedTokenAddressSync(WSOL_MINT, input.wallet);

        instructions.push(
            this.createAtaInstruction(input.wallet, wsolAta, WSOL_MINT),
            SystemProgram.transfer({
                fromPubkey: input.wallet,
                toPubkey: wsolAta,
                lamports: input.amountInLamports
            }),
            createSyncNativeInstruction(wsolAta)
        );

        instructions.push(this.createAtaInstruction(input.wallet, tokenAta, tokenMint));

        const buyIx = this.buildSwapInstruction(
            input.buyPool,
            input.wallet,
            wsolAta,
            tokenAta,
            input.amountInLamports,
            true
        );
        instructions.push(buyIx);

        const sellIx = this.buildSwapInstruction(
            input.sellPool,
            input.wallet,
            tokenAta,
            wsolAta,
            0n,
            false
        );
        instructions.push(sellIx);

        instructions.push(this.createCloseWsolInstruction(input.wallet, wsolAta));

        return { instructions, intermediateTokenAccount: tokenAta };
    }

    private buildSwapInstruction(
        pool: PoolInfo,
        wallet: PublicKey,
        sourceAta: PublicKey,
        destAta: PublicKey,
        amountIn: bigint,
        isBuy: boolean
    ): TransactionInstruction {
        switch (pool.venue) {
            case "pumpswap":
                return this.buildPumpSwapInstruction(pool, wallet, sourceAta, destAta, amountIn, isBuy);
            case "raydium":
                return this.buildRaydiumSwapInstruction(pool, wallet, sourceAta, destAta, amountIn);
            case "meteora":
                return this.buildMeteoraSwapInstruction(pool, wallet, sourceAta, destAta, amountIn, isBuy);
            default:
                throw new Error(`Unknown venue: ${pool.venue}`);
        }
    }

    private buildPumpSwapInstruction(
        pool: PoolInfo,
        wallet: PublicKey,
        sourceAta: PublicKey,
        destAta: PublicKey,
        amountIn: bigint,
        isBuy: boolean
    ): TransactionInstruction {
        const poolPk = new PublicKey(pool.poolPubkey);
        const tokenVault = new PublicKey(pool.tokenVault);
        const quoteVault = new PublicKey(pool.quoteVault);

        const discriminator = isBuy ? PUMPSWAP_BUY_DISCRIMINATOR : PUMPSWAP_SELL_DISCRIMINATOR;
        const data = Buffer.alloc(24);
        discriminator.copy(data, 0);
        data.writeBigUInt64LE(amountIn, 8);
        data.writeBigUInt64LE(1n, 16);

        const keys = isBuy ? [
            { pubkey: poolPk, isSigner: false, isWritable: true },
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: tokenVault, isSigner: false, isWritable: true },
            { pubkey: quoteVault, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
        ] : [
            { pubkey: poolPk, isSigner: false, isWritable: true },
            { pubkey: wallet, isSigner: true, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: tokenVault, isSigner: false, isWritable: true },
            { pubkey: quoteVault, isSigner: false, isWritable: true },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
        ];

        return new TransactionInstruction({ programId: PUMPSWAP_PROGRAM, keys, data });
    }

    private buildRaydiumSwapInstruction(
        pool: PoolInfo,
        wallet: PublicKey,
        sourceAta: PublicKey,
        destAta: PublicKey,
        amountIn: bigint
    ): TransactionInstruction {
        const poolPk = new PublicKey(pool.poolPubkey);
        const state = pool.poolState ?? {};

        const data = Buffer.alloc(17);
        data.writeUInt8(9, 0);
        data.writeBigUInt64LE(amountIn, 1);
        data.writeBigUInt64LE(1n, 9);

        const getStateKey = (key: string, fallback: PublicKey): PublicKey => {
            const val = state[key];
            if (val instanceof PublicKey) return val;
            if (typeof val === "string") return new PublicKey(val);
            return fallback;
        };

        const keys = [
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: poolPk, isSigner: false, isWritable: true },
            { pubkey: getStateKey("authority", poolPk), isSigner: false, isWritable: false },
            { pubkey: getStateKey("openOrders", poolPk), isSigner: false, isWritable: true },
            { pubkey: getStateKey("targetOrders", poolPk), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.tokenVault), isSigner: false, isWritable: true },
            { pubkey: new PublicKey(pool.quoteVault), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketProgramId", new PublicKey("srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX")), isSigner: false, isWritable: false },
            { pubkey: getStateKey("marketId", poolPk), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketBids", poolPk), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketAsks", poolPk), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketEventQueue", poolPk), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketBaseVault", new PublicKey(pool.tokenVault)), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketQuoteVault", new PublicKey(pool.quoteVault)), isSigner: false, isWritable: true },
            { pubkey: getStateKey("marketAuthority", poolPk), isSigner: false, isWritable: false },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: wallet, isSigner: true, isWritable: false }
        ];

        return new TransactionInstruction({ programId: RAYDIUM_AMM_PROGRAM, keys, data });
    }

    private buildMeteoraSwapInstruction(
        pool: PoolInfo,
        wallet: PublicKey,
        sourceAta: PublicKey,
        destAta: PublicKey,
        amountIn: bigint,
        isBuy: boolean
    ): TransactionInstruction {
        const poolPk = new PublicKey(pool.poolPubkey);
        const tokenVault = new PublicKey(pool.tokenVault);
        const quoteVault = new PublicKey(pool.quoteVault);

        const data = Buffer.alloc(25);
        METEORA_SWAP_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(amountIn, 8);
        data.writeBigUInt64LE(1n, 16);
        data.writeUInt8(isBuy ? 1 : 0, 24);

        const state = pool.poolState ?? {};

        const getStateKey = (key: string, fallback: PublicKey): PublicKey => {
            const val = state[key];
            if (val instanceof PublicKey) return val;
            if (typeof val === "string") return new PublicKey(val);
            return fallback;
        };

        const tokenXMint = getStateKey("tokenXMint", new PublicKey(pool.tokenMint));
        const tokenYMint = getStateKey("tokenYMint", WSOL_MINT);
        const oracle = getStateKey("oracle", poolPk);

        const [eventAuthority] = PublicKey.findProgramAddressSync(
            [Buffer.from("__event_authority")],
            METEORA_DLMM_PROGRAM
        );

        const keys = [
            { pubkey: poolPk, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: tokenVault, isSigner: false, isWritable: true },
            { pubkey: quoteVault, isSigner: false, isWritable: true },
            { pubkey: sourceAta, isSigner: false, isWritable: true },
            { pubkey: destAta, isSigner: false, isWritable: true },
            { pubkey: tokenXMint, isSigner: false, isWritable: false },
            { pubkey: tokenYMint, isSigner: false, isWritable: false },
            { pubkey: oracle, isSigner: false, isWritable: true },
            { pubkey: PublicKey.default, isSigner: false, isWritable: false },
            { pubkey: wallet, isSigner: true, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: METEORA_DLMM_PROGRAM, isSigner: false, isWritable: false }
        ];

        return new TransactionInstruction({ programId: METEORA_DLMM_PROGRAM, keys, data });
    }

    private createAtaInstruction(wallet: PublicKey, ata: PublicKey, mint: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: ASSOCIATED_TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: wallet, isSigner: true, isWritable: true },
                { pubkey: ata, isSigner: false, isWritable: true },
                { pubkey: wallet, isSigner: false, isWritable: false },
                { pubkey: mint, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
                { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }
            ],
            data: Buffer.alloc(0)
        });
    }

    private createCloseWsolInstruction(wallet: PublicKey, wsolAta: PublicKey): TransactionInstruction {
        return new TransactionInstruction({
            programId: TOKEN_PROGRAM_ID,
            keys: [
                { pubkey: wsolAta, isSigner: false, isWritable: true },
                { pubkey: wallet, isSigner: false, isWritable: true },
                { pubkey: wallet, isSigner: true, isWritable: false }
            ],
            data: Buffer.from([9])
        });
    }

    private parseSwapLogs(logs: string[]): { intermediateAmount: bigint; outputAmount: bigint } {
        let intermediateAmount = 0n;
        let outputAmount = 0n;

        for (const log of logs) {
            if (log.includes("amount_out=")) {
                const match = log.match(/amount_out=(\d+)/);
                if (match?.[1]) {
                    const amount = BigInt(match[1]);
                    if (intermediateAmount === 0n) {
                        intermediateAmount = amount;
                    } else {
                        outputAmount = amount;
                    }
                }
            }

            if (log.includes("SwapBaseIn") || log.includes("swap_base_in")) {
                const match = log.match(/amount_out[:\s]+(\d+)/i);
                if (match?.[1]) {
                    const amount = BigInt(match[1]);
                    if (intermediateAmount === 0n) {
                        intermediateAmount = amount;
                    } else {
                        outputAmount = amount;
                    }
                }
            }

            if (log.includes("Swap") && log.includes("amount_out")) {
                const match = log.match(/amount_out[:\s]+(\d+)/i);
                if (match?.[1]) {
                    const amount = BigInt(match[1]);
                    if (intermediateAmount === 0n) {
                        intermediateAmount = amount;
                    } else {
                        outputAmount = amount;
                    }
                }
            }

            if (log.includes("Transfer") && log.includes("amount")) {
                const match = log.match(/amount[:\s]+(\d+)/i);
                if (match?.[1]) {
                    const amount = BigInt(match[1]);
                    if (intermediateAmount === 0n && amount > 0n) {
                        intermediateAmount = amount;
                    }
                }
            }
        }

        return { intermediateAmount, outputAmount };
    }

    getStats() {
        return {
            simulations: this.simulations,
            successes: this.successes,
            failures: this.failures,
            profitable: this.profitable,
            successRate: this.simulations > 0 ? `${(this.successes / this.simulations * 100).toFixed(1)}%` : "N/A",
            profitableRate: this.successes > 0 ? `${(this.profitable / this.successes * 100).toFixed(1)}%` : "N/A",
            avgTimeMs: this.simulations > 0 ? `${(this.totalTimeMs / this.simulations).toFixed(1)}ms` : "N/A"
        };
    }

    resetStats(): void {
        this.simulations = 0;
        this.successes = 0;
        this.failures = 0;
        this.profitable = 0;
        this.totalTimeMs = 0;
    }
}

// =============================================================================
// QUICK SIMULATION (Math-only, no RPC)
// =============================================================================

export class QuickSim {
    constructor(_rpcEndpoint: string) {
        // RPC endpoint reserved for future use (balance checks, etc.)
    }

    estimateAmmOutput(
        inputAmount: bigint,
        inputReserve: bigint,
        outputReserve: bigint,
        feeBps: number
    ): bigint {
        const feeMultiplier = 10000n - BigInt(Math.round(feeBps * 100));
        const inputWithFee = inputAmount * feeMultiplier / 10000n;
        const numerator = outputReserve * inputWithFee;
        const denominator = inputReserve + inputWithFee;
        return numerator / denominator;
    }

    estimateMeteoraOutput(
        inputAmount: bigint,
        activeId: number,
        binStep: number,
        feeBps: number,
        isBuyingToken: boolean
    ): bigint {
        const priceMultiplier = 1 + binStep / 10000;
        const price = Math.pow(priceMultiplier, activeId - 8388608);
        const feeMultiplier = (10000 - feeBps) / 10000;
        const inputNum = Number(inputAmount);
        const outputNum = isBuyingToken
            ? (inputNum / price) * feeMultiplier
            : inputNum * price * feeMultiplier;
        return BigInt(Math.floor(outputNum));
    }

    estimateProfit(
        inputLamports: bigint,
        buyPool: {
            venue: "pumpswap" | "raydium" | "meteora";
            tokenReserve: bigint;
            quoteReserve: bigint;
            feeBps: number;
            activeId?: number;
            binStep?: number;
        },
        sellPool: {
            venue: "pumpswap" | "raydium" | "meteora";
            tokenReserve: bigint;
            quoteReserve: bigint;
            feeBps: number;
            activeId?: number;
            binStep?: number;
        }
    ): { tokenAmount: bigint; outputLamports: bigint; profitLamports: bigint } {
        let tokenAmount: bigint;
        if (buyPool.venue === "meteora" && buyPool.activeId !== undefined && buyPool.binStep !== undefined) {
            tokenAmount = this.estimateMeteoraOutput(inputLamports, buyPool.activeId, buyPool.binStep, buyPool.feeBps, true);
        } else {
            tokenAmount = this.estimateAmmOutput(inputLamports, buyPool.quoteReserve, buyPool.tokenReserve, buyPool.feeBps);
        }

        let outputLamports: bigint;
        if (sellPool.venue === "meteora" && sellPool.activeId !== undefined && sellPool.binStep !== undefined) {
            outputLamports = this.estimateMeteoraOutput(tokenAmount, sellPool.activeId, sellPool.binStep, sellPool.feeBps, false);
        } else {
            outputLamports = this.estimateAmmOutput(tokenAmount, sellPool.tokenReserve, sellPool.quoteReserve, sellPool.feeBps);
        }

        return { tokenAmount, outputLamports, profitLamports: outputLamports - inputLamports };
    }
}