#!/usr/bin/env node
/**
 * CROSS-VENUE OPPORTUNITY TRACKER v3
 * 
 * SIMPLIFIED APPROACH:
 *   1. Track ALL tokens we see on ANY venue
 *   2. When a token appears on multiple venues, start price checking
 *   3. Use transaction's actual accounts (from the RPC response) to find pools
 *   4. Decode prices with verified offsets
 */

const WebSocket = require('ws');
const https = require('https');
const fs = require('fs');

// ============================================================================
// CONFIG
// ============================================================================

const HELIUS_API_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const HELIUS_WS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const DATA_FILE = './opportunity_tracker_v3.json';

const PROGRAMS = {
    PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
};

const WSOL = 'So11111111111111111111111111111111111111112';

const IGNORE_MINTS = new Set([
    WSOL,
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
]);

// Rate limits
const PRICE_CHECK_COOLDOWN_MS = 3000;

// ============================================================================
// STATE
// ============================================================================

const tokens = new Map();
// Map of poolAddress -> { venue, mint, lastFetch, priceData }
const poolCache = new Map();

let stats = {
    messages: 0,
    rpcCalls: 0,
    priceChecks: 0,
    tradesByVenue: { PUMPSWAP: 0, RAYDIUM_V4: 0, RAYDIUM_CLMM: 0, METEORA_DLMM: 0 },
    spreadsDetected: 0,
    actionableSpreads: 0,
    debug: {
        txFetched: 0,
        txFailed: 0,
        txHadError: 0,
        mintsFound: 0,
        poolsDiscovered: { PUMPSWAP: 0, RAYDIUM_V4: 0, RAYDIUM_CLMM: 0, METEORA_DLMM: 0 },
        decodeAttempts: { PUMPSWAP: 0, RAYDIUM_V4: 0, RAYDIUM_CLMM: 0, METEORA_DLMM: 0 },
        decodeSuccess: { PUMPSWAP: 0, RAYDIUM_V4: 0, RAYDIUM_CLMM: 0, METEORA_DLMM: 0 },
        pricesCompared: 0,
        spreadRejected: 0,
    },
};

let ws = null;

// ============================================================================
// TOKEN STATE
// ============================================================================

function createTokenState(mint) {
    return {
        mint,
        firstSeen: Date.now(),
        // Can have multiple pools per venue (different fee tiers)
        // Store as venue -> [poolAddress, poolAddress, ...]
        pools: {
            PUMPSWAP: null,      // Only one bonding curve per token
            RAYDIUM_V4: null,    // Usually one
            RAYDIUM_CLMM: [],    // Can have multiple
            METEORA_DLMM: [],    // Can have multiple
        },
        prices: {}, // venue -> { price, fetchedAt }
        activity: {
            PUMPSWAP: { trades: 0, volume: 0, lastTrade: 0 },
            RAYDIUM_V4: { trades: 0, volume: 0, lastTrade: 0 },
            RAYDIUM_CLMM: { trades: 0, volume: 0, lastTrade: 0 },
            METEORA_DLMM: { trades: 0, volume: 0, lastTrade: 0 },
        },
        recentTrades: [],
        spreadHistory: [],
        lastPriceCheck: 0,
        score: 0,
    };
}

// ============================================================================
// RPC
// ============================================================================

function rpc(method, params) {
    stats.rpcCalls++;
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const url = new URL(HELIUS_RPC);

        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) reject(new Error(json.error.message));
                    else resolve(json.result);
                } catch (e) { reject(e); }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function getTransaction(sig) {
    return rpc('getTransaction', [sig, {
        encoding: 'jsonParsed',
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
    }]);
}

async function getMultipleAccounts(pubkeys) {
    if (pubkeys.length === 0) return { value: [] };
    return rpc('getMultipleAccounts', [pubkeys, { encoding: 'base64', commitment: 'confirmed' }]);
}

// ============================================================================
// POOL DISCOVERY FROM TRANSACTION
// ============================================================================

/**
 * Find pool address from transaction by looking at account owners
 * This fetches account info for candidate accounts to find the one owned by the program
 * 
 * CRITICAL: For DLMM, we need LbPair (904 bytes), not BinArray (10136 bytes)
 */
async function discoverPoolFromTx(tx, venue, tokenMint) {
    const accounts = tx.transaction?.message?.accountKeys || [];
    const programId = PROGRAMS[venue];

    // Get writable accounts that could be pools
    const candidates = [];
    for (let i = 0; i < Math.min(accounts.length, 15); i++) {
        const acc = accounts[i];
        const pubkey = typeof acc === 'string' ? acc : acc?.pubkey;
        const writable = typeof acc === 'object' ? acc.writable !== false : true;

        if (!pubkey || pubkey.length < 32) continue;
        if (IGNORE_MINTS.has(pubkey)) continue;
        if (pubkey === tokenMint) continue;
        if (pubkey === programId) continue;
        if (pubkey.startsWith('Token')) continue;
        if (pubkey.startsWith('1111')) continue;
        if (pubkey.startsWith('Sysvar')) continue;

        candidates.push(pubkey);
    }

    if (candidates.length === 0) return null;

    // Batch fetch account info
    try {
        const result = await getMultipleAccounts(candidates.slice(0, 8));
        if (!result?.value) return null;

        for (let i = 0; i < result.value.length; i++) {
            const accInfo = result.value[i];
            if (accInfo?.owner !== programId) continue;

            const poolAddr = candidates[i];
            const data = accInfo.data?.[0];
            const dataLen = data ? Buffer.from(data, 'base64').length : 0;

            // For DLMM, filter out BinArrays (10136 bytes) - we want LbPair (~904 bytes)
            if (venue === 'METEORA_DLMM') {
                if (dataLen > 2000) {
                    // This is likely a BinArray, skip it
                    continue;
                }
                // Also check discriminator
                if (data) {
                    const buf = Buffer.from(data, 'base64');
                    const discrim = buf.slice(0, 8).toString('hex');
                    if (discrim === '5c8e5cdc059446b5') {
                        // BinArray discriminator, skip
                        continue;
                    }
                    if (discrim !== '210b3162b565b10d') {
                        // Not LbPair either, skip
                        continue;
                    }
                }
            }

            // For CLMM, validate size (~1544 bytes)
            if (venue === 'RAYDIUM_CLMM') {
                if (dataLen < 1000 || dataLen > 2000) {
                    continue;
                }
            }

            stats.debug.poolsDiscovered[venue]++;

            // Cache this pool
            poolCache.set(poolAddr, {
                venue,
                mint: tokenMint,
                data: data,
                dataLen: dataLen,
            });

            return poolAddr;
        }
    } catch (e) {
        // Skip
    }

    return null;
}

// ============================================================================
// PRICE DECODERS
// ============================================================================

/**
 * PumpSwap Bonding Curve
 * Layout (verified from IDL):
 *   0-8: discriminator
 *   8-16: virtualTokenReserves (u64)
 *   16-24: virtualSolReserves (u64)
 *   24-32: realTokenReserves (u64)
 *   32-40: realSolReserves (u64)
 *   40-72: creator (pubkey)
 *   72-73: complete (bool)
 */
function decodePumpSwapPrice(data) {
    try {
        const buf = Buffer.from(data, 'base64');
        if (buf.length < 73) return null;

        const virtualTokenReserves = buf.readBigUInt64LE(8);
        const virtualSolReserves = buf.readBigUInt64LE(16);
        const realTokenReserves = buf.readBigUInt64LE(24);
        const realSolReserves = buf.readBigUInt64LE(32);

        // PumpSwap uses virtual + real reserves
        const totalToken = virtualTokenReserves + realTokenReserves;
        const totalSol = virtualSolReserves + realSolReserves;

        if (totalToken === 0n) return null;

        // Price in SOL per token
        // Tokens are 6 decimals, SOL is 9 decimals
        // price = (totalSol / 1e9) / (totalToken / 1e6) = totalSol / totalToken * 1e6 / 1e9
        const price = (Number(totalSol) / Number(totalToken)) * 1e-3;

        // Debug first few
        if (stats.debug.decodeAttempts.PUMPSWAP < 3) {
            log(`   🔍 PUMPSWAP: realSol=${Number(realSolReserves) / 1e9}, realToken=${Number(realTokenReserves) / 1e6}, price=${price.toExponential(4)}`);
        }

        return {
            price,
            solReserve: Number(realSolReserves) / 1e9,
            tokenReserve: Number(realTokenReserves) / 1e6,
        };
    } catch (e) {
        return null;
    }
}

/**
 * Raydium CLMM Pool State
 * 
 * From user's VALIDATED constants:
 *   CLMM_POOL_DISCRIMINATOR = f7ede3f5d7c3de46
 *   CLMM_POOL_SIZE = 1544 bytes
 *   
 *   mintDecimals0: 233,
 *   mintDecimals1: 234,
 *   sqrtPriceX64: 253,  (u128)
 */
function decodeRaydiumCLMMPrice(data) {
    try {
        const buf = Buffer.from(data, 'base64');
        if (buf.length < 300) return null;

        // Check discriminator
        const discrim = buf.slice(0, 8).toString('hex');
        if (discrim !== 'f7ede3f5d7c3de46') {
            if (stats.debug.decodeAttempts.RAYDIUM_CLMM < 3) {
                log(`   🔍 CLMM: wrong discriminator ${discrim}`);
            }
            return null;
        }

        // Read from VALIDATED offsets
        const mintDecimals0 = buf.readUInt8(233);
        const mintDecimals1 = buf.readUInt8(234);

        // sqrtPriceX64 is u128 at offset 253 - read as two u64s
        const sqrtPriceLow = buf.readBigUInt64LE(253);
        const sqrtPriceHigh = buf.readBigUInt64LE(261);
        const sqrtPriceX64 = sqrtPriceLow + (sqrtPriceHigh << 64n);

        if (sqrtPriceX64 === 0n) return null;

        // price = (sqrtPriceX64 / 2^64)^2
        const sqrtPrice = Number(sqrtPriceX64) / Math.pow(2, 64);
        let price = sqrtPrice * sqrtPrice;

        // Adjust for decimals
        price = price * Math.pow(10, mintDecimals1 - mintDecimals0);

        if (stats.debug.decodeAttempts.RAYDIUM_CLMM < 5) {
            log(`   🔍 CLMM: d0=${mintDecimals0}, d1=${mintDecimals1}, price=${price.toExponential(4)}`);
        }

        if (!isFinite(price) || price <= 0 || price > 1e15) return null;

        return { price, mintDecimals0, mintDecimals1 };
    } catch (e) {
        return null;
    }
}

/**
 * Meteora DLMM LbPair
 * 
 * From user's VALIDATED constants:
 *   LB_PAIR_DISCRIMINATOR = 210b3162b565b10d (904 bytes)
 *   BIN_ARRAY_DISCRIMINATOR = 5c8e5cdc059446b5 (10136 bytes) - NOT what we want!
 * 
 * LbPair offsets (VALIDATED):
 *   ACTIVE_ID: 76 (i32)
 *   BIN_STEP: 80 (u16)
 */
function decodeMeteoraDLMMPrice(data) {
    try {
        const buf = Buffer.from(data, 'base64');
        if (buf.length < 100) return null;

        const discrim = buf.slice(0, 8).toString('hex');

        // Check for correct LbPair discriminator
        // 210b3162b565b10d = LbPair (what we want)
        // 5c8e5cdc059446b5 = BinArray (wrong account type)
        if (discrim === '5c8e5cdc059446b5') {
            // This is a BinArray, not LbPair - skip
            if (stats.debug.decodeAttempts.METEORA_DLMM < 3) {
                log(`   🔍 DLMM: Got BinArray (${buf.length} bytes), need LbPair`);
            }
            return null;
        }

        if (discrim !== '210b3162b565b10d') {
            // Unknown discriminator
            if (stats.debug.decodeAttempts.METEORA_DLMM < 3) {
                log(`   🔍 DLMM: Unknown discriminator ${discrim}`);
            }
            return null;
        }

        // LbPair size should be ~904 bytes
        if (buf.length < 82 || buf.length > 2000) {
            return null;
        }

        // Read from VALIDATED offsets
        const activeId = buf.readInt32LE(76);
        const binStep = buf.readUInt16LE(80);

        if (stats.debug.decodeAttempts.METEORA_DLMM < 5) {
            log(`   🔍 DLMM LbPair: activeId=${activeId}, binStep=${binStep}, len=${buf.length}`);
        }

        // Sanity checks
        if (binStep < 1 || binStep > 500) return null;
        if (activeId < 0 || activeId > 20000000) return null;

        // Price = (1 + binStep/10000)^(activeId - 8388608)
        const exponent = activeId - 8388608;
        if (Math.abs(exponent) > 50000) return null;

        const base = 1 + binStep / 10000;
        const price = Math.pow(base, exponent);

        if (stats.debug.decodeAttempts.METEORA_DLMM < 5) {
            log(`      → exponent=${exponent}, price=${price.toExponential(4)}`);
        }

        if (!isFinite(price) || price <= 0 || price > 1e20) return null;

        return { price, activeId, binStep, exponent };
    } catch (e) {
        return null;
    }
}

// ============================================================================
// PRICE FETCHING
// ============================================================================

async function fetchCurrentPrices(token) {
    const now = Date.now();

    if (now - token.lastPriceCheck < PRICE_CHECK_COOLDOWN_MS) {
        return null;
    }

    token.lastPriceCheck = now;
    stats.priceChecks++;

    // Build list of pools to fetch
    // For venues with multiple pools, just use the first one
    const poolsToFetch = [];

    if (token.pools.PUMPSWAP) {
        poolsToFetch.push({ venue: 'PUMPSWAP', addr: token.pools.PUMPSWAP });
    }
    if (token.pools.RAYDIUM_V4) {
        poolsToFetch.push({ venue: 'RAYDIUM_V4', addr: token.pools.RAYDIUM_V4 });
    }
    if (token.pools.RAYDIUM_CLMM?.length > 0) {
        poolsToFetch.push({ venue: 'RAYDIUM_CLMM', addr: token.pools.RAYDIUM_CLMM[0] });
    }
    if (token.pools.METEORA_DLMM?.length > 0) {
        poolsToFetch.push({ venue: 'METEORA_DLMM', addr: token.pools.METEORA_DLMM[0] });
    }

    if (poolsToFetch.length < 2) return null;

    const poolAddresses = poolsToFetch.map(p => p.addr);

    try {
        const result = await getMultipleAccounts(poolAddresses);
        if (!result?.value) return null;

        const prices = {};

        for (let i = 0; i < poolsToFetch.length; i++) {
            const { venue, addr } = poolsToFetch[i];
            const accInfo = result.value[i];

            if (!accInfo?.data?.[0]) continue;
            if (accInfo.owner !== PROGRAMS[venue]) continue;

            const data = accInfo.data[0];
            stats.debug.decodeAttempts[venue]++;

            let priceData = null;

            switch (venue) {
                case 'PUMPSWAP':
                    priceData = decodePumpSwapPrice(data);
                    break;
                case 'RAYDIUM_CLMM':
                    priceData = decodeRaydiumCLMMPrice(data);
                    break;
                case 'METEORA_DLMM':
                    priceData = decodeMeteoraDLMMPrice(data);
                    break;
                case 'RAYDIUM_V4':
                    break;
            }

            if (priceData?.price > 0 && isFinite(priceData.price)) {
                stats.debug.decodeSuccess[venue]++;
                prices[venue] = priceData;
                token.prices[venue] = { ...priceData, fetchedAt: now };
            }
        }

        return Object.keys(prices).length >= 2 ? prices : null;

    } catch (e) {
        return null;
    }
}

function calculateSpread(prices, tokenMint) {
    const validPrices = Object.entries(prices)
        .filter(([, p]) => p?.price > 0)
        .map(([venue, p]) => ({ venue, price: p.price }));

    if (validPrices.length < 2) return null;

    stats.debug.pricesCompared++;

    let min = validPrices[0];
    let max = validPrices[0];

    for (const vp of validPrices) {
        if (vp.price < min.price) min = vp;
        if (vp.price > max.price) max = vp;
    }

    if (min.price === 0 || min.venue === max.venue) return null;

    const spreadBps = ((max.price - min.price) / min.price) * 10000;

    // Reject obviously broken spreads (>100% = decoder bug)
    if (spreadBps > 10000) {
        stats.debug.spreadRejected++;
        // Log for debugging
        log(`   ⚠️ Spread rejected (${Math.round(spreadBps)}bps): ${tokenMint?.slice(0, 12)}...`);
        for (const vp of validPrices) {
            log(`      ${vp.venue}: ${vp.price.toExponential(4)}`);
        }
        return null;
    }

    return {
        spreadBps: Math.round(spreadBps),
        spreadPct: (spreadBps / 100).toFixed(2),
        buyVenue: min.venue,
        buyPrice: min.price,
        sellVenue: max.venue,
        sellPrice: max.price,
    };
}

// ============================================================================
// TRADE PROCESSING
// ============================================================================

async function processTrade(signature, slot, venue) {
    try {
        const tx = await getTransaction(signature);

        if (!tx) {
            stats.debug.txFailed++;
            return;
        }

        stats.debug.txFetched++;

        if (tx.meta?.err) {
            stats.debug.txHadError++;
            return;
        }

        stats.tradesByVenue[venue]++;

        // Find token mint from balance changes
        const preToken = tx.meta?.preTokenBalances || [];
        const postToken = tx.meta?.postTokenBalances || [];

        let tokenMint = null;
        let solAmount = 0;

        for (const post of postToken) {
            if (IGNORE_MINTS.has(post.mint)) continue;

            const pre = preToken.find(p => p.accountIndex === post.accountIndex);
            const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
            const postAmt = BigInt(post.uiTokenAmount?.amount || '0');

            if (postAmt !== preAmt) {
                tokenMint = post.mint;
                break;
            }
        }

        if (!tokenMint) return;

        stats.debug.mintsFound++;

        // Get SOL amount
        for (const post of postToken) {
            if (post.mint === WSOL) {
                const pre = preToken.find(p => p.accountIndex === post.accountIndex);
                const preAmt = Number(pre?.uiTokenAmount?.amount || '0');
                const postAmt = Number(post.uiTokenAmount?.amount || '0');
                const diff = Math.abs(postAmt - preAmt) / 1e9;
                if (diff > solAmount) solAmount = diff;
            }
        }

        // Fallback to native SOL
        if (solAmount < 0.0001) {
            const preSol = tx.meta?.preBalances || [];
            const postSol = tx.meta?.postBalances || [];
            for (let i = 0; i < Math.min(5, preSol.length); i++) {
                const diff = Math.abs((postSol[i] || 0) - (preSol[i] || 0)) / 1e9;
                if (diff > 0.001 && diff < 10000 && diff > solAmount) {
                    solAmount = diff;
                }
            }
        }

        // Get or create token state
        let token = tokens.get(tokenMint);
        if (!token) {
            token = createTokenState(tokenMint);
            tokens.set(tokenMint, token);
        }

        const now = Date.now();

        // Check if this venue is new for this token
        const hadVenue = hasPool(token, venue);

        // Discover pool if we don't have one for this venue yet
        if (!hadVenue) {
            const poolAddr = await discoverPoolFromTx(tx, venue, tokenMint);
            if (poolAddr) {
                addPool(token, venue, poolAddr);
            }
        }

        const isNewVenue = !hadVenue && hasPool(token, venue);

        // Update activity
        token.activity[venue].trades++;
        token.activity[venue].volume += solAmount;
        token.activity[venue].lastTrade = now;

        token.recentTrades.push({ time: now, venue, sol: solAmount });

        // Prune old trades
        const fiveMinAgo = now - 5 * 60 * 1000;
        token.recentTrades = token.recentTrades.filter(t => t.time > fiveMinAgo);

        // Check if new external listing for PumpSwap token
        if (isNewVenue && venue !== 'PUMPSWAP' && token.pools.PUMPSWAP) {
            handleNewListing(token, venue);
        }

        // Price check if multi-venue
        const venueCount = countVenues(token);
        if (venueCount >= 2) {
            const prices = await fetchCurrentPrices(token);

            if (prices) {
                const spread = calculateSpread(prices, token.mint);

                if (spread) {
                    stats.spreadsDetected++;

                    token.spreadHistory.push({
                        time: now,
                        spreadBps: spread.spreadBps,
                        buyVenue: spread.buyVenue,
                        sellVenue: spread.sellVenue,
                    });

                    if (token.spreadHistory.length > 20) {
                        token.spreadHistory = token.spreadHistory.slice(-20);
                    }

                    // Log actionable spreads (>=25bps)
                    if (spread.spreadBps >= 25) {
                        stats.actionableSpreads++;
                        logSpread(token, spread, venue);
                    }
                }
            }
        }

        calculateScore(token);

    } catch (e) {
        // Skip
    }
}

// Helper to count venues
function countVenues(token) {
    let count = 0;
    if (token.pools.PUMPSWAP) count++;
    if (token.pools.RAYDIUM_V4) count++;
    if (token.pools.RAYDIUM_CLMM?.length > 0) count++;
    if (token.pools.METEORA_DLMM?.length > 0) count++;
    return count;
}

// Helper to check if token has a pool for venue
function hasPool(token, venue) {
    if (venue === 'PUMPSWAP' || venue === 'RAYDIUM_V4') {
        return !!token.pools[venue];
    } else {
        return token.pools[venue]?.length > 0;
    }
}

// Helper to add a pool
function addPool(token, venue, poolAddr) {
    if (venue === 'PUMPSWAP' || venue === 'RAYDIUM_V4') {
        token.pools[venue] = poolAddr;
    } else {
        // For CLMM/DLMM, add to array if not already present
        if (!token.pools[venue]) {
            token.pools[venue] = [];
        }
        if (!token.pools[venue].includes(poolAddr)) {
            token.pools[venue].push(poolAddr);
        }
    }
}

// Get venue display names
function getVenueList(token) {
    const venues = [];
    if (token.pools.PUMPSWAP) venues.push('PS');
    if (token.pools.RAYDIUM_V4) venues.push('V4');
    if (token.pools.RAYDIUM_CLMM?.length > 0) venues.push('CLMM');
    if (token.pools.METEORA_DLMM?.length > 0) venues.push('DLMM');
    return venues.join('+');
}

// ============================================================================
// SCORING
// ============================================================================

function calculateScore(token) {
    const venueCount = countVenues(token);

    if (venueCount < 2 || !token.pools.PUMPSWAP) {
        token.score = 0;
        return;
    }

    let score = 0;

    // Venue count
    score += venueCount * 10;

    // Recent volume
    const recentVol = token.recentTrades.reduce((sum, t) => sum + t.sol, 0);
    score += Math.min(recentVol * 2, 30);

    // Trade count
    score += Math.min(token.recentTrades.length, 20);

    // Recent spreads
    const now = Date.now();
    const recentSpreads = token.spreadHistory.filter(s => now - s.time < 60000);
    if (recentSpreads.length > 0) {
        const avgSpread = recentSpreads.reduce((sum, s) => sum + s.spreadBps, 0) / recentSpreads.length;
        score += Math.min(avgSpread / 5, 30);
    }

    token.score = Math.round(score);
}

// ============================================================================
// LOGGING
// ============================================================================

function handleNewListing(token, venue) {
    // Get the pool address for this venue
    let poolAddr;
    if (venue === 'PUMPSWAP' || venue === 'RAYDIUM_V4') {
        poolAddr = token.pools[venue];
    } else {
        const pools = token.pools[venue];
        poolAddr = pools?.[pools.length - 1]; // Most recent
    }

    log(`\n${'═'.repeat(70)}`);
    log(`🚀 NEW EXTERNAL LISTING`);
    log(`${'═'.repeat(70)}`);
    log(`   Token: ${token.mint}`);
    log(`   Venue: ${venue}`);
    log(`   Pool: ${poolAddr}`);

    const ps = token.activity.PUMPSWAP;
    if (ps.trades > 0) {
        log(`   PumpSwap: ${ps.trades} trades, ${ps.volume.toFixed(2)} SOL`);
    }
    log(`${'═'.repeat(70)}\n`);
}

function logSpread(token, spread, triggerVenue) {
    log(`\n${'─'.repeat(70)}`);
    log(`💰 SPREAD: ${spread.spreadBps} bps (${spread.spreadPct}%)`);
    log(`${'─'.repeat(70)}`);
    log(`   Token: ${token.mint.slice(0, 32)}...`);
    log(`   Buy: ${spread.buyVenue} @ ${spread.buyPrice.toExponential(4)}`);
    log(`   Sell: ${spread.sellVenue} @ ${spread.sellPrice.toExponential(4)}`);
    log(`${'─'.repeat(70)}\n`);
}

function ts() {
    return new Date().toTimeString().split(' ')[0];
}

function log(msg) {
    console.log(msg);
}

// ============================================================================
// STATS
// ============================================================================

function printStats() {
    const multiVenue = Array.from(tokens.values())
        .filter(t => countVenues(t) >= 2 && t.pools.PUMPSWAP);

    const byScore = multiVenue
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    log(`\n${'─'.repeat(70)}`);
    log(`📊 STATS @ ${ts()}`);
    log(`${'─'.repeat(70)}`);
    log(`   Tokens: ${tokens.size} | Multi-Venue: ${multiVenue.length}`);
    log(`   Price Checks: ${stats.priceChecks} | Spreads: ${stats.spreadsDetected} | Actionable: ${stats.actionableSpreads}`);
    log(`   ─────────────────────────────────────────`);
    log(`   Trades: PS:${stats.tradesByVenue.PUMPSWAP} V4:${stats.tradesByVenue.RAYDIUM_V4} CLMM:${stats.tradesByVenue.RAYDIUM_CLMM} DLMM:${stats.tradesByVenue.METEORA_DLMM}`);
    log(`   Messages: ${stats.messages} | RPC: ${stats.rpcCalls}`);

    const d = stats.debug;
    log(`   ─────────────────────────────────────────`);
    log(`   🔧 DEBUG:`);
    log(`      TX fetch: ${d.txFetched} ok, ${d.txFailed} fail, ${d.txHadError} err`);
    log(`      Mints found: ${d.mintsFound}`);
    log(`      Pools: PS:${d.poolsDiscovered.PUMPSWAP} CLMM:${d.poolsDiscovered.RAYDIUM_CLMM} DLMM:${d.poolsDiscovered.METEORA_DLMM}`);
    log(`      Decode try: PS:${d.decodeAttempts.PUMPSWAP} CLMM:${d.decodeAttempts.RAYDIUM_CLMM} DLMM:${d.decodeAttempts.METEORA_DLMM}`);
    log(`      Decode OK: PS:${d.decodeSuccess.PUMPSWAP} CLMM:${d.decodeSuccess.RAYDIUM_CLMM} DLMM:${d.decodeSuccess.METEORA_DLMM}`);
    log(`      Spreads compared: ${d.pricesCompared} | Rejected: ${d.spreadRejected}`);

    if (byScore.length > 0) {
        log(`\n   🎯 TOP TOKENS:`);
        log(`   ${'─'.repeat(66)}`);

        for (const token of byScore) {
            const venues = getVenueList(token);
            const recentVol = token.recentTrades.reduce((sum, t) => sum + t.sol, 0);
            const lastSpread = token.spreadHistory[token.spreadHistory.length - 1];

            log(`   ${token.mint.slice(0, 24)}...`);
            log(`      Score: ${token.score} | Venues: ${venues} | Vol: ${(recentVol / 5).toFixed(2)} SOL/min`);
            if (lastSpread) {
                log(`      Last: ${lastSpread.spreadBps}bps ${lastSpread.buyVenue}→${lastSpread.sellVenue}`);
            }
            log(`   `);
        }
    }

    log(`${'─'.repeat(70)}\n`);
}

function saveData() {
    try {
        const data = {
            savedAt: new Date().toISOString(),
            stats,
            multiVenueTokens: Array.from(tokens.values())
                .filter(t => countVenues(t) >= 2)
                .slice(0, 50)
                .map(t => ({
                    mint: t.mint,
                    pools: t.pools,
                    score: t.score,
                    recentSpreads: t.spreadHistory.slice(-5),
                })),
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) { }
}

// ============================================================================
// WEBSOCKET
// ============================================================================

function connect() {
    log(`[${ts()}] Connecting to Helius...`);

    ws = new WebSocket(HELIUS_WS);

    ws.on('open', () => {
        log(`[${ts()}] ✅ Connected`);

        let id = 1;
        for (const [name, programId] of Object.entries(PROGRAMS)) {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: id++,
                method: 'logsSubscribe',
                params: [{ mentions: [programId] }],
            }));
            log(`[${ts()}]    Subscribed: ${name}`);
        }
    });

    ws.on('message', (data) => {
        stats.messages++;

        try {
            const msg = JSON.parse(data.toString());

            if (msg.method === 'logsNotification') {
                const slot = msg.params?.result?.context?.slot;
                const sig = msg.params?.result?.value?.signature;
                const logs = msg.params?.result?.value?.logs || [];
                const err = msg.params?.result?.value?.err;

                if (err || !sig) return;

                const logsStr = logs.join(' ');
                let venue = null;

                if (logsStr.includes(PROGRAMS.PUMPSWAP)) venue = 'PUMPSWAP';
                else if (logsStr.includes(PROGRAMS.RAYDIUM_V4)) venue = 'RAYDIUM_V4';
                else if (logsStr.includes(PROGRAMS.RAYDIUM_CLMM)) venue = 'RAYDIUM_CLMM';
                else if (logsStr.includes(PROGRAMS.METEORA_DLMM)) venue = 'METEORA_DLMM';

                if (venue) processTrade(sig, slot, venue);
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        log(`[${ts()}] Disconnected, reconnecting...`);
        setTimeout(connect, 3000);
    });

    ws.on('error', () => { });
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
    console.log('═'.repeat(70));
    console.log('   CROSS-VENUE OPPORTUNITY TRACKER v3');
    console.log('═'.repeat(70));
    console.log('');
    console.log('   Key changes:');
    console.log('   - Pool discovery via account owner lookup');
    console.log('   - Fixed decoder offsets');
    console.log('   - Alert threshold: 25 bps (0.25%)');
    console.log('   - Rejection threshold: >100% (obviously wrong)');
    console.log('');
    console.log(`   Data: ${DATA_FILE}`);
    console.log('═'.repeat(70));
    console.log('');

    connect();

    setInterval(printStats, 60000);
    setInterval(saveData, 30000);

    process.on('SIGINT', () => {
        log('\nSaving...');
        saveData();
        process.exit(0);
    });
}

main();
