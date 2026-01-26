import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const SOL = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC, 'confirmed');

async function main() {
    console.log('═'.repeat(70));
    console.log('ANALYZING 300-BYTE POOLS (514k pools)');
    console.log('═'.repeat(70) + '\n');

    // STEP 1: Find WSOL offset in 300-byte pools
    console.log('STEP 1: Finding WSOL location in 300-byte pools...\n');

    const offsets = [43, 75, 107, 132, 139, 164, 171, 196, 203, 228, 260];
    let foundWsolOffset = null;

    for (const offset of offsets) {
        if (offset > 300 - 32) continue;
        try {
            const count = await connection.getProgramAccounts(PUMPSWAP, {
                filters: [
                    { dataSize: 300 },
                    { memcmp: { offset, bytes: SOL } }
                ],
                dataSlice: { offset: 0, length: 0 } // Just count, no data
            });
            console.log(`  WSOL at offset ${offset}: ${count.length.toLocaleString()} pools`);
            if (count.length > 100000 && !foundWsolOffset) {
                foundWsolOffset = offset;
            }
        } catch (e) {
            if (e.message.includes('string longer')) {
                console.log(`  WSOL at offset ${offset}: OVERFLOW (>500k pools) ✓`);
                foundWsolOffset = offset;
            }
        }
    }

    // STEP 2: Get pool addresses only (no data) to avoid overflow
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 2: Fetching pool addresses...\n');

    let poolAddresses;
    try {
        poolAddresses = await connection.getProgramAccounts(PUMPSWAP, {
            filters: [{ dataSize: 300 }],
            dataSlice: { offset: 0, length: 0 } // Just addresses!
        });
        console.log(`Found ${poolAddresses.length.toLocaleString()} pool addresses`);
    } catch (e) {
        console.log(`Error: ${e.message}`);
        return;
    }

    // STEP 3: Fetch a few pools individually
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 3: Analyzing sample pools...\n');

    const samplePools = [];
    for (let i = 0; i < Math.min(20, poolAddresses.length); i++) {
        const info = await connection.getAccountInfo(poolAddresses[i].pubkey);
        if (info) {
            samplePools.push({
                pubkey: poolAddresses[i].pubkey,
                data: info.data
            });
        }
    }
    console.log(`Fetched ${samplePools.length} sample pools\n`);

    // Analyze first pool
    const sample = samplePools[0];
    console.log(`Sample: ${sample.pubkey.toBase58()}`);
    console.log(`Solscan: https://solscan.io/account/${sample.pubkey.toBase58()}\n`);

    // Find WSOL mint positions
    console.log('WSOL mint locations:');
    for (let offset = 0; offset <= sample.data.length - 32; offset++) {
        try {
            const pk = new PublicKey(sample.data.slice(offset, offset + 32));
            if (pk.toBase58() === SOL) {
                console.log(`  Offset ${offset}: WSOL mint`);
            }
        } catch { }
    }

    // Find token account vaults
    console.log('\nToken account (vault) locations:');
    const vaults = [];

    for (let offset = 0; offset <= sample.data.length - 32; offset++) {
        try {
            const pk = new PublicKey(sample.data.slice(offset, offset + 32));
            const pkStr = pk.toBase58();
            if (pkStr === SOL || pkStr.endsWith('pump')) continue;

            const info = await connection.getAccountInfo(pk);
            if (info && info.data.length === 165) {
                const mint = new PublicKey(info.data.slice(0, 32)).toBase58();
                const amount = info.data.readBigUInt64LE(64);
                const isSol = mint === SOL;

                vaults.push({ offset, isSol, amount });

                const label = isSol ? '💰 SOL VAULT' : '🪙 TOKEN VAULT';
                const amtStr = isSol ? `${(Number(amount) / 1e9).toFixed(4)} SOL` : `${amount} tokens`;
                console.log(`  Offset ${offset}: ${label} - ${amtStr}`);
            }
        } catch { }
    }

    const solVault = vaults.find(v => v.isSol);
    const tokenVault = vaults.find(v => !v.isSol);

    // STEP 4: Sample many pools for liquidity
    if (solVault) {
        console.log('\n' + '─'.repeat(70));
        console.log(`STEP 4: Sampling pools (SOL vault at offset ${solVault.offset})...\n`);

        const solAmounts = [];

        // Sample from different parts of the pool list
        const indicesToCheck = [];
        for (let i = 0; i < 500; i++) {
            indicesToCheck.push(Math.floor(Math.random() * poolAddresses.length));
        }

        let checked = 0;
        for (const idx of indicesToCheck) {
            try {
                const poolInfo = await connection.getAccountInfo(poolAddresses[idx].pubkey);
                if (!poolInfo) continue;

                const vaultPk = new PublicKey(poolInfo.data.slice(solVault.offset, solVault.offset + 32));
                const vaultInfo = await connection.getAccountInfo(vaultPk);

                if (vaultInfo?.data.length === 165) {
                    const mint = new PublicKey(vaultInfo.data.slice(0, 32)).toBase58();
                    if (mint === SOL) {
                        const amt = Number(vaultInfo.data.readBigUInt64LE(64)) / 1e9;
                        solAmounts.push({
                            pool: poolAddresses[idx].pubkey.toBase58(),
                            sol: amt
                        });
                    }
                }

                checked++;
                if (checked % 100 === 0) {
                    process.stdout.write(`  Checked ${checked}/500...\r`);
                }
            } catch { }
        }

        solAmounts.sort((a, b) => b.sol - a.sol);

        console.log(`\nSampled ${solAmounts.length} pools with valid SOL vaults\n`);

        console.log('Top 25 by SOL liquidity:');
        console.log('─'.repeat(50));
        for (const p of solAmounts.slice(0, 25)) {
            console.log(`  ${p.pool.slice(0, 24)}... : ${p.sol.toFixed(2)} SOL`);
        }

        const above50 = solAmounts.filter(a => a.sol >= 50).length;
        const above80 = solAmounts.filter(a => a.sol >= 80).length;
        const above100 = solAmounts.filter(a => a.sol >= 100).length;
        const above500 = solAmounts.filter(a => a.sol >= 500).length;
        const above1000 = solAmounts.filter(a => a.sol >= 1000).length;

        console.log(`\nDistribution (from ${solAmounts.length} sampled):`);
        console.log(`  ≥50 SOL:   ${above50}`);
        console.log(`  ≥80 SOL:   ${above80}`);
        console.log(`  ≥100 SOL:  ${above100}`);
        console.log(`  ≥500 SOL:  ${above500}`);
        console.log(`  ≥1000 SOL: ${above1000}`);
        console.log(`  Max:       ${solAmounts[0]?.sol.toFixed(2) || 0} SOL`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('300-BYTE POOL LAYOUT SUMMARY');
    console.log('═'.repeat(70));
    console.log(`
Total 300-byte pools: ${poolAddresses.length.toLocaleString()}
Token vault offset: ${tokenVault?.offset || 'NOT FOUND'}
SOL vault offset: ${solVault?.offset || 'NOT FOUND'}

TO UPDATE YOUR SCANNER:
  - Change dataSize from 211 to 300
  - Update vault offsets to ${tokenVault?.offset || '???'} and ${solVault?.offset || '???'}
`);
}

main().catch(console.error);