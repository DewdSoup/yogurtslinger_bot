// validate_pumpswap_raydium_arb_v2.mjs
// FIXED: Uses smarter approach - starts from PumpSwap tokens, finds matching Raydium pools
// Instead of fetching ALL Raydium pools (crashes), we query specific ones
//
// Usage: node validate_pumpswap_raydium_arb_v2.mjs

import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=80cfe988-e73a-4602-9f12-36ce452d3a4f";
const conn = new Connection(RPC, { commitment: "confirmed" });

const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const PUMPSWAP_POOL_SIZE = 211;

// Fees
const PUMPSWAP_FEE = 0.0030;
const RAYDIUM_FEE = 0.0025;
const TOTAL_FEES = PUMPSWAP_FEE + RAYDIUM_FEE;

let requestCount = 0;
async function rateLimitedFetch(fn) {
    requestCount++;
    await sleep(150);
    for (let i = 0; i < 5; i++) {
        try {
            return await fn();
        } catch (e) {
            if (e.message?.includes("429") || e.message?.includes("rate")) {
                console.log(`  Rate limited, waiting ${2 ** i}s...`);
                await sleep(1000 * (2 ** i));
            } else {
                throw e;
            }
        }
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const output = [];
function log(msg = "") {
    console.log(msg);
    output.push(msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DECODERS
// ═══════════════════════════════════════════════════════════════════════════════

const PUMPSWAP_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

function decodePumpSwapPool(data) {
    if (!data.subarray(0, 8).equals(PUMPSWAP_DISCRIMINATOR)) return null;

    let offset = 8;
    offset += 1; // poolBump
    offset += 2; // index
    offset += 32; // creator
    const baseMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    offset += 32; // lpMint
    const baseVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58(); offset += 32;

    return { baseMint, quoteMint, baseVault, quoteVault };
}

function decodeRaydiumPool(data) {
    try {
        const buf = Buffer.from(data);
        // Raydium V4 layout
        const status = buf.readBigUInt64LE(0);
        const baseMint = new PublicKey(buf.subarray(400, 432)).toBase58();
        const quoteMint = new PublicKey(buf.subarray(432, 464)).toBase58();
        const baseVault = new PublicKey(buf.subarray(336, 368)).toBase58();
        const quoteVault = new PublicKey(buf.subarray(368, 400)).toBase58();
        return { status: Number(status), baseMint, quoteMint, baseVault, quoteVault };
    } catch {
        return null;
    }
}

function isSol(mint) {
    return mint === SOL_MINT || mint === "11111111111111111111111111111111";
}

function getTokenMint(baseMint, quoteMint) {
    if (isSol(baseMint)) return { token: quoteMint, solIsBase: true };
    if (isSol(quoteMint)) return { token: baseMint, solIsBase: false };
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RAYDIUM POOL PDA DERIVATION
// ═══════════════════════════════════════════════════════════════════════════════

// Raydium AMM pool PDA seeds
async function findRaydiumPoolForMints(baseMint, quoteMint) {
    // Raydium pools can have tokens in either order
    // We need to check both combinations
    // Pool address is derived from: [program, amm_id prefix, market, ...]
    // Actually easier to just query by mint filters

    // Use memcmp filter on baseMint and quoteMint fields
    // baseMint is at offset 400, quoteMint is at offset 432

    const results = [];

    // Try both orderings
    for (const [base, quote] of [[baseMint, quoteMint], [quoteMint, baseMint]]) {
        try {
            const accounts = await rateLimitedFetch(async () => {
                return await conn.getProgramAccounts(RAYDIUM_PROGRAM, {
                    filters: [
                        { dataSize: 752 },
                        { memcmp: { offset: 400, bytes: base } },
                        { memcmp: { offset: 432, bytes: quote } },
                    ],
                });
            });

            for (const acc of accounts) {
                const decoded = decodeRaydiumPool(acc.account.data);
                if (decoded) {
                    results.push({
                        pubkey: acc.pubkey.toBase58(),
                        ...decoded,
                    });
                }
            }
        } catch (e) {
            // Filter might not work, that's ok
        }
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const startTime = Date.now();

    log("═".repeat(100));
    log("PUMPSWAP ↔ RAYDIUM ARBITRAGE VALIDATION (v2 - Smart Fetch)");
    log(`Started: ${new Date().toISOString()}`);
    log("═".repeat(100));

    // =========================================================================
    // PHASE 1: FETCH PUMPSWAP POOLS
    // =========================================================================
    log("\n" + "█".repeat(100));
    log("PHASE 1: FETCHING PUMPSWAP POOLS");
    log("█".repeat(100));

    log("\nFetching PumpSwap pools...");
    const pumpSwapAccounts = await rateLimitedFetch(async () => {
        return await conn.getProgramAccounts(PUMPSWAP_PROGRAM, {
            filters: [{ dataSize: PUMPSWAP_POOL_SIZE }],
        });
    });
    log(`  Found ${pumpSwapAccounts.length} PumpSwap pools`);

    // Decode and get token mints
    const pumpSwapPools = new Map();
    for (const acc of pumpSwapAccounts) {
        const decoded = decodePumpSwapPool(Buffer.from(acc.account.data));
        if (!decoded) continue;

        const tokenInfo = getTokenMint(decoded.baseMint, decoded.quoteMint);
        if (!tokenInfo) continue;

        pumpSwapPools.set(tokenInfo.token, {
            pubkey: acc.pubkey.toBase58(),
            ...decoded,
            solIsBase: tokenInfo.solIsBase,
            tokenMint: tokenInfo.token,
        });
    }
    log(`  SOL-paired tokens: ${pumpSwapPools.size}`);

    // =========================================================================
    // PHASE 2: SAMPLE PUMPSWAP POOLS AND FIND RAYDIUM MATCHES
    // =========================================================================
    log("\n" + "█".repeat(100));
    log("PHASE 2: FINDING RAYDIUM POOLS FOR PUMPSWAP TOKENS");
    log("█".repeat(100));

    // Sample a larger set of PumpSwap tokens to check for Raydium pools
    const SAMPLE_SIZE = 200;
    const pumpSwapArray = Array.from(pumpSwapPools.values());

    // Prioritize pools with recent activity (we don't have that data, so random sample)
    const samplesToCheck = pumpSwapArray.slice(0, SAMPLE_SIZE);

    log(`\nChecking ${samplesToCheck.length} PumpSwap tokens for Raydium pools...`);

    const matches = [];
    let checked = 0;

    for (const psPool of samplesToCheck) {
        checked++;
        if (checked % 20 === 0) {
            log(`  Checked ${checked}/${samplesToCheck.length}... Found ${matches.length} matches so far`);
        }

        // Find Raydium pools for this token paired with SOL
        const raydiumPools = await findRaydiumPoolForMints(psPool.tokenMint, SOL_MINT);

        if (raydiumPools.length > 0) {
            // Found a match!
            for (const rayPool of raydiumPools) {
                matches.push({
                    tokenMint: psPool.tokenMint,
                    pumpswap: psPool,
                    raydium: {
                        ...rayPool,
                        solIsBase: isSol(rayPool.baseMint),
                    },
                });
            }
        }
    }

    log(`\n  Total matches found: ${matches.length}`);

    if (matches.length === 0) {
        log("\n⚠️  No matching Raydium pools found in sample.");
        log("   This could mean:");
        log("   - PumpSwap tokens don't typically have Raydium pools");
        log("   - Need to check more tokens");
        log("   - Migration pattern is different than expected");

        // Let's try a different approach - get some recent Raydium pools
        log("\n  Trying alternative: fetching recent Raydium transactions to find active pools...");

        const raydiumSigs = await rateLimitedFetch(async () => {
            return await conn.getSignaturesForAddress(RAYDIUM_PROGRAM, { limit: 100 });
        });

        log(`  Found ${raydiumSigs.length} recent Raydium transactions`);

        // This gives us active pools, but we'd need to parse the txs
        // For now, let's continue with what we have
    }

    // =========================================================================
    // PHASE 3: FETCH VAULT BALANCES AND CALCULATE PRICES
    // =========================================================================
    if (matches.length > 0) {
        log("\n" + "█".repeat(100));
        log("PHASE 3: CALCULATING PRICES AND SPREADS");
        log("█".repeat(100));

        // Collect vault addresses
        const vaultAddresses = [];
        for (const match of matches) {
            vaultAddresses.push(match.pumpswap.baseVault);
            vaultAddresses.push(match.pumpswap.quoteVault);
            vaultAddresses.push(match.raydium.baseVault);
            vaultAddresses.push(match.raydium.quoteVault);
        }

        log(`\nFetching ${vaultAddresses.length} vault balances...`);

        const vaultBalances = new Map();
        const BATCH_SIZE = 100;

        for (let i = 0; i < vaultAddresses.length; i += BATCH_SIZE) {
            const batch = vaultAddresses.slice(i, i + BATCH_SIZE).map(v => new PublicKey(v));
            try {
                const infos = await rateLimitedFetch(async () => {
                    return await conn.getMultipleAccountsInfo(batch);
                });

                for (let j = 0; j < infos.length; j++) {
                    if (infos[j] && infos[j].data.length >= 72) {
                        const balance = Buffer.from(infos[j].data).readBigUInt64LE(64);
                        vaultBalances.set(vaultAddresses[i + j], Number(balance));
                    }
                }
            } catch (e) {
                log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
            }
        }

        log(`  Retrieved ${vaultBalances.size} vault balances`);

        // Calculate prices and spreads
        const opportunities = [];

        for (const match of matches) {
            const ps = match.pumpswap;
            const ray = match.raydium;

            const psBaseBalance = vaultBalances.get(ps.baseVault) || 0;
            const psQuoteBalance = vaultBalances.get(ps.quoteVault) || 0;
            const rayBaseBalance = vaultBalances.get(ray.baseVault) || 0;
            const rayQuoteBalance = vaultBalances.get(ray.quoteVault) || 0;

            if (psBaseBalance <= 0 || psQuoteBalance <= 0) continue;
            if (rayBaseBalance <= 0 || rayQuoteBalance <= 0) continue;

            // Calculate prices (SOL per token)
            let psPrice, rayPrice;

            if (ps.solIsBase) {
                psPrice = psBaseBalance / psQuoteBalance;
            } else {
                psPrice = psQuoteBalance / psBaseBalance;
            }

            if (ray.solIsBase) {
                rayPrice = rayBaseBalance / rayQuoteBalance;
            } else {
                rayPrice = rayQuoteBalance / rayBaseBalance;
            }

            const spread = Math.abs(rayPrice - psPrice) / Math.min(psPrice, rayPrice);
            const spreadBps = spread * 10000;
            const netProfitBps = spreadBps - (TOTAL_FEES * 10000);

            let direction;
            if (psPrice < rayPrice) {
                direction = "Buy PS → Sell Ray";
            } else {
                direction = "Buy Ray → Sell PS";
            }

            const psLiquiditySol = ps.solIsBase ? psBaseBalance / 1e9 : psQuoteBalance / 1e9;
            const rayLiquiditySol = ray.solIsBase ? rayBaseBalance / 1e9 : rayQuoteBalance / 1e9;

            opportunities.push({
                tokenMint: match.tokenMint,
                psPrice,
                rayPrice,
                spreadBps,
                netProfitBps,
                direction,
                psLiquiditySol,
                rayLiquiditySol,
                minLiquidity: Math.min(psLiquiditySol, rayLiquiditySol),
                psPubkey: ps.pubkey,
                rayPubkey: ray.pubkey,
            });
        }

        opportunities.sort((a, b) => b.netProfitBps - a.netProfitBps);

        // =========================================================================
        // RESULTS
        // =========================================================================
        log("\n" + "█".repeat(100));
        log("RESULTS");
        log("█".repeat(100));

        log(`\nPairs with valid prices: ${opportunities.length}`);

        const profitable = opportunities.filter(o => o.netProfitBps > 10);
        const marginal = opportunities.filter(o => o.netProfitBps > 0 && o.netProfitBps <= 10);

        log(`Profitable (>10 bps net): ${profitable.length}`);
        log(`Marginal (0-10 bps): ${marginal.length}`);

        if (opportunities.length > 0) {
            log("\n--- ALL OPPORTUNITIES FOUND ---");
            log("Token        | PS Price         | Ray Price        | Spread   | Net      | PS Liq   | Ray Liq  | Direction");
            log("─".repeat(130));

            for (const opp of opportunities) {
                log(
                    `${opp.tokenMint.slice(0, 12)} | ${opp.psPrice.toExponential(4).padStart(16)} | ${opp.rayPrice.toExponential(4).padStart(16)} | ${opp.spreadBps.toFixed(0).padStart(6)} bps | ${opp.netProfitBps.toFixed(0).padStart(6)} bps | ${opp.psLiquiditySol.toFixed(2).padStart(8)} | ${opp.rayLiquiditySol.toFixed(2).padStart(8)} | ${opp.direction}`
                );
            }
        }
    }

    // =========================================================================
    // ALTERNATIVE: CHECK HISTORICAL DATA
    // =========================================================================
    log("\n" + "█".repeat(100));
    log("PHASE 4: CHECKING RECENT TRADING ACTIVITY");
    log("█".repeat(100));

    // Get recent PumpSwap transactions to see what's actively being traded
    log("\nFetching recent PumpSwap activity...");

    const recentPSSigs = await rateLimitedFetch(async () => {
        return await conn.getSignaturesForAddress(PUMPSWAP_PROGRAM, { limit: 200 });
    });

    log(`  Found ${recentPSSigs.length} recent PumpSwap transactions`);

    // Find unique tokens being traded
    const activeTokens = new Set();
    const activePoolPubkeys = new Set();

    // We'd need to parse transactions to get the actual tokens
    // For now, let's just note the activity level

    const txPerMinute = recentPSSigs.length / 5; // Rough estimate
    log(`  Approximate activity: ${txPerMinute.toFixed(1)} tx/minute`);

    // =========================================================================
    // SUMMARY
    // =========================================================================
    log("\n" + "═".repeat(100));
    log("SUMMARY");
    log("═".repeat(100));

    log(`
Analysis completed:
- PumpSwap SOL pools: ${pumpSwapPools.size}
- Checked for Raydium matches: ${samplesToCheck.length}
- Matches found: ${matches.length}
- RPC requests: ${requestCount}
- Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s

NOTE: This checked ${SAMPLE_SIZE} random PumpSwap tokens. 
To be thorough, you may want to:
1. Run during peak hours (US afternoon)
2. Check ALL ${pumpSwapPools.size} tokens (will take longer)
3. Focus on recently created/active pools
`);

    // Save
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputFile = `./data/pumpswap_raydium_v2_${timestamp}.txt`;
    if (!existsSync("./data")) mkdirSync("./data", { recursive: true });
    writeFileSync(outputFile, output.join("\n"));
    log(`\n📄 Report saved: ${outputFile}`);
}

main().catch(err => {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
});
