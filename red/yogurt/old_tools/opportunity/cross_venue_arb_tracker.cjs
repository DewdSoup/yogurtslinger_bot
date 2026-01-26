#!/usr/bin/env node
/**
 * CROSS-VENUE ARBITRAGE TRACKER
 * 
 * TWO-PHASE STRATEGY:
 * 
 * PHASE 1 - LISTING SNIPE
 *   Detect when PumpSwap token first lists on external DEX
 *   Maximum spread opportunity, fastest execution wins
 * 
 * PHASE 2 - SUSTAINED ARBITRAGE  
 *   Continue monitoring multi-venue tokens while profitable conditions exist:
 *   - High volume velocity (trades creating price divergence)
 *   - High volatility (price swings = spread opportunities)
 *   - Liquidity imbalance (thin side = easier to arb)
 *   - Trade clustering (burst on one venue, other stale)
 * 
 * VENUES:
 *   - PumpSwap (bonding curve)
 *   - Raydium V4 (constant product)
 *   - Raydium CLMM (concentrated liquidity)
 *   - Meteora DLMM (dynamic bins)
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

const DATA_FILE = './arb_tracker_data.json';

// Thresholds
const MIN_SPREAD_BPS = 25;           // Alert when spread >= this
const MIN_LIQUIDITY_SOL = 0.1;       // Minimum to consider
const HIGH_VOLUME_SOL_PER_MIN = 5;   // "High volume" threshold
const HIGH_VOLATILITY_PCT = 2;       // Price change % in 5 min = "volatile"
const STALE_THRESHOLD_MS = 30000;    // 30s without trade = "stale"

// How long to keep tracking after volume dies
const TRACK_TIMEOUT_MS = 30 * 60 * 1000; // 30 min of low activity

// Programs
const PROGRAMS = {
    PUMPSWAP: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    RAYDIUM_CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    METEORA_DLMM: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
};

const WSOL = 'So11111111111111111111111111111111111111112';

// ============================================================================
// STATE
// ============================================================================

/**
 * tokens: Map<mint, TokenState>
 * 
 * TokenState = {
 *   mint: string,
 *   firstSeen: number,
 *   phase: 'WATCHING' | 'ACTIVE' | 'COOLING',
 *   
 *   // Venues where this token trades
 *   venues: Map<venueKey, VenueData>,
 *   
 *   // Aggregated metrics
 *   metrics: {
 *     totalVolume24h: number,
 *     volumeVelocity: number,      // SOL/min (5 min rolling)
 *     volatility: number,          // % price range (5 min)
 *     lastArbSpread: number,       // bps
 *     arbCount: number,            // opportunities detected
 *   },
 *   
 *   // Recent price history for volatility calc
 *   priceHistory: Array<{ time, venue, price }>,
 *   
 *   // Trade history for velocity calc  
 *   recentTrades: Array<{ time, venue, sol, direction }>,
 * }
 * 
 * VenueData = {
 *   venue: string,                 // 'PUMPSWAP' | 'RAYDIUM_V4' | etc
 *   pool: string,                  // Pool address
 *   firstSeen: number,             // When we first saw this venue
 *   lastTrade: number,             // Last trade timestamp
 *   lastPrice: number,             // Last known price (SOL per token)
 *   liquidity: number,             // SOL-equivalent depth
 *   tradeCount: number,
 *   volumeSol: number,
 * }
 */

const tokens = new Map();
const arbOpportunities = [];  // Historical log

let stats = {
    messages: 0,
    rpcCalls: 0,
    pumpTrades: 0,
    externalTrades: 0,
    listingsDetected: 0,
    arbsDetected: 0,
    phase1Arbs: 0,   // Listing snipes
    phase2Arbs: 0,   // Sustained arbs
};

let ws = null;

// ============================================================================
// TOKEN STATE MANAGEMENT
// ============================================================================

function createTokenState(mint) {
    return {
        mint,
        firstSeen: Date.now(),
        phase: 'WATCHING',  // WATCHING -> ACTIVE (multi-venue) -> COOLING (low activity)

        venues: new Map(),

        metrics: {
            totalVolume24h: 0,
            volumeVelocity: 0,
            volatility: 0,
            lastArbSpread: 0,
            arbCount: 0,
        },

        priceHistory: [],    // { time, venue, price }
        recentTrades: [],    // { time, venue, sol, direction }
    };
}

function createVenueData(venue, pool) {
    return {
        venue,
        pool,
        firstSeen: Date.now(),
        lastTrade: Date.now(),
        lastPrice: 0,
        liquidity: 0,
        tradeCount: 0,
        volumeSol: 0,
    };
}

// ============================================================================
// METRICS CALCULATION
// ============================================================================

function updateMetrics(token) {
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60 * 1000;

    // Prune old data
    token.recentTrades = token.recentTrades.filter(t => t.time > fiveMinAgo);
    token.priceHistory = token.priceHistory.filter(p => p.time > fiveMinAgo);

    // Volume velocity (SOL/min over 5 min)
    const recentVolume = token.recentTrades.reduce((sum, t) => sum + t.sol, 0);
    token.metrics.volumeVelocity = recentVolume / 5;

    // Volatility (price range % over 5 min)
    if (token.priceHistory.length >= 2) {
        const prices = token.priceHistory.map(p => p.price).filter(p => p > 0);
        if (prices.length >= 2) {
            const min = Math.min(...prices);
            const max = Math.max(...prices);
            token.metrics.volatility = min > 0 ? ((max - min) / min) * 100 : 0;
        }
    }

    return token.metrics;
}

function calculateCrossVenueSpread(token) {
    const venues = Array.from(token.venues.values()).filter(v => v.lastPrice > 0);

    if (venues.length < 2) return null;

    // Find min and max price venues
    let minVenue = venues[0];
    let maxVenue = venues[0];

    for (const v of venues) {
        if (v.lastPrice < minVenue.lastPrice) minVenue = v;
        if (v.lastPrice > maxVenue.lastPrice) maxVenue = v;
    }

    if (minVenue.lastPrice === 0) return null;

    const spreadBps = ((maxVenue.lastPrice - minVenue.lastPrice) / minVenue.lastPrice) * 10000;

    // Check staleness - if one venue hasn't traded in 30s, spread may not be real
    const now = Date.now();
    const minStale = (now - minVenue.lastTrade) > STALE_THRESHOLD_MS;
    const maxStale = (now - maxVenue.lastTrade) > STALE_THRESHOLD_MS;

    return {
        spreadBps: Math.round(spreadBps),
        buyVenue: minVenue.venue,
        buyPool: minVenue.pool,
        buyPrice: minVenue.lastPrice,
        buyLiquidity: minVenue.liquidity,
        buyStale: minStale,
        sellVenue: maxVenue.venue,
        sellPool: maxVenue.pool,
        sellPrice: maxVenue.lastPrice,
        sellLiquidity: maxVenue.liquidity,
        sellStale: maxStale,
        isStale: minStale || maxStale,
        minLiquidity: Math.min(minVenue.liquidity, maxVenue.liquidity),
    };
}

function evaluateArbConditions(token) {
    const spread = calculateCrossVenueSpread(token);
    if (!spread) return null;

    const metrics = token.metrics;

    // Score different factors
    const factors = {
        // Spread quality (primary)
        spreadScore: Math.min(spread.spreadBps / 100, 10),  // Cap at 10

        // Volume indicates active interest
        volumeScore: Math.min(metrics.volumeVelocity / HIGH_VOLUME_SOL_PER_MIN, 5),

        // Volatility indicates more spread opportunities coming
        volatilityScore: Math.min(metrics.volatility / HIGH_VOLATILITY_PCT, 5),

        // Liquidity - need enough to make it worth it
        liquidityScore: Math.min(spread.minLiquidity / 1, 5),  // 1 SOL = full score

        // Freshness - penalize stale prices
        freshnessScore: spread.isStale ? -3 : 2,
    };

    const totalScore = Object.values(factors).reduce((a, b) => a + b, 0);

    return {
        ...spread,
        factors,
        totalScore,
        isActionable: spread.spreadBps >= MIN_SPREAD_BPS &&
            spread.minLiquidity >= MIN_LIQUIDITY_SOL &&
            !spread.isStale,
    };
}

// ============================================================================
// PHASE DETECTION
// ============================================================================

function checkPhaseTransition(token, newVenue = null) {
    const venueCount = token.venues.size;
    const now = Date.now();

    // Phase 1 trigger: New external listing detected
    if (newVenue && newVenue !== 'PUMPSWAP' && token.venues.has('PUMPSWAP')) {
        const isFirstExternal = Array.from(token.venues.keys())
            .filter(v => v !== 'PUMPSWAP').length === 1;

        if (isFirstExternal) {
            return { phase: 'PHASE1_LISTING', venue: newVenue };
        }
    }

    // Transition to ACTIVE when multi-venue
    if (venueCount >= 2 && token.phase === 'WATCHING') {
        token.phase = 'ACTIVE';
    }

    // Check if still worth tracking (ACTIVE -> COOLING -> remove)
    if (token.phase === 'ACTIVE') {
        const metrics = token.metrics;

        // Low activity = cooling
        if (metrics.volumeVelocity < 0.1 && metrics.volatility < 0.5) {
            const lastActivity = Math.max(...Array.from(token.venues.values()).map(v => v.lastTrade));
            if (now - lastActivity > TRACK_TIMEOUT_MS) {
                token.phase = 'COOLING';
            }
        }
    }

    return null;
}

// ============================================================================
// RPC HELPERS
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

// ============================================================================
// PRICE EXTRACTION FROM TRANSACTIONS
// ============================================================================

function extractTradeFromTx(tx, venue) {
    if (!tx || tx.meta?.err) return null;

    const preToken = tx.meta?.preTokenBalances || [];
    const postToken = tx.meta?.postTokenBalances || [];
    const preSol = tx.meta?.preBalances || [];
    const postSol = tx.meta?.postBalances || [];

    // Find non-WSOL token changes
    let tokenMint = null;
    let tokenChange = 0n;
    let tokenDecimals = 6;

    for (const post of postToken) {
        if (post.mint === WSOL) continue;

        const pre = preToken.find(p => p.accountIndex === post.accountIndex);
        const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
        const postAmt = BigInt(post.uiTokenAmount?.amount || '0');
        const diff = postAmt - preAmt;

        if (diff !== 0n) {
            tokenMint = post.mint;
            tokenChange = diff;
            tokenDecimals = post.uiTokenAmount?.decimals || 6;
            break;
        }
    }

    if (!tokenMint) return null;

    // Find SOL change (user is usually account 0)
    let solChange = 0;
    if (preSol[0] !== undefined && postSol[0] !== undefined) {
        solChange = (postSol[0] - preSol[0]) / 1e9;
    }

    // Also check WSOL changes in token balances
    for (const post of postToken) {
        if (post.mint === WSOL) {
            const pre = preToken.find(p => p.accountIndex === post.accountIndex);
            const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
            const postAmt = BigInt(post.uiTokenAmount?.amount || '0');
            const wsolDiff = Number(postAmt - preAmt) / 1e9;
            if (Math.abs(wsolDiff) > Math.abs(solChange)) {
                solChange = wsolDiff;
            }
        }
    }

    const solAmount = Math.abs(solChange);
    const tokenAmount = Math.abs(Number(tokenChange)) / Math.pow(10, tokenDecimals);

    if (solAmount < 0.0001 || tokenAmount < 1) return null;

    // Price = SOL / tokens
    const price = solAmount / tokenAmount;

    // Direction: user spent SOL = BUY token
    const direction = solChange < 0 ? 'BUY' : 'SELL';

    // Get pool address (varies by venue)
    const accounts = tx.transaction?.message?.accountKeys || [];
    let poolAddress = null;

    // Pool is typically in first few writable accounts (index 1-4)
    for (let i = 1; i < Math.min(accounts.length, 6); i++) {
        const acc = accounts[i];
        const pubkey = typeof acc === 'string' ? acc : acc?.pubkey;
        const writable = acc?.writable;

        if (pubkey && writable && pubkey !== tokenMint && pubkey !== WSOL) {
            poolAddress = pubkey;
            break;
        }
    }

    return {
        mint: tokenMint,
        pool: poolAddress,
        venue,
        price,
        solAmount,
        tokenAmount,
        direction,
        slot: tx.slot,
    };
}

// ============================================================================
// TRADE PROCESSING
// ============================================================================

async function processTrade(signature, slot, venue) {
    try {
        const tx = await getTransaction(signature);
        const trade = extractTradeFromTx(tx, venue);

        if (!trade || !trade.mint || !trade.pool) return;

        if (venue === 'PUMPSWAP') stats.pumpTrades++;
        else stats.externalTrades++;

        // Get or create token state
        let token = tokens.get(trade.mint);
        if (!token) {
            token = createTokenState(trade.mint);
            tokens.set(trade.mint, token);
        }

        // Get or create venue data
        const venueKey = `${venue}:${trade.pool}`;
        let venueData = token.venues.get(venueKey);
        const isNewVenue = !venueData;

        if (!venueData) {
            venueData = createVenueData(venue, trade.pool);
            token.venues.set(venueKey, venueData);
        }

        // Update venue data
        venueData.lastTrade = Date.now();
        venueData.lastPrice = trade.price;
        venueData.tradeCount++;
        venueData.volumeSol += trade.solAmount;

        // Update token history
        token.priceHistory.push({
            time: Date.now(),
            venue: venueKey,
            price: trade.price,
        });

        token.recentTrades.push({
            time: Date.now(),
            venue: venueKey,
            sol: trade.solAmount,
            direction: trade.direction,
        });

        token.metrics.totalVolume24h += trade.solAmount;

        // Check for phase transitions
        const transition = checkPhaseTransition(token, isNewVenue ? venue : null);

        // PHASE 1: New listing detected!
        if (transition?.phase === 'PHASE1_LISTING') {
            stats.listingsDetected++;
            await handleNewListing(token, trade, transition.venue);
        }

        // PHASE 2: Check ongoing arb conditions
        if (token.venues.size >= 2) {
            const arb = evaluateArbConditions(token);
            updateMetrics(token);

            if (arb?.isActionable) {
                handleArbOpportunity(token, arb, transition ? 'PHASE1' : 'PHASE2');
            }
        }

    } catch (e) {
        // Skip failed fetches
    }
}

// ============================================================================
// OPPORTUNITY HANDLERS
// ============================================================================

async function handleNewListing(token, trade, newVenue) {
    const now = Date.now();

    log(`\n${'═'.repeat(70)}`);
    log(`🚀 PHASE 1: NEW LISTING DETECTED`);
    log(`${'═'.repeat(70)}`);
    log(`   Token: ${token.mint}`);
    log(`   New Venue: ${newVenue}`);
    log(`   Pool: ${trade.pool}`);
    log(`   ─────────────────────────────────────────`);

    // Show PumpSwap stats before listing
    const pumpVenues = Array.from(token.venues.entries())
        .filter(([k]) => k.startsWith('PUMPSWAP'));

    if (pumpVenues.length > 0) {
        const [, pumpData] = pumpVenues[0];
        log(`   📊 PumpSwap Pre-Listing:`);
        log(`      Volume: ${pumpData.volumeSol.toFixed(2)} SOL`);
        log(`      Trades: ${pumpData.tradeCount}`);
        log(`      Last Price: ${pumpData.lastPrice.toExponential(4)} SOL/token`);
        log(`      Time on PumpSwap: ${((now - pumpData.firstSeen) / 60000).toFixed(1)} min`);
    }

    // Initial arb check
    const arb = evaluateArbConditions(token);
    if (arb) {
        log(`   ─────────────────────────────────────────`);
        log(`   💰 INITIAL SPREAD:`);
        log(`      Spread: ${arb.spreadBps} bps (${(arb.spreadBps / 100).toFixed(2)}%)`);
        log(`      Buy: ${arb.buyVenue} @ ${arb.buyPrice.toExponential(4)}`);
        log(`      Sell: ${arb.sellVenue} @ ${arb.sellPrice.toExponential(4)}`);
        log(`      Min Liquidity: ${arb.minLiquidity.toFixed(4)} SOL`);
        log(`      Score: ${arb.totalScore.toFixed(1)}`);

        if (arb.isActionable) {
            log(`   ⚡ ACTIONABLE - Execute arb!`);
            stats.phase1Arbs++;
        }
    }

    log(`${'═'.repeat(70)}\n`);

    // Record for analysis
    arbOpportunities.push({
        type: 'PHASE1_LISTING',
        mint: token.mint,
        newVenue,
        pool: trade.pool,
        timestamp: now,
        arb,
    });

    saveData();
}

function handleArbOpportunity(token, arb, phase) {
    const now = Date.now();

    // Rate limit logging (don't spam for same token)
    const lastArb = token._lastArbLog || 0;
    if (now - lastArb < 5000) return; // 5s cooldown
    token._lastArbLog = now;

    token.metrics.lastArbSpread = arb.spreadBps;
    token.metrics.arbCount++;

    if (phase === 'PHASE1') {
        // Already logged in handleNewListing
        return;
    }

    stats.arbsDetected++;
    stats.phase2Arbs++;

    const metrics = token.metrics;

    log(`\n${'─'.repeat(70)}`);
    log(`💹 PHASE 2: SPREAD OPPORTUNITY`);
    log(`${'─'.repeat(70)}`);
    log(`   Token: ${token.mint.slice(0, 20)}...`);
    log(`   Spread: ${arb.spreadBps} bps (${(arb.spreadBps / 100).toFixed(2)}%)`);
    log(`   Buy: ${arb.buyVenue} @ ${arb.buyPrice.toExponential(4)}`);
    log(`   Sell: ${arb.sellVenue} @ ${arb.sellPrice.toExponential(4)}`);
    log(`   ─────────────────────────────────────────`);
    log(`   Conditions:`);
    log(`      Volume: ${metrics.volumeVelocity.toFixed(2)} SOL/min ${metrics.volumeVelocity >= HIGH_VOLUME_SOL_PER_MIN ? '🔥' : ''}`);
    log(`      Volatility: ${metrics.volatility.toFixed(2)}% ${metrics.volatility >= HIGH_VOLATILITY_PCT ? '📈' : ''}`);
    log(`      Liquidity: ${arb.minLiquidity.toFixed(4)} SOL`);
    log(`      Stale: ${arb.isStale ? '⚠️ YES' : '✅ NO'}`);
    log(`   Score: ${arb.totalScore.toFixed(1)} | Factors: ${JSON.stringify(arb.factors)}`);
    log(`${'─'.repeat(70)}\n`);

    // Record
    arbOpportunities.push({
        type: 'PHASE2_SPREAD',
        mint: token.mint,
        timestamp: now,
        arb,
        metrics: { ...metrics },
    });
}

// ============================================================================
// WEBSOCKET
// ============================================================================

function connect() {
    log(`[${ts()}] Connecting to Helius WebSocket...`);

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

                // Determine venue from logs
                const logsStr = logs.join(' ');
                let venue = null;

                if (logsStr.includes(PROGRAMS.PUMPSWAP)) venue = 'PUMPSWAP';
                else if (logsStr.includes(PROGRAMS.RAYDIUM_V4)) venue = 'RAYDIUM_V4';
                else if (logsStr.includes(PROGRAMS.RAYDIUM_CLMM)) venue = 'RAYDIUM_CLMM';
                else if (logsStr.includes(PROGRAMS.METEORA_DLMM)) venue = 'METEORA_DLMM';

                if (venue) {
                    processTrade(sig, slot, venue);
                }
            }
        } catch (e) {
            // Skip parse errors
        }
    });

    ws.on('close', () => {
        log(`[${ts()}] ❌ Disconnected, reconnecting in 3s...`);
        setTimeout(connect, 3000);
    });

    ws.on('error', (e) => {
        log(`[${ts()}] WS Error: ${e.message}`);
    });
}

// ============================================================================
// REPORTING
// ============================================================================

function ts() {
    return new Date().toTimeString().split(' ')[0];
}

function log(msg) {
    console.log(msg);
}

function printStats() {
    // Active multi-venue tokens
    const activeTokens = Array.from(tokens.values())
        .filter(t => t.venues.size >= 2 && t.phase === 'ACTIVE');

    // Sort by recent arb potential
    const byScore = activeTokens
        .map(t => ({ token: t, arb: evaluateArbConditions(t) }))
        .filter(x => x.arb)
        .sort((a, b) => b.arb.totalScore - a.arb.totalScore)
        .slice(0, 5);

    log(`\n${'─'.repeat(70)}`);
    log(`📊 STATS @ ${ts()}`);
    log(`${'─'.repeat(70)}`);
    log(`   Tokens Watching: ${tokens.size} | Multi-Venue Active: ${activeTokens.length}`);
    log(`   Phase 1 (Listings): ${stats.listingsDetected} | Phase 1 Arbs: ${stats.phase1Arbs}`);
    log(`   Phase 2 (Sustained): ${stats.phase2Arbs}`);
    log(`   Trades: PumpSwap ${stats.pumpTrades} | External ${stats.externalTrades}`);
    log(`   Messages: ${stats.messages} | RPC: ${stats.rpcCalls}`);

    if (byScore.length > 0) {
        log(`\n   🎯 Top Arb Candidates:`);
        for (const { token, arb } of byScore) {
            const m = token.metrics;
            log(`      ${token.mint.slice(0, 16)}... | ${arb.spreadBps}bps | ${m.volumeVelocity.toFixed(1)} SOL/min | ${m.volatility.toFixed(1)}% vol | ${arb.isActionable ? '⚡' : '⏸️'}`);
            log(`         Buy ${arb.buyVenue} → Sell ${arb.sellVenue} | Liq: ${arb.minLiquidity.toFixed(2)} SOL`);
        }
    }

    // Recent opportunities
    const recent = arbOpportunities.slice(-3);
    if (recent.length > 0) {
        log(`\n   📈 Recent Opportunities:`);
        for (const opp of recent) {
            const age = ((Date.now() - opp.timestamp) / 1000).toFixed(0);
            const spread = opp.arb?.spreadBps || 0;
            log(`      ${opp.type} | ${opp.mint.slice(0, 12)}... | ${spread}bps | ${age}s ago`);
        }
    }

    log(`${'─'.repeat(70)}\n`);
}

function saveData() {
    try {
        const data = {
            savedAt: new Date().toISOString(),
            stats,
            recentOpportunities: arbOpportunities.slice(-100),
            activeTokens: Array.from(tokens.entries())
                .filter(([, t]) => t.venues.size >= 2)
                .map(([mint, t]) => ({
                    mint,
                    phase: t.phase,
                    venues: Array.from(t.venues.keys()),
                    metrics: t.metrics,
                })),
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (e) { }
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (data.recentOpportunities) {
                arbOpportunities.push(...data.recentOpportunities);
            }
            log(`[${ts()}] Loaded ${arbOpportunities.length} historical opportunities`);
        }
    } catch (e) { }
}

// ============================================================================
// MAIN
// ============================================================================

function main() {
    console.log('═'.repeat(70));
    console.log('   CROSS-VENUE ARBITRAGE TRACKER');
    console.log('═'.repeat(70));
    console.log('');
    console.log('   PHASE 1: Detect new PumpSwap → External listings (snipe)');
    console.log('   PHASE 2: Monitor multi-venue tokens for sustained arbs');
    console.log('');
    console.log('   Conditions for Phase 2:');
    console.log(`      • Spread ≥ ${MIN_SPREAD_BPS} bps`);
    console.log(`      • Liquidity ≥ ${MIN_LIQUIDITY_SOL} SOL`);
    console.log(`      • High volume: ≥ ${HIGH_VOLUME_SOL_PER_MIN} SOL/min`);
    console.log(`      • High volatility: ≥ ${HIGH_VOLATILITY_PCT}% price range/5min`);
    console.log('');
    console.log(`   Data: ${DATA_FILE}`);
    console.log('═'.repeat(70));
    console.log('');

    loadData();
    connect();

    // Stats every 60s
    setInterval(printStats, 60000);

    // Save every 30s
    setInterval(saveData, 30000);

    // Cleanup old tokens every 5 min
    setInterval(() => {
        const now = Date.now();
        for (const [mint, token] of tokens) {
            if (token.phase === 'COOLING') {
                const lastActivity = Math.max(
                    ...Array.from(token.venues.values()).map(v => v.lastTrade),
                    token.firstSeen
                );
                if (now - lastActivity > TRACK_TIMEOUT_MS * 2) {
                    tokens.delete(mint);
                }
            }
        }
    }, 5 * 60 * 1000);

    process.on('SIGINT', () => {
        log('\nSaving and exiting...');
        saveData();
        process.exit(0);
    });
}

main();
