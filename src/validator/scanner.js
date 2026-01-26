import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL = 'So11111111111111111111111111111111111111112';

const priceCache = new Map();
const opportunities = [];
let spreadsFound = 0;
const startTime = Date.now();

function parsePumpSwapPool(data) {
    if (data.length < 130) return null;
    try {
        const baseMint = new PublicKey(data.slice(42, 74)).toBase58();
        const quoteMint = new PublicKey(data.slice(74, 106)).toBase58();
        const baseReserve = data.readBigUInt64LE(114);
        const quoteReserve = data.readBigUInt64LE(122);

        if (baseReserve === 0n || quoteReserve === 0n) return null;

        const isQuoteSOL = quoteMint === SOL;
        const isBaseSOL = baseMint === SOL;
        if (!isQuoteSOL && !isBaseSOL) return null;

        const token = isQuoteSOL ? baseMint : quoteMint;
        const solReserve = isQuoteSOL ? quoteReserve : baseReserve;
        const tokenReserve = isQuoteSOL ? baseReserve : quoteReserve;

        return {
            token,
            price: Number(solReserve) / Number(tokenReserve),
            liquidity: Number(solReserve) / 1e9,
            venue: 'PumpSwap'
        };
    } catch { return null; }
}

function parseRaydiumV4Pool(data) {
    if (data.length < 680) return null;
    try {
        const status = data.readBigUInt64LE(0);
        if (status !== 6n) return null;

        const baseMint = new PublicKey(data.slice(400, 432)).toBase58();
        const quoteMint = new PublicKey(data.slice(432, 464)).toBase58();
        const baseVault = new PublicKey(data.slice(336, 368)).toBase58();
        const quoteVault = new PublicKey(data.slice(368, 400)).toBase58();

        const isQuoteSOL = quoteMint === SOL;
        const isBaseSOL = baseMint === SOL;
        if (!isQuoteSOL && !isBaseSOL) return null;

        const token = isQuoteSOL ? baseMint : quoteMint;

        return {
            token,
            baseMint,
            quoteMint,
            baseVault,
            quoteVault,
            venue: 'RaydiumV4'
        };
    } catch { return null; }
}

function updateCache(poolAddr, parsed) {
    if (!parsed || !parsed.token) return;

    if (!priceCache.has(parsed.token)) {
        priceCache.set(parsed.token, new Map());
    }

    const existing = priceCache.get(parsed.token).get(parsed.venue) || {};

    priceCache.get(parsed.token).set(parsed.venue, {
        ...existing,
        ...parsed,
        pool: poolAddr,
        lastUpdate: Date.now()
    });
}

function checkSpread(token) {
    const venues = priceCache.get(token);
    if (!venues || venues.size < 2) return;

    const entries = Array.from(venues.entries()).filter(([v, d]) => d.price && d.price > 0);
    if (entries.length < 2) return;

    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [v1, d1] = entries[i];
            const [v2, d2] = entries[j];

            const spread = Math.abs(d1.price - d2.price) / Math.min(d1.price, d2.price);

            if (spread >= 0.003) {
                const buy = d1.price < d2.price ? { venue: v1, ...d1 } : { venue: v2, ...d2 };
                const sell = d1.price < d2.price ? { venue: v2, ...d2 } : { venue: v1, ...d1 };

                const opp = {
                    token: token.slice(0, 8),
                    tokenFull: token,
                    spread: (spread * 100).toFixed(2) + '%',
                    spreadRaw: spread,
                    buyVenue: buy.venue,
                    sellVenue: sell.venue,
                    buyPrice: buy.price,
                    sellPrice: sell.price,
                    minLiq: Math.min(buy.liquidity || 0, sell.liquidity || 0),
                    est: (spread * 0.5).toFixed(4),
                    time: new Date().toISOString().slice(11, 23)
                };

                console.log(`🎯 ${opp.time} | ${opp.token} | ${opp.spread} | BUY:${opp.buyVenue} SELL:${opp.sellVenue} | Liq:${opp.minLiq.toFixed(1)}SOL | ~${opp.est}SOL`);
                opportunities.push(opp);
                spreadsFound++;
            }
        }
    }
}

async function loadPumpSwapPools(connection) {
    console.log('Loading PumpSwap pools...');
    const accounts = await connection.getProgramAccounts(PUMPSWAP, {
        filters: [{ dataSize: 211 }]
    });

    let loaded = 0;
    for (const acc of accounts) {
        const parsed = parsePumpSwapPool(acc.account.data);
        if (parsed && parsed.price) {
            updateCache(acc.pubkey.toBase58(), parsed);
            loaded++;
        }
    }
    console.log(`  Loaded ${loaded} PumpSwap pools`);
    return loaded;
}

async function loadRaydiumV4Pools(connection) {
    console.log('Loading Raydium V4 SOL pairs (memcmp filtered)...');

    // SOL as quote
    const quoteAccounts = await connection.getProgramAccounts(RAYDIUM_V4, {
        filters: [
            { dataSize: 752 },
            { memcmp: { offset: 432, bytes: SOL } }
        ]
    });
    console.log(`  Found ${quoteAccounts.length} SOL-quote pools`);

    // SOL as base
    const baseAccounts = await connection.getProgramAccounts(RAYDIUM_V4, {
        filters: [
            { dataSize: 752 },
            { memcmp: { offset: 400, bytes: SOL } }
        ]
    });
    console.log(`  Found ${baseAccounts.length} SOL-base pools`);

    const allAccounts = [...quoteAccounts, ...baseAccounts];
    let loaded = 0;

    for (const acc of allAccounts) {
        const parsed = parseRaydiumV4Pool(acc.account.data);
        if (parsed) {
            updateCache(acc.pubkey.toBase58(), parsed);
            loaded++;
        }
    }

    console.log(`  Loaded ${loaded} active Raydium V4 pools`);
    return loaded;
}

async function getVaultBalances(connection) {
    const vaultAddresses = [];
    const vaultMap = new Map();

    for (const [token, venues] of priceCache) {
        const rayData = venues.get('RaydiumV4');
        if (rayData && rayData.baseVault && !rayData.price) {
            vaultAddresses.push(rayData.baseVault, rayData.quoteVault);
            vaultMap.set(rayData.baseVault, { token, rayData });
            vaultMap.set(rayData.quoteVault, { token, rayData });
        }
    }

    if (vaultAddresses.length === 0) return 0;

    console.log(`Fetching ${vaultAddresses.length} vault balances...`);

    const balances = new Map();
    const chunkSize = 100;

    for (let i = 0; i < vaultAddresses.length; i += chunkSize) {
        const chunk = vaultAddresses.slice(i, i + chunkSize);
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(a => new PublicKey(a)));
            for (let j = 0; j < infos.length; j++) {
                if (infos[j] && infos[j].data.length >= 72) {
                    balances.set(chunk[j], infos[j].data.readBigUInt64LE(64));
                }
            }
        } catch { }
    }

    let priced = 0;
    for (const [token, venues] of priceCache) {
        const rayData = venues.get('RaydiumV4');
        if (!rayData || !rayData.baseVault || rayData.price) continue;

        const baseBalance = balances.get(rayData.baseVault);
        const quoteBalance = balances.get(rayData.quoteVault);

        if (baseBalance && quoteBalance && baseBalance > 0n && quoteBalance > 0n) {
            const isQuoteSOL = rayData.quoteMint === SOL;
            const solBalance = isQuoteSOL ? quoteBalance : baseBalance;
            const tokenBalance = isQuoteSOL ? baseBalance : quoteBalance;

            rayData.price = Number(solBalance) / Number(tokenBalance);
            rayData.liquidity = Number(solBalance) / 1e9;
            priced++;
        }
    }

    console.log(`  Priced ${priced} Raydium pools`);
    return priced;
}

function printStats() {
    const runtime = (Date.now() - startTime) / 60000;
    const rate = spreadsFound / runtime * 60;

    let multi = 0, multiPriced = 0;
    for (const [t, v] of priceCache) {
        if (v.size >= 2) {
            multi++;
            if (Array.from(v.values()).filter(d => d.price).length >= 2) multiPriced++;
        }
    }

    console.log('\n' + '─'.repeat(70));
    console.log(`STATS | ${runtime.toFixed(1)}min | ${priceCache.size} tokens | ${multi} multi-venue (${multiPriced} priced) | ${spreadsFound} opps | ${rate.toFixed(1)}/hr`);

    if (opportunities.length > 0) {
        const avg = opportunities.reduce((s, o) => s + o.spreadRaw, 0) / opportunities.length;
        const proj = opportunities.reduce((s, o) => s + parseFloat(o.est), 0) / runtime * 60 * 24;
        console.log(`AVG SPREAD: ${(avg * 100).toFixed(2)}% | PROJECTED: ${proj.toFixed(2)} SOL/day`);
    }
    console.log('─'.repeat(70) + '\n');
}

async function main() {
    console.log('═'.repeat(70));
    console.log('CROSS-VENUE ARBITRAGE SCANNER v3');
    console.log('═'.repeat(70) + '\n');

    const connection = new Connection(RPC, {
        wsEndpoint: WSS,
        commitment: 'confirmed'
    });

    await loadPumpSwapPools(connection);
    await loadRaydiumV4Pools(connection);
    await getVaultBalances(connection);

    let multi = 0, multiPriced = 0;
    for (const [t, v] of priceCache) {
        if (v.size >= 2) {
            multi++;
            if (Array.from(v.values()).filter(d => d.price).length >= 2) multiPriced++;
        }
    }
    console.log(`\n✓ ${multi} tokens on multiple venues (${multiPriced} with prices on both)`);

    console.log('\nChecking initial spreads...');
    for (const token of priceCache.keys()) {
        checkSpread(token);
    }

    console.log('\nSubscribing to updates...');

    connection.onProgramAccountChange(
        PUMPSWAP,
        (info) => {
            const parsed = parsePumpSwapPool(info.accountInfo.data);
            if (parsed) {
                updateCache(info.accountId.toBase58(), parsed);
                checkSpread(parsed.token);
            }
        },
        'processed',
        [{ dataSize: 211 }]
    );
    console.log('  ✓ PumpSwap');

    console.log('\n🔍 Monitoring... (Ctrl+C to stop)\n');

    setInterval(printStats, 60000);

    setInterval(async () => {
        try {
            await getVaultBalances(connection);
            for (const token of priceCache.keys()) checkSpread(token);
        } catch { }
    }, 30000);

    process.on('SIGINT', () => {
        printStats();
        fs.writeFileSync('opportunities.json', JSON.stringify(opportunities, null, 2));
        console.log(`Saved ${opportunities.length} opportunities`);
        process.exit(0);
    });
}

main().catch(console.error);