import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL = 'So11111111111111111111111111111111111111112';
const WSOL = new PublicKey(SOL);

const connection = new Connection(RPC, 'confirmed');

async function getPumpSwapTokens() {
    console.log('Loading PumpSwap pools...');

    const accounts = await connection.getProgramAccounts(PUMPSWAP, {
        filters: [{ dataSize: 211 }]
    });

    console.log(`  Found ${accounts.length} PumpSwap pool accounts`);

    const tokens = new Map();
    let debugged = 0;

    for (const acc of accounts) {
        try {
            const data = acc.account.data;
            const baseMint = new PublicKey(data.slice(42, 74)).toBase58();
            const quoteMint = new PublicKey(data.slice(74, 106)).toBase58();
            const baseReserve = data.readBigUInt64LE(114);
            const quoteReserve = data.readBigUInt64LE(122);

            // Debug first few to see what mints look like
            if (debugged < 3 && baseReserve > 0n) {
                console.log(`  DEBUG pool ${acc.pubkey.toBase58().slice(0, 16)}...`);
                console.log(`    baseMint: ${baseMint}`);
                console.log(`    quoteMint: ${quoteMint}`);
                console.log(`    baseReserve: ${baseReserve}`);
                console.log(`    quoteReserve: ${quoteReserve}`);
                console.log(`    Is quote SOL? ${quoteMint === SOL}`);
                debugged++;
            }

            if (baseReserve === 0n || quoteReserve === 0n) continue;

            // Don't filter by SOL - just track which is SOL
            const isQuoteSOL = quoteMint === SOL;
            const isBaseSOL = baseMint === SOL;

            if (!isQuoteSOL && !isBaseSOL) continue; // Skip non-SOL pairs

            const token = isQuoteSOL ? baseMint : quoteMint;
            const solReserve = isQuoteSOL ? quoteReserve : baseReserve;
            const tokenReserve = isQuoteSOL ? baseReserve : quoteReserve;

            tokens.set(token, {
                pool: acc.pubkey.toBase58(),
                liquidity: Number(solReserve) / 1e9,
                price: Number(solReserve) / Number(tokenReserve),
                venue: 'PumpSwap'
            });
        } catch { }
    }

    console.log(`  Loaded ${tokens.size} PumpSwap SOL pairs with liquidity`);
    return tokens;
}

async function getRaydiumV4Tokens() {
    console.log('Loading Raydium V4 SOL-quote pools (using memcmp filter)...');

    // Use memcmp to filter for pools where quoteMint = SOL
    // This dramatically reduces response size
    const accounts = await connection.getProgramAccounts(RAYDIUM_V4, {
        filters: [
            { dataSize: 752 },
            { memcmp: { offset: 432, bytes: SOL } } // quoteMint at offset 432
        ]
    });

    console.log(`  Found ${accounts.length} Raydium V4 SOL-quote pools`);

    const tokens = new Map();

    for (const acc of accounts) {
        try {
            const data = acc.account.data;

            const status = data.readBigUInt64LE(0);
            if (status !== 6n) continue;

            const baseMint = new PublicKey(data.slice(400, 432)).toBase58();
            const quoteMint = new PublicKey(data.slice(432, 464)).toBase58();
            const baseVault = new PublicKey(data.slice(336, 368)).toBase58();
            const quoteVault = new PublicKey(data.slice(368, 400)).toBase58();

            tokens.set(baseMint, {
                pool: acc.pubkey.toBase58(),
                baseVault,
                quoteVault,
                baseMint,
                quoteMint,
                venue: 'RaydiumV4'
            });
        } catch { }
    }

    console.log(`  Parsed ${tokens.size} active Raydium V4 SOL pairs`);

    // Also try SOL-base pools
    console.log('Loading Raydium V4 SOL-base pools...');
    try {
        const baseAccounts = await connection.getProgramAccounts(RAYDIUM_V4, {
            filters: [
                { dataSize: 752 },
                { memcmp: { offset: 400, bytes: SOL } } // baseMint at offset 400
            ]
        });

        console.log(`  Found ${baseAccounts.length} Raydium V4 SOL-base pools`);

        for (const acc of baseAccounts) {
            try {
                const data = acc.account.data;
                const status = data.readBigUInt64LE(0);
                if (status !== 6n) continue;

                const baseMint = new PublicKey(data.slice(400, 432)).toBase58();
                const quoteMint = new PublicKey(data.slice(432, 464)).toBase58();
                const baseVault = new PublicKey(data.slice(336, 368)).toBase58();
                const quoteVault = new PublicKey(data.slice(368, 400)).toBase58();

                // Here SOL is base, so token is quote
                if (!tokens.has(quoteMint)) {
                    tokens.set(quoteMint, {
                        pool: acc.pubkey.toBase58(),
                        baseVault,
                        quoteVault,
                        baseMint,
                        quoteMint,
                        venue: 'RaydiumV4'
                    });
                }
            } catch { }
        }

        console.log(`  Total: ${tokens.size} Raydium V4 SOL pairs`);
    } catch (e) {
        console.log(`  SOL-base query failed: ${e.message}`);
    }

    return tokens;
}

async function getVaultBalances(raydiumTokens) {
    if (raydiumTokens.size === 0) return;

    console.log('Fetching Raydium vault balances...');

    const vaultAddresses = [];

    for (const [token, data] of raydiumTokens) {
        vaultAddresses.push(data.baseVault, data.quoteVault);
    }

    console.log(`  Fetching ${vaultAddresses.length} vaults...`);

    const balances = new Map();
    const chunkSize = 100;

    for (let i = 0; i < vaultAddresses.length; i += chunkSize) {
        const chunk = vaultAddresses.slice(i, i + chunkSize);
        const pubkeys = chunk.map(a => new PublicKey(a));

        try {
            const infos = await connection.getMultipleAccountsInfo(pubkeys);
            for (let j = 0; j < infos.length; j++) {
                if (infos[j] && infos[j].data.length >= 72) {
                    const balance = infos[j].data.readBigUInt64LE(64);
                    balances.set(chunk[j], balance);
                }
            }
        } catch { }
    }

    let priced = 0;
    for (const [token, data] of raydiumTokens) {
        const baseBalance = balances.get(data.baseVault);
        const quoteBalance = balances.get(data.quoteVault);

        if (baseBalance && quoteBalance && baseBalance > 0n && quoteBalance > 0n) {
            const isQuoteSOL = data.quoteMint === SOL;
            const solBalance = isQuoteSOL ? quoteBalance : baseBalance;
            const tokenBalance = isQuoteSOL ? baseBalance : quoteBalance;

            data.price = Number(solBalance) / Number(tokenBalance);
            data.liquidity = Number(solBalance) / 1e9;
            priced++;
        }
    }

    console.log(`  Priced ${priced} pools`);
}

async function main() {
    console.log('═'.repeat(70));
    console.log('MULTI-VENUE TOKEN FINDER v3');
    console.log('═'.repeat(70) + '\n');

    const pumpswapTokens = await getPumpSwapTokens();
    const raydiumTokens = await getRaydiumV4Tokens();
    await getVaultBalances(raydiumTokens);

    console.log('\n' + '─'.repeat(70));
    console.log('FINDING OVERLAPPING TOKENS');
    console.log('─'.repeat(70));

    const multiVenue = [];

    for (const [token, pumpData] of pumpswapTokens) {
        if (raydiumTokens.has(token)) {
            const rayData = raydiumTokens.get(token);

            if (pumpData.price && rayData.price) {
                const spread = Math.abs(pumpData.price - rayData.price) / Math.min(pumpData.price, rayData.price);

                multiVenue.push({
                    token,
                    pumpswap: pumpData,
                    raydium: rayData,
                    spread,
                    minLiquidity: Math.min(pumpData.liquidity, rayData.liquidity || 0)
                });
            }
        }
    }

    console.log(`\n✓ Found ${multiVenue.length} tokens on BOTH venues with prices\n`);

    if (multiVenue.length === 0) {
        console.log('No overlapping tokens found.');
        console.log(`PumpSwap tokens: ${pumpswapTokens.size}`);
        console.log(`Raydium tokens: ${raydiumTokens.size}`);

        // Show sample tokens from each
        console.log('\nSample PumpSwap tokens:');
        let i = 0;
        for (const [token, data] of pumpswapTokens) {
            if (i++ >= 5) break;
            console.log(`  ${token.slice(0, 20)}... Liq: ${data.liquidity.toFixed(2)} SOL`);
        }

        console.log('\nSample Raydium tokens:');
        i = 0;
        for (const [token, data] of raydiumTokens) {
            if (i++ >= 5) break;
            console.log(`  ${token.slice(0, 20)}... Liq: ${data.liquidity?.toFixed(2) || '?'} SOL`);
        }
        return;
    }

    multiVenue.sort((a, b) => b.minLiquidity - a.minLiquidity);

    console.log('TOP 30 BY LIQUIDITY:');
    console.log('─'.repeat(70));

    for (const mv of multiVenue.slice(0, 30)) {
        const spreadPct = (mv.spread * 100).toFixed(2) + '%';
        const highlight = mv.spread >= 0.003 ? '🎯' : '  ';
        console.log(`${highlight} ${mv.token.slice(0, 16)}... | Spread: ${spreadPct.padStart(6)} | Liq: ${mv.minLiquidity.toFixed(1)} SOL`);
    }

    const opps03 = multiVenue.filter(m => m.spread >= 0.003);
    const opps05 = multiVenue.filter(m => m.spread >= 0.005);
    const opps1 = multiVenue.filter(m => m.spread >= 0.01);

    console.log('\n' + '─'.repeat(70));
    console.log('SPREAD OPPORTUNITIES RIGHT NOW:');
    console.log(`  ≥0.3%: ${opps03.length} | ≥0.5%: ${opps05.length} | ≥1.0%: ${opps1.length}`);
    console.log('─'.repeat(70));

    if (opps05.length > 0) {
        console.log('\nTokens with ≥0.5% spread:');
        for (const opp of opps05.slice(0, 10)) {
            const buy = opp.pumpswap.price < opp.raydium.price ? 'PumpSwap' : 'Raydium';
            const sell = buy === 'PumpSwap' ? 'Raydium' : 'PumpSwap';
            console.log(`  ${opp.token.slice(0, 16)}... ${(opp.spread * 100).toFixed(2)}% BUY:${buy} SELL:${sell}`);
        }
    }

    const output = {
        timestamp: new Date().toISOString(),
        pumpswapCount: pumpswapTokens.size,
        raydiumCount: raydiumTokens.size,
        multiVenueCount: multiVenue.length,
        tokens: multiVenue.map(mv => ({
            mint: mv.token,
            spread: mv.spread,
            minLiquidity: mv.minLiquidity,
            pumpswapPrice: mv.pumpswap.price,
            raydiumPrice: mv.raydium.price
        }))
    };

    fs.writeFileSync('multi_venue_tokens.json', JSON.stringify(output, null, 2));
    console.log('\n✓ Saved to multi_venue_tokens.json');
}

main().catch(console.error);