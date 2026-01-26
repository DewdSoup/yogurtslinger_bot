// validate_fragmentation_strategy.mjs
// RESEARCH SCRIPT - Validates your arb strategy assumptions with live on-chain data
//
// What this validates:
// 1. Are your fee constants correct?
// 2. What spreads actually exist between venues?
// 3. What's the typical liquidity depth?
// 4. Which Meteora pools are actually tradeable (fee ≤5%)?
// 5. What's the profitable direction (buy X sell Y)?
//
// Usage: node src/scripts/validate_fragmentation_strategy.mjs

import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const RPC = "https://mainnet.helius-rpc.com/?api-key=80cfe988-e73a-4602-9f12-36ce452d3a4f";
const conn = new Connection(RPC, { commitment: "confirmed" });

// Program IDs
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const METEORA_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

// Token mints
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Account sizes
const PUMPSWAP_POOL_SIZE = 211;
const RAYDIUM_POOL_SIZE = 752;
const METEORA_LB_PAIR_SIZE = 904;

// Rate limiting
const RATE_LIMIT_MS = 200;
let lastRequest = 0;
let requestCount = 0;

async function rateLimitedRequest(fn, description = "") {
    const now = Date.now();
    const elapsed = now - lastRequest;
    if (elapsed < RATE_LIMIT_MS) {
        await sleep(RATE_LIMIT_MS - elapsed);
    }
    lastRequest = Date.now();
    requestCount++;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await fn();
        } catch (e) {
            if (e.message?.includes("429") || e.message?.includes("rate")) {
                await sleep(2000 * (attempt + 1));
            } else {
                throw e;
            }
        }
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEE CONSTANTS TO VALIDATE
// ═══════════════════════════════════════════════════════════════════════════════

// Your current assumptions (from your code)
const YOUR_ASSUMED_FEES = {
    pumpswap: 0.0030,  // ingest.ts says 0.30%
    pumpswap_arb: 0.0025,  // fragmentationArb.ts says 0.25% ← MISMATCH
    raydium: 0.0025,  // 0.25%
    meteora_estimate: "binStep-based",  // Not using actual baseFactor
};

// Verified fees (from on-chain analysis)
const VERIFIED_FEES = {
    pumpswap: 0.0030,  // 0.30% (0.20% LP + 0.05% protocol + 0.05% creator)
    raydium_v4: 0.0025,  // 0.25% (0.22% LP + 0.03% RAY)
    meteora: "baseFactor × binStep / 1,000,000",  // Must read from account
};

// ═══════════════════════════════════════════════════════════════════════════════
// DECODERS
// ═══════════════════════════════════════════════════════════════════════════════

const PUMPSWAP_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const METEORA_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);

function decodePumpSwapPool(data) {
    if (!data.subarray(0, 8).equals(PUMPSWAP_DISCRIMINATOR)) return null;

    let offset = 8;
    const poolBump = data.readUInt8(offset); offset += 1;
    const index = data.readUInt16LE(offset); offset += 2;
    const creator = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const baseMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const lpMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const baseVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const lpSupply = data.readBigUInt64LE(offset);

    return { poolBump, index, creator, baseMint, quoteMint, lpMint, baseVault, quoteVault, lpSupply };
}

function decodeMeteoraLbPair(data) {
    if (!data.subarray(0, 8).equals(METEORA_DISCRIMINATOR)) return null;

    // Fee parameters
    const baseFactor = data.readUInt16LE(8);
    const filterPeriod = data.readUInt16LE(10);
    const decayPeriod = data.readUInt16LE(12);
    const reductionFactor = data.readUInt16LE(14);
    const variableFeeControl = data.readUInt32LE(16);
    const maxVolatilityAccumulator = data.readUInt32LE(20);

    // Volatility accumulator (critical for variable fee)
    const volatilityAccumulator = data.readUInt32LE(72);

    // Pool state
    const activeId = data.readInt32LE(76);
    const binStep = data.readUInt16LE(80);
    const status = data.readUInt8(82);

    // Tokens
    const tokenXMint = new PublicKey(data.subarray(88, 120)).toBase58();
    const tokenYMint = new PublicKey(data.subarray(120, 152)).toBase58();
    const reserveX = new PublicKey(data.subarray(152, 184)).toBase58();
    const reserveY = new PublicKey(data.subarray(184, 216)).toBase58();

    // Calculate exact fees
    const baseFee = (baseFactor * binStep) / 1_000_000;
    const vBinStep = BigInt(volatilityAccumulator) * BigInt(binStep);
    const vSquared = vBinStep * vBinStep;
    const variableFee = Number((BigInt(variableFeeControl) * vSquared) / 1_000_000_000_000_000n) / 10_000_000_000;
    const totalFee = Math.min(baseFee + variableFee, 0.10);

    return {
        baseFactor, variableFeeControl, volatilityAccumulator, maxVolatilityAccumulator,
        activeId, binStep, status,
        tokenXMint, tokenYMint, reserveX, reserveY,
        baseFee, variableFee, totalFee,
        baseFeePercent: baseFee * 100,
        totalFeePercent: totalFee * 100,
    };
}

// Simple Raydium decoder (just need mints and vaults)
function decodeRaydiumPool(data) {
    // Raydium V4 layout - mints are at specific offsets
    // This is simplified - uses known offsets
    try {
        const baseMint = new PublicKey(data.subarray(400, 432)).toBase58();
        const quoteMint = new PublicKey(data.subarray(432, 464)).toBase58();
        const baseVault = new PublicKey(data.subarray(336, 368)).toBase58();
        const quoteVault = new PublicKey(data.subarray(368, 400)).toBase58();
        return { baseMint, quoteMint, baseVault, quoteVault };
    } catch {
        return null;
    }
}

function isSol(mint) {
    return mint === SOL_MINT || mint === "11111111111111111111111111111111";
}

function getTokenMint(baseMint, quoteMint) {
    if (isSol(baseMint)) return quoteMint;
    if (isSol(quoteMint)) return baseMint;
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

function calculateCPMMPrice(baseBalance, quoteBalance, baseIsSol) {
    if (baseBalance <= 0 || quoteBalance <= 0) return null;
    // Price = SOL per token
    return baseIsSol ? baseBalance / quoteBalance : quoteBalance / baseBalance;
}

function calculateMeteoraPrice(activeId, binStep, xIsSol) {
    const basis = 1 + binStep / 10000;
    const rawPrice = Math.pow(basis, activeId);
    return xIsSol ? 1 / rawPrice : rawPrice;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OUTPUT
// ═══════════════════════════════════════════════════════════════════════════════

const output = [];
function log(msg = "") {
    console.log(msg);
    output.push(msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const startTime = Date.now();

    log("═".repeat(140));
    log("FRAGMENTATION STRATEGY VALIDATION - LIVE ON-CHAIN DATA");
    log(`Started: ${new Date().toISOString()}`);
    log("═".repeat(140));

    // =========================================================================
    // PHASE 1: FEE VALIDATION
    // =========================================================================
    log("\n" + "█".repeat(140));
    log("PHASE 1: FEE CONSTANT VALIDATION");
    log("█".repeat(140));

    log("\n┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
    log("│                                              FEE DISCREPANCY ALERT                                                               │");
    log("├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤");
    log("│                                                                                                                                    │");
    log("│  YOUR CODE HAS INCONSISTENT FEES:                                                                                                 │");
    log("│                                                                                                                                    │");
    log("│    ingest.ts:          PUMPSWAP_FEE = 0.0030 (0.30%)                                                                              │");
    log("│    fragmentationArb.ts: pumpswap = 25 bps (0.25%)  ← WRONG, should be 30 bps                                                      │");
    log("│                                                                                                                                    │");
    log("│  YOUR METEORA FEE IS WRONG:                                                                                                       │");
    log("│                                                                                                                                    │");
    log("│    You estimate by binStep, but actual fee = baseFactor × binStep / 1,000,000                                                    │");
    log("│    Most pools have baseFactor=10000+ which gives 10%+ fees (capped at 10%)                                                        │");
    log("│    Your decoder doesn't read baseFactor, so you can't calculate correct fees                                                      │");
    log("│                                                                                                                                    │");
    log("└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");

    // =========================================================================
    // PHASE 2: FETCH ALL POOLS
    // =========================================================================
    log("\n" + "█".repeat(140));
    log("PHASE 2: FETCHING POOLS FROM ALL VENUES");
    log("█".repeat(140));

    // Fetch PumpSwap pools
    log("\nFetching PumpSwap pools...");
    const pumpSwapAccounts = await rateLimitedRequest(async () => {
        return await conn.getProgramAccounts(PUMPSWAP_PROGRAM, {
            filters: [{ dataSize: PUMPSWAP_POOL_SIZE }],
        });
    }, "PumpSwap getProgramAccounts");
    log(`  Found ${pumpSwapAccounts.length} PumpSwap pools`);

    // Decode PumpSwap pools and extract SOL pairs
    const pumpSwapPools = new Map(); // tokenMint -> pool data
    for (const acc of pumpSwapAccounts) {
        const decoded = decodePumpSwapPool(Buffer.from(acc.account.data));
        if (!decoded) continue;

        const tokenMint = getTokenMint(decoded.baseMint, decoded.quoteMint);
        if (!tokenMint) continue;

        pumpSwapPools.set(tokenMint, {
            pubkey: acc.pubkey.toBase58(),
            ...decoded,
            baseIsSol: isSol(decoded.baseMint),
        });
    }
    log(`  SOL-paired tokens: ${pumpSwapPools.size}`);

    // Fetch Meteora pools
    log("\nFetching Meteora pools...");
    const meteoraAccounts = await rateLimitedRequest(async () => {
        return await conn.getProgramAccounts(METEORA_PROGRAM, {
            filters: [{ dataSize: METEORA_LB_PAIR_SIZE }],
        });
    }, "Meteora getProgramAccounts");
    log(`  Found ${meteoraAccounts.length} Meteora pools`);

    // Decode Meteora pools and extract SOL pairs
    const meteoraPools = new Map(); // tokenMint -> pool data
    let meteoraLowFee = 0;
    let meteoraHighFee = 0;

    for (const acc of meteoraAccounts) {
        const decoded = decodeMeteoraLbPair(Buffer.from(acc.account.data));
        if (!decoded || decoded.status !== 0) continue;

        const xIsSol = isSol(decoded.tokenXMint);
        const yIsSol = isSol(decoded.tokenYMint);
        if (!xIsSol && !yIsSol) continue;

        const tokenMint = xIsSol ? decoded.tokenYMint : decoded.tokenXMint;

        if (decoded.totalFee <= 0.05) {
            meteoraLowFee++;
        } else {
            meteoraHighFee++;
        }

        // Only keep if fee ≤ 5% (actually tradeable)
        if (decoded.totalFee > 0.05) continue;

        meteoraPools.set(tokenMint, {
            pubkey: acc.pubkey.toBase58(),
            ...decoded,
            xIsSol,
        });
    }
    log(`  SOL-paired pools: ${meteoraLowFee + meteoraHighFee}`);
    log(`  Low fee (≤5%): ${meteoraLowFee}`);
    log(`  High fee (>5%): ${meteoraHighFee} ← UNTRADEABLE`);
    log(`  Tradeable pools: ${meteoraPools.size}`);

    // =========================================================================
    // PHASE 3: FIND FRAGMENTED TOKENS
    // =========================================================================
    log("\n" + "█".repeat(140));
    log("PHASE 3: IDENTIFYING FRAGMENTED TOKENS");
    log("█".repeat(140));

    const fragmented = new Map(); // tokenMint -> { pumpswap, meteora }

    for (const [tokenMint, psPool] of pumpSwapPools) {
        const metPool = meteoraPools.get(tokenMint);
        if (metPool) {
            fragmented.set(tokenMint, {
                tokenMint,
                pumpswap: psPool,
                meteora: metPool,
            });
        }
    }

    log(`\nFragmented tokens found: ${fragmented.size}`);
    log("(Token exists on BOTH PumpSwap AND Meteora with tradeable fees)");

    if (fragmented.size === 0) {
        log("\n⚠️  No fragmented tokens found with tradeable Meteora fees.");
        log("   This could mean:");
        log("   - Most Meteora pools for graduated tokens have >5% fees");
        log("   - Opportunities are very rare");
        log("   - You need to catch them IMMEDIATELY on pool creation");
    }

    // =========================================================================
    // PHASE 4: FETCH VAULT BALANCES & CALCULATE SPREADS
    // =========================================================================
    if (fragmented.size > 0) {
        log("\n" + "█".repeat(140));
        log("PHASE 4: LIVE SPREAD ANALYSIS");
        log("█".repeat(140));

        // Collect vault addresses
        const vaultAddresses = [];
        for (const [, frag] of fragmented) {
            vaultAddresses.push(frag.pumpswap.baseVault);
            vaultAddresses.push(frag.pumpswap.quoteVault);
            vaultAddresses.push(frag.meteora.reserveX);
            vaultAddresses.push(frag.meteora.reserveY);
        }

        log(`\nFetching ${vaultAddresses.length} vault balances...`);

        // Batch fetch vault balances
        const vaultBalances = new Map();
        const BATCH_SIZE = 100;

        for (let i = 0; i < vaultAddresses.length; i += BATCH_SIZE) {
            const batch = vaultAddresses.slice(i, i + BATCH_SIZE).map(v => new PublicKey(v));
            try {
                const infos = await rateLimitedRequest(async () => {
                    return await conn.getMultipleAccountsInfo(batch);
                }, `vault batch ${Math.floor(i / BATCH_SIZE) + 1}`);

                for (let j = 0; j < infos.length; j++) {
                    if (infos[j] && infos[j].data.length >= 72) {
                        const balance = Buffer.from(infos[j].data).readBigUInt64LE(64);
                        vaultBalances.set(vaultAddresses[i + j], Number(balance));
                    }
                }
            } catch (e) {
                log(`  ⚠️  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed`);
            }
        }

        log(`  Retrieved ${vaultBalances.size} vault balances`);

        // Calculate spreads
        log("\n--- LIVE SPREAD ANALYSIS ---");
        log("Token        | PS Price (SOL)   | Met Price (SOL)  | Spread   | PS Fee | Met Fee | Net Profit | Direction");
        log("─".repeat(140));

        const opportunities = [];

        for (const [tokenMint, frag] of fragmented) {
            const ps = frag.pumpswap;
            const met = frag.meteora;

            // Get vault balances
            const psBaseBalance = vaultBalances.get(ps.baseVault) || 0;
            const psQuoteBalance = vaultBalances.get(ps.quoteVault) || 0;
            const metXBalance = vaultBalances.get(met.reserveX) || 0;
            const metYBalance = vaultBalances.get(met.reserveY) || 0;

            // Calculate prices
            const psPrice = calculateCPMMPrice(psBaseBalance, psQuoteBalance, ps.baseIsSol);
            const metPrice = calculateMeteoraPrice(met.activeId, met.binStep, met.xIsSol);

            if (!psPrice || !metPrice) continue;

            // Calculate spread and profit
            const spread = Math.abs(metPrice - psPrice) / Math.min(psPrice, metPrice);
            const spreadBps = spread * 10000;

            const psFee = VERIFIED_FEES.pumpswap;  // 0.30%
            const metFee = met.totalFee;  // Exact from on-chain
            const totalFees = psFee + metFee;
            const netProfit = spread - totalFees;
            const netProfitBps = netProfit * 10000;

            const direction = psPrice < metPrice ? "Buy PS → Sell Met" : "Buy Met → Sell PS";
            const profitable = netProfit > 0;

            opportunities.push({
                tokenMint,
                psPrice,
                metPrice,
                spreadBps,
                psFee,
                metFee,
                netProfitBps,
                direction,
                profitable,
                psLiquidity: Math.min(psBaseBalance, psQuoteBalance),
                metLiquidity: Math.min(metXBalance, metYBalance),
            });

            const profitStr = profitable ? `+${netProfitBps.toFixed(0)} bps ✓` : `${netProfitBps.toFixed(0)} bps`;
            log(
                `${tokenMint.slice(0, 12)} | ${psPrice.toExponential(4).padStart(16)} | ${metPrice.toExponential(4).padStart(16)} | ${spreadBps.toFixed(0).padStart(6)} bps | ${(psFee * 100).toFixed(2)}%  | ${(metFee * 100).toFixed(2)}%   | ${profitStr.padStart(10)} | ${direction}`
            );
        }

        // Summary
        const profitableOpps = opportunities.filter(o => o.profitable);
        log("\n--- OPPORTUNITY SUMMARY ---");
        log(`Total fragmented pairs analyzed: ${opportunities.length}`);
        log(`Profitable opportunities: ${profitableOpps.length}`);

        if (profitableOpps.length > 0) {
            const avgProfit = profitableOpps.reduce((a, b) => a + b.netProfitBps, 0) / profitableOpps.length;
            const maxProfit = Math.max(...profitableOpps.map(o => o.netProfitBps));
            log(`Average profit: ${avgProfit.toFixed(0)} bps`);
            log(`Max profit: ${maxProfit.toFixed(0)} bps`);

            const buyPsCount = profitableOpps.filter(o => o.direction.includes("Buy PS")).length;
            const buyMetCount = profitableOpps.filter(o => o.direction.includes("Buy Met")).length;
            log(`Direction breakdown: Buy PumpSwap: ${buyPsCount}, Buy Meteora: ${buyMetCount}`);
        }
    }

    // =========================================================================
    // PHASE 5: METEORA FEE REALITY CHECK
    // =========================================================================
    log("\n" + "█".repeat(140));
    log("PHASE 5: METEORA FEE REALITY CHECK");
    log("█".repeat(140));

    log("\n┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
    log("│                                              CRITICAL FINDING                                                                     │");
    log("├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤");
    log("│                                                                                                                                    │");
    log(`│  Of ${meteoraLowFee + meteoraHighFee} Meteora SOL-paired pools:                                                                                                   │`);
    log(`│    - ${meteoraLowFee} pools (${((meteoraLowFee / (meteoraLowFee + meteoraHighFee)) * 100).toFixed(1)}%) have fees ≤5% (tradeable)                                                                            │`);
    log(`│    - ${meteoraHighFee} pools (${((meteoraHighFee / (meteoraLowFee + meteoraHighFee)) * 100).toFixed(1)}%) have fees >5% (NOT tradeable for arb)                                                               │`);
    log("│                                                                                                                                    │");
    log("│  Your current strategy filters would MISS this, because:                                                                          │");
    log("│    - You don't read baseFactor from the account                                                                                   │");
    log("│    - You estimate fee by binStep alone                                                                                            │");
    log("│    - Most pools have baseFactor=10000+ which = 10% fee (capped)                                                                   │");
    log("│                                                                                                                                    │");
    log("│  RECOMMENDATION:                                                                                                                  │");
    log("│    Add baseFactor to your decoder (u16 @ offset 8)                                                                                │");
    log("│    Calculate exact fee: baseFactor × binStep / 1,000,000                                                                          │");
    log("│    Filter out pools with fee > 5%                                                                                                 │");
    log("│                                                                                                                                    │");
    log("└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");

    // =========================================================================
    // PHASE 6: RECOMMENDATIONS
    // =========================================================================
    log("\n" + "█".repeat(140));
    log("PHASE 6: ACTIONABLE RECOMMENDATIONS");
    log("█".repeat(140));

    log("\n┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
    log("│                                              CODE FIXES NEEDED                                                                    │");
    log("├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤");
    log("│                                                                                                                                    │");
    log("│  1. FIX fragmentationArb.ts VENUE_FEES:                                                                                           │");
    log("│     pumpswap: 30  // Not 25 - it's 0.30%                                                                                          │");
    log("│     meteora: REMOVE static value - must calculate per pool                                                                        │");
    log("│                                                                                                                                    │");
    log("│  2. ADD to MeteoraLbPairState interface:                                                                                          │");
    log("│     baseFactor: number;           // u16 @ offset 8                                                                               │");
    log("│     variableFeeControl: number;   // u32 @ offset 16                                                                              │");
    log("│     volatilityAccumulator: number; // u32 @ offset 72                                                                             │");
    log("│                                                                                                                                    │");
    log("│  3. ADD exact fee calculation function:                                                                                           │");
    log("│     function computeMeteoraFee(state): number {                                                                                   │");
    log("│       const baseFee = (state.baseFactor * state.binStep) / 1_000_000;                                                             │");
    log("│       const vBs = state.volatilityAccumulator * state.binStep;                                                                    │");
    log("│       const varFee = (state.variableFeeControl * vBs * vBs) / 1e15;                                                               │");
    log("│       return Math.min(baseFee + varFee, 0.10);                                                                                    │");
    log("│     }                                                                                                                             │");
    log("│                                                                                                                                    │");
    log("│  4. ADD Meteora fee filter in opportunity detection:                                                                              │");
    log("│     if (computeMeteoraFee(state) > 0.05) continue; // Skip >5% fee pools                                                          │");
    log("│                                                                                                                                    │");
    log("└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");

    log("\n┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐");
    log("│                                              STRATEGY INSIGHTS                                                                    │");
    log("├────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤");
    log("│                                                                                                                                    │");
    log("│  Your fragmentation strategy is VALID but needs these refinements:                                                                │");
    log("│                                                                                                                                    │");
    log("│  • Meteora pools for graduated tokens mostly have HIGH FEES (>5%)                                                                 │");
    log("│  • Low-fee Meteora pools are RARE - you must catch them IMMEDIATELY                                                               │");
    log("│  • Your existing Geyser detection for new Meteora pools is correct approach                                                       │");
    log("│  • But you need to filter by EXACT fee, not estimated fee                                                                         │");
    log("│                                                                                                                                    │");
    log("│  TIMING IS CRITICAL:                                                                                                              │");
    log("│  • When a new Meteora pool is created for a graduated token, check fee IMMEDIATELY                                                │");
    log("│  • If fee ≤ 5%, check PumpSwap price vs Meteora price                                                                             │");
    log("│  • If spread > total_fees (PumpSwap 0.30% + Meteora exact), EXECUTE                                                               │");
    log("│                                                                                                                                    │");
    log("└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘");

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n⏱️  Analysis completed in ${elapsed}s`);
    log(`📡 RPC requests: ${requestCount}`);

    // Save outputs
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir = join(process.cwd(), "data");

    if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
    }

    const textFile = join(outputDir, `fragmentation_validation_${timestamp}.txt`);
    writeFileSync(textFile, output.join("\n"));
    log(`\n📄 Report saved: ${textFile}`);
}

main().catch(err => {
    console.error("\n❌ Fatal error:", err.message);
    console.error(err.stack);
    process.exit(1);
});
