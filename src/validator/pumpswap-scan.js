import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const SOL = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC, 'confirmed');

/*
  PumpSwap 211-byte pool layout (discovered):
  - Offset 43-75: baseMint (token)
  - Offset 75-107: quoteMint (WSOL)
  - Offset 139-171: Token vault
  - Offset 171-203: SOL vault
*/

async function getPumpSwapPools() {
    console.log('═'.repeat(70));
    console.log('PUMPSWAP POOL SCANNER (Fixed Offsets)');
    console.log('═'.repeat(70) + '\n');

    console.log('Loading PumpSwap SOL pools (WSOL at offset 75)...');

    const accounts = await connection.getProgramAccounts(PUMPSWAP, {
        filters: [
            { dataSize: 211 },
            { memcmp: { offset: 75, bytes: SOL } }
        ]
    });

    console.log(`  Found ${accounts.length} PumpSwap SOL pools\n`);

    // Extract vault addresses with CORRECT offsets
    const solVaultAddresses = [];
    const tokenVaultAddresses = [];
    const poolInfo = [];

    for (const acc of accounts) {
        const data = acc.account.data;
        const baseMint = new PublicKey(data.slice(43, 75)).toBase58();
        const tokenVault = new PublicKey(data.slice(139, 171)).toBase58();  // Token vault
        const solVault = new PublicKey(data.slice(171, 203)).toBase58();    // SOL vault

        solVaultAddresses.push(solVault);
        tokenVaultAddresses.push(tokenVault);
        poolInfo.push({
            pool: acc.pubkey.toBase58(),
            baseMint,
            tokenVault,
            solVault
        });
    }

    console.log(`Fetching SOL vault balances...`);

    // Fetch SOL vault balances
    const solBalances = new Map();
    const chunkSize = 100;

    for (let i = 0; i < solVaultAddresses.length; i += chunkSize) {
        const chunk = solVaultAddresses.slice(i, i + chunkSize);
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(a => new PublicKey(a)));
            for (let j = 0; j < infos.length; j++) {
                if (infos[j] && infos[j].data.length === 165) {
                    const amount = infos[j].data.readBigUInt64LE(64);
                    solBalances.set(chunk[j], Number(amount));
                }
            }
        } catch { }

        if (i % 5000 === 0 && i > 0) {
            console.log(`  Processed ${i}/${solVaultAddresses.length}...`);
        }
    }

    console.log(`  Got ${solBalances.size} SOL vault balances\n`);

    console.log(`Fetching token vault balances...`);

    // Fetch token vault balances
    const tokenBalances = new Map();

    for (let i = 0; i < tokenVaultAddresses.length; i += chunkSize) {
        const chunk = tokenVaultAddresses.slice(i, i + chunkSize);
        try {
            const infos = await connection.getMultipleAccountsInfo(chunk.map(a => new PublicKey(a)));
            for (let j = 0; j < infos.length; j++) {
                if (infos[j] && infos[j].data.length === 165) {
                    const amount = infos[j].data.readBigUInt64LE(64);
                    tokenBalances.set(chunk[j], Number(amount));
                }
            }
        } catch { }

        if (i % 5000 === 0 && i > 0) {
            console.log(`  Processed ${i}/${tokenVaultAddresses.length}...`);
        }
    }

    console.log(`  Got ${tokenBalances.size} token vault balances\n`);

    // Build price cache
    const tokens = new Map();
    let withLiquidity = 0;

    for (const info of poolInfo) {
        const solAmount = solBalances.get(info.solVault);
        const tokenAmount = tokenBalances.get(info.tokenVault);

        if (!solAmount || !tokenAmount || solAmount === 0 || tokenAmount === 0) continue;

        const liquidity = solAmount / 1e9;

        // Skip dust pools (less than 0.01 SOL)
        if (liquidity < 0.01) continue;

        withLiquidity++;

        const price = solAmount / tokenAmount;

        // Keep highest liquidity pool per token
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

    console.log(`Built cache: ${tokens.size} unique tokens with ≥0.01 SOL liquidity`);

    // Show top by liquidity
    const sorted = Array.from(tokens.entries()).sort((a, b) => b[1].liquidity - a[1].liquidity);

    console.log('\nTop 20 tokens by liquidity:');
    console.log('─'.repeat(70));
    for (const [token, data] of sorted.slice(0, 20)) {
        console.log(`  ${token.slice(0, 20)}... : ${data.liquidity.toFixed(2)} SOL`);
    }

    // Save
    const output = {
        timestamp: new Date().toISOString(),
        poolCount: accounts.length,
        tokensWithLiquidity: tokens.size,
        tokens: sorted.map(([mint, data]) => ({
            mint,
            liquidity: data.liquidity,
            price: data.price,
            pool: data.pool
        }))
    };

    fs.writeFileSync('pumpswap_pools.json', JSON.stringify(output, null, 2));
    console.log('\n✓ Saved to pumpswap_pools.json');

    return tokens;
}

async function main() {
    await getPumpSwapPools();
}

main().catch(console.error);