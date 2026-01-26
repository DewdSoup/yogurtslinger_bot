import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const WSS = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const SOL = 'So11111111111111111111111111111111111111112';

let trades = [];
let largeTrades = [];
const startTime = Date.now();

const connection = new Connection(RPC, {
    wsEndpoint: WSS,
    commitment: 'confirmed'
});

async function analyzeTransaction(sig, venue) {
    try {
        const tx = await connection.getParsedTransaction(sig, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });

        if (!tx || !tx.meta || tx.meta.err) return null;

        const preBalances = tx.meta.preTokenBalances || [];
        const postBalances = tx.meta.postTokenBalances || [];

        let solDelta = 0;
        let tokenMint = null;
        let tokenDelta = 0;

        // Track SOL changes from lamport balances
        const preLamports = tx.meta.preBalances || [];
        const postLamports = tx.meta.postBalances || [];

        // Find token balance changes
        for (const post of postBalances) {
            const pre = preBalances.find(p =>
                p.accountIndex === post.accountIndex && p.mint === post.mint
            );

            const postAmt = parseFloat(post.uiTokenAmount?.uiAmount || 0);
            const preAmt = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || 0) : 0;
            const delta = postAmt - preAmt;

            if (Math.abs(delta) < 0.000001) continue;

            if (post.mint === SOL) {
                solDelta += delta;
            } else if (!tokenMint) {
                tokenMint = post.mint;
                tokenDelta = delta;
            }
        }

        if (!tokenMint || Math.abs(solDelta) < 0.001) return null;

        const direction = solDelta < 0 ? 'BUY' : 'SELL';
        const solAmount = Math.abs(solDelta);

        return {
            venue,
            token: tokenMint,
            direction,
            solAmount,
            tokenAmount: Math.abs(tokenDelta),
            price: tokenDelta !== 0 ? Math.abs(solDelta / tokenDelta) : 0,
            sig: sig.slice(0, 16),
            time: new Date().toISOString().slice(11, 23)
        };
    } catch (e) {
        return null;
    }
}

async function main() {
    console.log('═'.repeat(70));
    console.log('TRADE FLOW MONITOR v2');
    console.log('═'.repeat(70));
    console.log('Watching PumpSwap + Raydium V4 via logsSubscribe');
    console.log('Large trades (>1 SOL) create spread opportunities');
    console.log('═'.repeat(70) + '\n');

    // Subscribe to PumpSwap logs
    connection.onLogs(
        PUMPSWAP,
        async (logs, ctx) => {
            if (logs.err) return;
            const trade = await analyzeTransaction(logs.signature, 'PumpSwap');
            if (trade) {
                trades.push(trade);
                if (trade.solAmount >= 1) {
                    largeTrades.push(trade);
                    console.log(`\n🐋 LARGE ${trade.direction} | PumpSwap | ${trade.solAmount.toFixed(2)} SOL | ${trade.token.slice(0, 8)}`);
                    console.log(`   → Check Raydium for ${trade.token.slice(0, 8)} spread`);
                } else if (trade.solAmount >= 0.1) {
                    console.log(`📊 ${trade.time} | PumpSwap   | ${trade.direction.padEnd(4)} | ${trade.solAmount.toFixed(3).padStart(7)} SOL | ${trade.token.slice(0, 8)}`);
                }
            }
        },
        'confirmed'
    );
    console.log('✓ PumpSwap logs subscribed');

    // Subscribe to Raydium V4 logs
    connection.onLogs(
        RAYDIUM_V4,
        async (logs, ctx) => {
            if (logs.err) return;
            const trade = await analyzeTransaction(logs.signature, 'RaydiumV4');
            if (trade) {
                trades.push(trade);
                if (trade.solAmount >= 1) {
                    largeTrades.push(trade);
                    console.log(`\n🐋 LARGE ${trade.direction} | RaydiumV4 | ${trade.solAmount.toFixed(2)} SOL | ${trade.token.slice(0, 8)}`);
                    console.log(`   → Check PumpSwap for ${trade.token.slice(0, 8)} spread`);
                } else if (trade.solAmount >= 0.1) {
                    console.log(`📊 ${trade.time} | RaydiumV4  | ${trade.direction.padEnd(4)} | ${trade.solAmount.toFixed(3).padStart(7)} SOL | ${trade.token.slice(0, 8)}`);
                }
            }
        },
        'confirmed'
    );
    console.log('✓ Raydium V4 logs subscribed');

    console.log('\n🔍 Monitoring trade flow... (Ctrl+C to stop)\n');

    // Stats every minute
    setInterval(() => {
        const runtime = (Date.now() - startTime) / 60000;
        const tpm = trades.length / runtime;

        const byVenue = {};
        let totalVol = 0;
        for (const t of trades) {
            byVenue[t.venue] = (byVenue[t.venue] || 0) + 1;
            totalVol += t.solAmount;
        }

        console.log('\n' + '─'.repeat(70));
        console.log(`FLOW | ${runtime.toFixed(1)}min | ${trades.length} trades | ${tpm.toFixed(1)}/min | ${largeTrades.length} large (>1 SOL)`);
        console.log(`VOL: ${totalVol.toFixed(1)} SOL | ${Object.entries(byVenue).map(([k, v]) => `${k}:${v}`).join(' | ')}`);
        console.log('─'.repeat(70) + '\n');
    }, 60000);

    process.on('SIGINT', () => {
        console.log(`\n\nLarge trades detected:`);
        for (const t of largeTrades.slice(-20)) {
            console.log(`  ${t.direction} ${t.solAmount.toFixed(2)} SOL on ${t.venue} - ${t.token}`);
        }
        process.exit(0);
    });
}

main().catch(console.error);