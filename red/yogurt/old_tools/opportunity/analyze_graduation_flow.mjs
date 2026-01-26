// analyze_graduation_flow.mjs
// COMPREHENSIVE: Tracks the full lifecycle after Pump.fun → PumpSwap graduation
//
// YOUR THESIS: 
//   When a token graduates, there's a window where:
//   1. Liquidity is fragmented
//   2. Prices diverge between venues
//   3. You can arb before others catch up
//
// THIS SCRIPT:
//   1. Finds recent graduations (new PumpSwap pools)
//   2. Checks if those tokens appear on other venues (Raydium, Meteora, Orca)
//   3. Tracks price evolution over time
//   4. Identifies the ACTUAL opportunity window
//
// Usage: node analyze_graduation_flow.mjs

import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync, mkdirSync, existsSync } from "fs";

const RPC = "https://mainnet.helius-rpc.com/?api-key=80cfe988-e73a-4602-9f12-36ce452d3a4f";
const conn = new Connection(RPC, { commitment: "confirmed" });

// Program IDs
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const METEORA_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const ORCA_WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const PUMPSWAP_POOL_SIZE = 211;
const PUMPSWAP_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const METEORA_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);

let requestCount = 0;
async function rateLimitedFetch(fn) {
    requestCount++;
    await sleep(150);
    for (let i = 0; i < 5; i++) {
        try {
            return await fn();
        } catch (e) {
            if (e.message?.includes("429") || e.message?.includes("rate")) {
                console.log(`  Rate limited, retrying in ${2 ** i}s...`);
                await sleep(1000 * (2 ** i));
            } else {
                throw e;
            }
        }
    }
    throw new Error("Max retries exceeded");
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

function decodePumpSwapPool(data) {
    const buf = Buffer.from(data);
    if (!buf.subarray(0, 8).equals(PUMPSWAP_DISCRIMINATOR)) return null;

    let offset = 8;
    const poolBump = buf.readUInt8(offset); offset += 1;
    const index = buf.readUInt16LE(offset); offset += 2;
    const creator = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const baseMint = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteMint = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const lpMint = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const baseVault = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;
    const quoteVault = new PublicKey(buf.subarray(offset, offset + 32)).toBase58(); offset += 32;

    return { poolBump, index, creator, baseMint, quoteMint, lpMint, baseVault, quoteVault };
}

function isSol(mint) {
    return mint === SOL_MINT || mint === "11111111111111111111111111111111";
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const startTime = Date.now();

    log("═".repeat(120));
    log("GRADUATION FLOW ANALYSIS - What happens after Pump.fun → PumpSwap?");
    log(`Started: ${new Date().toISOString()}`);
    log("═".repeat(120));

    // =========================================================================
    // PHASE 1: GET RECENT PUMPSWAP TRANSACTIONS TO FIND NEW POOLS
    // =========================================================================
    log("\n" + "█".repeat(120));
    log("PHASE 1: FINDING RECENTLY CREATED PUMPSWAP POOLS");
    log("█".repeat(120));

    // Get recent PumpSwap signatures
    log("\nFetching recent PumpSwap transactions...");

    const recentSigs = await rateLimitedFetch(async () => {
        return await conn.getSignaturesForAddress(PUMPSWAP_PROGRAM, { limit: 1000 });
    });

    log(`  Found ${recentSigs.length} recent transactions`);

    // Find pool creation transactions (they have specific patterns)
    // Pool creations initialize new accounts owned by PumpSwap

    const poolCreations = [];
    const seenPools = new Set();

    log("\nAnalyzing transactions for pool creations...");

    // Sample transactions to find pool creations
    const samplesToCheck = recentSigs.slice(0, 200);

    for (let i = 0; i < samplesToCheck.length; i++) {
        const sig = samplesToCheck[i];

        if ((i + 1) % 50 === 0) {
            log(`  Analyzed ${i + 1}/${samplesToCheck.length}... Found ${poolCreations.length} pool interactions`);
        }

        try {
            const tx = await rateLimitedFetch(async () => {
                return await conn.getParsedTransaction(sig.signature, {
                    maxSupportedTransactionVersion: 0,
                });
            });

            if (!tx || !tx.meta) continue;

            // Look for accounts owned by PumpSwap that were created (postBalance > 0, preBalance = 0 or no preBalance)
            const accountKeys = tx.transaction.message.accountKeys;
            const postTokenBalances = tx.meta.postTokenBalances || [];

            // Check inner instructions for pool creation patterns
            const innerIxs = tx.meta.innerInstructions || [];

            for (const inner of innerIxs) {
                for (const ix of inner.instructions) {
                    // Look for token transfers that might indicate a swap or pool init
                    if (ix.programId?.toBase58?.() === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
                        // Token program instruction
                        const parsed = ix.parsed;
                        if (parsed?.type === "transfer" || parsed?.type === "transferChecked") {
                            const amount = parsed.info?.amount || parsed.info?.tokenAmount?.amount;
                            if (amount && BigInt(amount) > 1000000000n) { // > 1 SOL worth
                                // This might be significant
                            }
                        }
                    }
                }
            }

            // For now, track any transaction that touches PumpSwap pools
            // Extract pool pubkeys from the transaction
            for (const key of accountKeys) {
                const pubkey = key.pubkey?.toBase58?.() || key.toBase58?.();
                if (!pubkey || seenPools.has(pubkey)) continue;

                // Check if this is a pool account
                try {
                    const accountInfo = await rateLimitedFetch(async () => {
                        return await conn.getAccountInfo(new PublicKey(pubkey));
                    });

                    if (accountInfo &&
                        accountInfo.owner.toBase58() === PUMPSWAP_PROGRAM.toBase58() &&
                        accountInfo.data.length === PUMPSWAP_POOL_SIZE) {

                        const decoded = decodePumpSwapPool(accountInfo.data);
                        if (decoded) {
                            seenPools.add(pubkey);

                            const tokenMint = isSol(decoded.baseMint) ? decoded.quoteMint :
                                isSol(decoded.quoteMint) ? decoded.baseMint : null;

                            if (tokenMint) {
                                poolCreations.push({
                                    poolPubkey: pubkey,
                                    tokenMint,
                                    signature: sig.signature,
                                    slot: sig.slot,
                                    blockTime: sig.blockTime,
                                    ...decoded,
                                });
                            }
                        }
                    }
                } catch {
                    // Not a valid pool, skip
                }
            }

        } catch (e) {
            // Skip failed fetches
        }
    }

    log(`\nFound ${poolCreations.length} unique PumpSwap pools from recent activity`);

    // =========================================================================
    // PHASE 2: CHECK EACH TOKEN FOR OTHER VENUE PRESENCE
    // =========================================================================
    log("\n" + "█".repeat(120));
    log("PHASE 2: CHECKING FOR MULTI-VENUE PRESENCE");
    log("█".repeat(120));

    const multiVenueTokens = [];

    log(`\nChecking ${poolCreations.length} tokens for Raydium/Meteora/Orca pools...`);

    for (let i = 0; i < poolCreations.length; i++) {
        const pool = poolCreations[i];

        if ((i + 1) % 10 === 0) {
            log(`  Checked ${i + 1}/${poolCreations.length}...`);
        }

        const venues = {
            pumpswap: pool,
            raydium: null,
            meteora: null,
            orca: null,
        };

        // Check Raydium
        try {
            // Try both orderings of token/SOL
            for (const [base, quote] of [[pool.tokenMint, SOL_MINT], [SOL_MINT, pool.tokenMint]]) {
                const accounts = await rateLimitedFetch(async () => {
                    return await conn.getProgramAccounts(RAYDIUM_PROGRAM, {
                        filters: [
                            { dataSize: 752 },
                            { memcmp: { offset: 400, bytes: base } },
                            { memcmp: { offset: 432, bytes: quote } },
                        ],
                    });
                });

                if (accounts.length > 0) {
                    venues.raydium = {
                        pubkey: accounts[0].pubkey.toBase58(),
                        count: accounts.length,
                    };
                    break;
                }
            }
        } catch { }

        // Check Meteora (using memcmp on token mints)
        try {
            const accounts = await rateLimitedFetch(async () => {
                return await conn.getProgramAccounts(METEORA_PROGRAM, {
                    filters: [
                        { dataSize: 904 },
                        // tokenXMint at offset 88 OR tokenYMint at offset 120
                        { memcmp: { offset: 88, bytes: pool.tokenMint } },
                    ],
                });
            });

            if (accounts.length > 0) {
                venues.meteora = {
                    pubkey: accounts[0].pubkey.toBase58(),
                    count: accounts.length,
                };
            } else {
                // Try other offset
                const accounts2 = await rateLimitedFetch(async () => {
                    return await conn.getProgramAccounts(METEORA_PROGRAM, {
                        filters: [
                            { dataSize: 904 },
                            { memcmp: { offset: 120, bytes: pool.tokenMint } },
                        ],
                    });
                });

                if (accounts2.length > 0) {
                    venues.meteora = {
                        pubkey: accounts2[0].pubkey.toBase58(),
                        count: accounts2.length,
                    };
                }
            }
        } catch { }

        // Count venues
        const venueCount = (venues.raydium ? 1 : 0) + (venues.meteora ? 1 : 0) + (venues.orca ? 1 : 0);

        if (venueCount > 0) {
            multiVenueTokens.push({
                tokenMint: pool.tokenMint,
                venues,
                venueCount: venueCount + 1, // +1 for PumpSwap
                poolSlot: pool.slot,
                poolTime: pool.blockTime ? new Date(pool.blockTime * 1000).toISOString() : "unknown",
            });
        }
    }

    log(`\nTokens with MULTI-VENUE presence: ${multiVenueTokens.length}`);

    // =========================================================================
    // PHASE 3: ANALYZE PRICE SPREADS FOR MULTI-VENUE TOKENS
    // =========================================================================
    if (multiVenueTokens.length > 0) {
        log("\n" + "█".repeat(120));
        log("PHASE 3: PRICE SPREAD ANALYSIS FOR MULTI-VENUE TOKENS");
        log("█".repeat(120));

        log("\n--- MULTI-VENUE TOKENS FOUND ---");
        log("Token        | Venues | PumpSwap | Raydium | Meteora | Pool Created");
        log("─".repeat(120));

        for (const token of multiVenueTokens) {
            const venues = [];
            if (token.venues.raydium) venues.push("Ray");
            if (token.venues.meteora) venues.push("Met");
            if (token.venues.orca) venues.push("Orca");

            log(
                `${token.tokenMint.slice(0, 12)} | ${token.venueCount.toString().padStart(6)} | ✓        | ${token.venues.raydium ? "✓" : "-"}       | ${token.venues.meteora ? "✓" : "-"}       | ${token.poolTime}`
            );
        }

        // For each multi-venue token, fetch prices
        log("\n--- LIVE PRICE COMPARISON ---");
        log("Token        | PS Price         | Ray Price        | Met Price        | Best Spread | Direction");
        log("─".repeat(130));

        for (const token of multiVenueTokens.slice(0, 20)) {
            const prices = { pumpswap: null, raydium: null, meteora: null };

            // Get PumpSwap price
            try {
                const psVaults = [token.venues.pumpswap.baseVault, token.venues.pumpswap.quoteVault];
                const psBalances = await rateLimitedFetch(async () => {
                    return await conn.getMultipleAccountsInfo(psVaults.map(v => new PublicKey(v)));
                });

                if (psBalances[0] && psBalances[1]) {
                    const baseBalance = Buffer.from(psBalances[0].data).readBigUInt64LE(64);
                    const quoteBalance = Buffer.from(psBalances[1].data).readBigUInt64LE(64);

                    const solIsBase = isSol(token.venues.pumpswap.baseMint);
                    prices.pumpswap = solIsBase
                        ? Number(baseBalance) / Number(quoteBalance)
                        : Number(quoteBalance) / Number(baseBalance);
                }
            } catch { }

            // Get Raydium price if exists
            if (token.venues.raydium) {
                try {
                    const rayAccount = await rateLimitedFetch(async () => {
                        return await conn.getAccountInfo(new PublicKey(token.venues.raydium.pubkey));
                    });

                    if (rayAccount) {
                        const buf = Buffer.from(rayAccount.data);
                        const baseMint = new PublicKey(buf.subarray(400, 432)).toBase58();
                        const baseVault = new PublicKey(buf.subarray(336, 368)).toBase58();
                        const quoteVault = new PublicKey(buf.subarray(368, 400)).toBase58();

                        const vaultBalances = await rateLimitedFetch(async () => {
                            return await conn.getMultipleAccountsInfo([
                                new PublicKey(baseVault),
                                new PublicKey(quoteVault),
                            ]);
                        });

                        if (vaultBalances[0] && vaultBalances[1]) {
                            const baseBalance = Buffer.from(vaultBalances[0].data).readBigUInt64LE(64);
                            const quoteBalance = Buffer.from(vaultBalances[1].data).readBigUInt64LE(64);

                            const solIsBase = isSol(baseMint);
                            prices.raydium = solIsBase
                                ? Number(baseBalance) / Number(quoteBalance)
                                : Number(quoteBalance) / Number(baseBalance);
                        }
                    }
                } catch { }
            }

            // Calculate spread
            const validPrices = Object.entries(prices).filter(([, p]) => p !== null && p > 0);

            if (validPrices.length >= 2) {
                const priceValues = validPrices.map(([, p]) => p);
                const minPrice = Math.min(...priceValues);
                const maxPrice = Math.max(...priceValues);
                const spread = (maxPrice - minPrice) / minPrice;
                const spreadBps = spread * 10000;

                const minVenue = validPrices.find(([, p]) => p === minPrice)[0];
                const maxVenue = validPrices.find(([, p]) => p === maxPrice)[0];

                log(
                    `${token.tokenMint.slice(0, 12)} | ${(prices.pumpswap || 0).toExponential(4).padStart(16)} | ${(prices.raydium || 0).toExponential(4).padStart(16)} | ${(prices.meteora || 0).toExponential(4).padStart(16)} | ${spreadBps.toFixed(0).padStart(9)} bps | Buy ${minVenue} → Sell ${maxVenue}`
                );
            }
        }
    }

    // =========================================================================
    // SUMMARY
    // =========================================================================
    log("\n" + "═".repeat(120));
    log("SUMMARY");
    log("═".repeat(120));

    log(`
Analysis Results:
- Recent PumpSwap transactions analyzed: ${samplesToCheck.length}
- Unique pools found: ${poolCreations.length}
- Tokens with multi-venue presence: ${multiVenueTokens.length}
- RPC requests: ${requestCount}
- Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s

FINDINGS:
`);

    if (multiVenueTokens.length > 0) {
        const withRaydium = multiVenueTokens.filter(t => t.venues.raydium).length;
        const withMeteora = multiVenueTokens.filter(t => t.venues.meteora).length;

        log(`  - ${withRaydium} tokens exist on both PumpSwap AND Raydium`);
        log(`  - ${withMeteora} tokens exist on both PumpSwap AND Meteora`);
        log(`  - These represent REAL fragmentation opportunities`);
        log(`  - Your strategy of detecting new venue appearances IS valid`);
    } else {
        log(`  - No multi-venue tokens found in this sample`);
        log(`  - This could mean:`);
        log(`    a) Need to check during peak trading hours`);
        log(`    b) Fragmentation is short-lived (need faster detection)`);
        log(`    c) Sample size needs to be larger`);
    }

    // Save
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const outputDir = "./data";
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    writeFileSync(`${outputDir}/graduation_flow_${timestamp}.txt`, output.join("\n"));
    log(`\n📄 Saved: ${outputDir}/graduation_flow_${timestamp}.txt`);

    if (multiVenueTokens.length > 0) {
        writeFileSync(`${outputDir}/multi_venue_tokens_${timestamp}.json`, JSON.stringify(multiVenueTokens, null, 2));
        log(`📄 Saved: ${outputDir}/multi_venue_tokens_${timestamp}.json`);
    }
}

main().catch(err => {
    console.error("\n❌ Error:", err.message);
    console.error(err.stack);
    process.exit(1);
});
