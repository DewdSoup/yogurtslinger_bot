import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC, 'confirmed');

/*
  PumpSwap layout:
  - baseMint: 43-75
  - quoteMint: 75-107 (WSOL)
  - tokenVault: 139-171
  - solVault: 171-203
*/

async function getPumpSwapTokens() {
    console.log('Loading PumpSwap SOL pools...');

    const accounts = await connection.getProgramAccounts(PUMPSWAP, {
        filters: [
            { dataSize: 211 },
            { memcmp: { offset: 75, bytes: SOL } }
        ]
    });

    console.log(`  Found ${accounts.length} pools`);

    // Extract data
    const poolInfo = [];
    const solVaults = [];
    const tokenVaults = [];

    for (const acc of accounts) {
        const data = acc.account.data;
        const baseMint = new PublicKey(data.slice(43, 75)).toBase58();
        const tokenVault = new PublicKey(data.slice(139, 171)).toBase58();
        const solVault = new PublicKey(data.slice(171, 203)).toBase58();

        solVaults.push(solVault);
        tokenVaults.push(tokenVault);
        poolInfo.push({ pool: acc.pubkey.toBase58(), baseMint, tokenVault, solVault });
    }

    // Fetch balances
    console.log(`  Fetching vault balances...`);

    const solBalances = new Map();
    const tokenBalances = new Map();
    const chunkSize = 100;

    for (let i = 0; i < solVaults.length; i += chunkSize) {
        const solChunk = solVaults.slice(i, i + chunkSize);
        const tokenChunk = tokenVaults.slice(i, i + chunkSize);

        try {
            const solInfos = await connection.getMultipleAccountsInfo(solChunk.map(a => new PublicKey(a)));
            const tokenInfos = await connection.getMultipleAccountsInfo(tokenChunk.map(a => new PublicKey(a)));

            for (let j = 0; j < solInfos.length; j++) {
                if (solInfos[j]?.data.length === 165) {
                    solBalances.set(solChunk[j], Number(solInfos[j].data.readBigUInt64LE(64)));
                }
                if (tokenInfos[j]?.data.length === 165) {
                    tokenBalances.set(tokenChunk[j], Number(tokenInfos[j].data.readBigUInt64LE(64)));
                }
            }
        } catch { }

        if (i % 5000 === 0 && i > 0) process.stdout.write(`  ${i}/${solVaults.length}\r`);
    }

    // Build token map
    const tokens = new Map();

    for (const info of poolInfo) {
        const solAmount = solBalances.get(info.solVault);
        const tokenAmount = tokenBalances.get(info.tokenVault);

        if (!solAmount || !tokenAmount || solAmount === 0 || tokenAmount === 0) continue;

        const liquidity = solAmount / 1e9;
        if (liquidity < 0.1) continue; // Min 0.1 SOL for arb

        const price = solAmount / tokenAmount;

        const existing = tokens.get(info.baseMint);
        if (!existing || liquidity > existing.liquidity) {
            tokens.set(info.baseMint, {
                pool: info.pool,
                price,
                liquidity,
                venue: 'PumpSwap'
            });
        }
    }

    console.log(`  Got ${tokens.size} tokens with ≥0.1 SOL liquidity`);
    return tokens;
}

async function checkRaydiumForTokens(tokenMints) {
    console.log(`\nChecking Raydium V4 for ${tokenMints.length} tokens...`);

    const raydiumPrices = new Map();
    let found = 0;

    for (let i = 0; i < tokenMints.length; i++) {
        const tokenMint = tokenMints[i];

        if (i % 50 === 0) {
            process.stdout.write(`  Checked ${i}/${tokenMints.length}, found ${found}\r`);
        }

        try {
            // Token as base, SOL as quote
            const pools = await connection.getProgramAccounts(RAYDIUM_V4, {
                filters: [
                    { dataSize: 752 },
                    { memcmp: { offset: 400, bytes: tokenMint } },
                    { memcmp: { offset: 432, bytes: SOL } }
                ]
            });

            if (pools.length === 0) {
                // Try SOL as base, token as quote
                const pools2 = await connection.getProgramAccounts(RAYDIUM_V4, {
                    filters: [
                        { dataSize: 752 },
                        { memcmp: { offset: 400, bytes: SOL } },
                        { memcmp: { offset: 432, bytes: tokenMint } }
                    ]
                });
                pools.push(...pools2);
            }

            if (pools.length === 0) continue;

            // Get best pool
            for (const pool of pools) {
                const data = pool.account.data;
                const status = data.readBigUInt64LE(0);
                if (status !== 6n) continue;

                const baseMint = new PublicKey(data.slice(400, 432)).toBase58();
                const quoteMint = new PublicKey(data.slice(432, 464)).toBase58();
                const baseVault = new PublicKey(data.slice(336, 368)).toBase58();
                const quoteVault = new PublicKey(data.slice(368, 400)).toBase58();

                const [baseInfo, quoteInfo] = await connection.getMultipleAccountsInfo([
                    new PublicKey(baseVault),
                    new PublicKey(quoteVault)
                ]);

                if (!baseInfo?.data || !quoteInfo?.data) continue;
                if (baseInfo.data.length < 72 || quoteInfo.data.length < 72) continue;

                const baseBalance = Number(baseInfo.data.readBigUInt64LE(64));
                const quoteBalance = Number(quoteInfo.data.readBigUInt64LE(64));

                if (baseBalance === 0 || quoteBalance === 0) continue;

                const isQuoteSOL = quoteMint === SOL;
                const solBalance = isQuoteSOL ? quoteBalance : baseBalance;
                const tokenBalance = isQuoteSOL ? baseBalance : quoteBalance;

                const price = solBalance / tokenBalance;
                const liquidity = solBalance / 1e9;

                if (liquidity < 0.1) continue;

                raydiumPrices.set(tokenMint, {
                    pool: pool.pubkey.toBase58(),
                    price,
                    liquidity,
                    venue: 'RaydiumV4'
                });
                found++;
                break;
            }
        } catch { }

        // Rate limit
        await new Promise(r => setTimeout(r, 30));
    }

    console.log(`\n  Found ${raydiumPrices.size} tokens on Raydium V4`);
    return raydiumPrices;
}

async function main() {
    console.log('═'.repeat(70));
    console.log('CROSS-VENUE ARBITRAGE FINDER');
    console.log('═'.repeat(70) + '\n');

    const pumpswapTokens = await getPumpSwapTokens();

    if (pumpswapTokens.size === 0) {
        console.log('No PumpSwap tokens found.');
        return;
    }

    // Sort by liquidity, check top tokens
    const sorted = Array.from(pumpswapTokens.entries())
        .sort((a, b) => b[1].liquidity - a[1].liquidity);

    console.log(`\nTop 10 PumpSwap tokens:`);
    for (const [token, data] of sorted.slice(0, 10)) {
        console.log(`  ${token.slice(0, 16)}... : ${data.liquidity.toFixed(2)} SOL`);
    }

    // Check top 200 on Raydium (balance speed vs coverage)
    const tokensToCheck = sorted.slice(0, 200).map(([token]) => token);
    const raydiumTokens = await checkRaydiumForTokens(tokensToCheck);

    // Find spreads
    console.log('\n' + '═'.repeat(70));
    console.log('SPREAD ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    const spreads = [];

    for (const [token, pumpData] of pumpswapTokens) {
        if (!raydiumTokens.has(token)) continue;

        const rayData = raydiumTokens.get(token);
        const spread = Math.abs(pumpData.price - rayData.price) / Math.min(pumpData.price, rayData.price);

        spreads.push({
            token,
            spread,
            pumpswapPrice: pumpData.price,
            raydiumPrice: rayData.price,
            pumpswapLiq: pumpData.liquidity,
            raydiumLiq: rayData.liquidity,
            minLiq: Math.min(pumpData.liquidity, rayData.liquidity),
            buyVenue: pumpData.price < rayData.price ? 'PumpSwap' : 'RaydiumV4',
            sellVenue: pumpData.price < rayData.price ? 'RaydiumV4' : 'PumpSwap'
        });
    }

    console.log(`Found ${spreads.length} tokens on BOTH venues\n`);

    if (spreads.length === 0) {
        console.log('No cross-venue tokens found.');

        // Save what we have
        fs.writeFileSync('cross_venue_result.json', JSON.stringify({
            timestamp: new Date().toISOString(),
            pumpswapTokens: pumpswapTokens.size,
            raydiumTokens: raydiumTokens.size,
            crossVenue: 0,
            note: 'No overlap found between PumpSwap and Raydium V4 for top 200 tokens'
        }, null, 2));
        return;
    }

    spreads.sort((a, b) => b.spread - a.spread);

    console.log('All cross-venue tokens by spread:');
    console.log('─'.repeat(70));

    for (const s of spreads) {
        const spreadPct = (s.spread * 100).toFixed(2);
        const highlight = s.spread >= 0.005 ? '🎯' : '  ';
        console.log(`${highlight} ${s.token.slice(0, 16)}... | ${spreadPct}% | BUY:${s.buyVenue} SELL:${s.sellVenue} | Liq: ${s.minLiq.toFixed(1)} SOL`);
    }

    const opps03 = spreads.filter(s => s.spread >= 0.003);
    const opps05 = spreads.filter(s => s.spread >= 0.005);
    const opps1 = spreads.filter(s => s.spread >= 0.01);

    console.log('\n' + '─'.repeat(70));
    console.log('SUMMARY:');
    console.log(`  Cross-venue tokens: ${spreads.length}`);
    console.log(`  ≥0.3% spread: ${opps03.length}`);
    console.log(`  ≥0.5% spread: ${opps05.length}`);
    console.log(`  ≥1.0% spread: ${opps1.length}`);
    console.log('─'.repeat(70));

    fs.writeFileSync('cross_venue_spreads.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        pumpswapTokens: pumpswapTokens.size,
        raydiumTokens: raydiumTokens.size,
        crossVenueTokens: spreads.length,
        opportunities: { spread03: opps03.length, spread05: opps05.length, spread1: opps1.length },
        spreads
    }, null, 2));

    console.log('\n✓ Saved to cross_venue_spreads.json');
}

main().catch(console.error);