import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const SOL = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC, 'confirmed');

// Jupiter quote API
const JUPITER_QUOTE = 'https://quote-api.jup.ag/v6/quote';

async function getJupiterQuote(inputMint, outputMint, amount) {
    const url = `${JUPITER_QUOTE}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50`;

    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

async function findActiveTokens() {
    console.log('Fetching active tokens from Jupiter...');

    // Get Jupiter's token list
    const resp = await fetch('https://token.jup.ag/strict');
    const tokens = await resp.json();

    console.log(`  Found ${tokens.length} strict-list tokens`);
    return tokens;
}

async function checkArbitrage(tokenMint, tokenSymbol) {
    // Quote: SOL -> Token
    const buyQuote = await getJupiterQuote(SOL, tokenMint, 1000000000); // 1 SOL
    if (!buyQuote || !buyQuote.outAmount) return null;

    // Quote: Token -> SOL (using amount we'd get from buying)
    const sellQuote = await getJupiterQuote(tokenMint, SOL, buyQuote.outAmount);
    if (!sellQuote || !sellQuote.outAmount) return null;

    const solIn = 1;
    const solOut = Number(sellQuote.outAmount) / 1e9;
    const profit = solOut - solIn;
    const profitPct = (profit / solIn) * 100;

    // Check if routes use different venues
    const buyVenue = buyQuote.routePlan?.[0]?.swapInfo?.label || 'Unknown';
    const sellVenue = sellQuote.routePlan?.[0]?.swapInfo?.label || 'Unknown';

    return {
        token: tokenSymbol,
        mint: tokenMint,
        solIn,
        solOut,
        profit,
        profitPct,
        buyVenue,
        sellVenue,
        buyRoute: buyQuote.routePlan?.map(r => r.swapInfo?.label).join(' → '),
        sellRoute: sellQuote.routePlan?.map(r => r.swapInfo?.label).join(' → ')
    };
}

async function main() {
    console.log('═'.repeat(70));
    console.log('JUPITER ARBITRAGE SCANNER');
    console.log('═'.repeat(70));
    console.log('Using Jupiter aggregator to find cross-venue opportunities');
    console.log('═'.repeat(70) + '\n');

    const tokens = await findActiveTokens();

    // Filter to likely memecoin/pump tokens (low liquidity, recent)
    // For now just test with a sample
    const testTokens = tokens.slice(0, 50);

    console.log(`\nTesting ${testTokens.length} tokens for round-trip profit...\n`);

    const opportunities = [];

    for (let i = 0; i < testTokens.length; i++) {
        const token = testTokens[i];
        if (token.address === SOL) continue;

        process.stdout.write(`\rChecking ${i + 1}/${testTokens.length}: ${token.symbol?.padEnd(10) || 'Unknown'}...`);

        const result = await checkArbitrage(token.address, token.symbol);

        if (result && result.profitPct > -1) { // Show anything better than -1%
            opportunities.push(result);

            if (result.profitPct > 0) {
                console.log(`\n🎯 ${result.token}: ${result.profitPct.toFixed(2)}% profit!`);
                console.log(`   Buy via: ${result.buyRoute}`);
                console.log(`   Sell via: ${result.sellRoute}`);
            }
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 200));
    }

    console.log('\n\n' + '─'.repeat(70));
    console.log('RESULTS');
    console.log('─'.repeat(70));

    opportunities.sort((a, b) => b.profitPct - a.profitPct);

    console.log('\nTop 20 by round-trip profit:');
    for (const opp of opportunities.slice(0, 20)) {
        const sign = opp.profitPct >= 0 ? '+' : '';
        console.log(`  ${opp.token?.padEnd(10)} ${sign}${opp.profitPct.toFixed(2)}% | Buy: ${opp.buyVenue} | Sell: ${opp.sellVenue}`);
    }

    const profitable = opportunities.filter(o => o.profitPct > 0);
    console.log(`\nTokens with positive round-trip: ${profitable.length}`);

    if (profitable.length > 0) {
        console.log('\nProfitable opportunities:');
        for (const opp of profitable) {
            console.log(`  ${opp.token}: ${opp.profitPct.toFixed(2)}%`);
            console.log(`    1 SOL → ${opp.buyRoute} → ${opp.sellRoute} → ${opp.solOut.toFixed(4)} SOL`);
            console.log(`    Profit: ${opp.profit.toFixed(4)} SOL`);
        }
    }
}

main().catch(console.error);