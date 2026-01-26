import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const PUMPSWAP = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const SOL = 'So11111111111111111111111111111111111111112';
const SOL_BYTES = Buffer.from(new PublicKey(SOL).toBytes());

const connection = new Connection(RPC, 'confirmed');

async function main() {
    console.log('═'.repeat(70));
    console.log('PUMPSWAP DEEP DIAGNOSTIC');
    console.log('═'.repeat(70) + '\n');

    // STEP 1: What account sizes exist?
    console.log('STEP 1: Checking account sizes in PumpSwap program...\n');

    const testSizes = [211, 321, 200, 220, 250, 300, 165, 100, 400, 500, 752];

    for (const size of testSizes) {
        try {
            const accounts = await connection.getProgramAccounts(PUMPSWAP, {
                filters: [{ dataSize: size }],
                dataSlice: { offset: 0, length: 8 }
            });

            if (accounts.length > 0) {
                const disc = accounts[0].account.data.toString('hex');
                console.log(`  ${size} bytes: ${accounts.length.toLocaleString()} accounts (disc: ${disc})`);
            }
        } catch (e) {
            if (e.message.includes('string longer')) {
                console.log(`  ${size} bytes: TOO MANY (overflow error)`);
            }
        }
    }

    // STEP 2: Check WSOL at different offsets for 211-byte accounts
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 2: Finding WSOL at different offsets in 211-byte accounts...\n');

    for (const offset of [43, 75, 107, 139, 171]) {
        try {
            const count = await connection.getProgramAccounts(PUMPSWAP, {
                filters: [
                    { dataSize: 211 },
                    { memcmp: { offset, bytes: SOL } }
                ],
                dataSlice: { offset: 0, length: 1 }
            });
            console.log(`  WSOL at offset ${offset}: ${count.length.toLocaleString()} pools`);
        } catch { }
    }

    // STEP 3: Get a sample pool and check ALL potential pubkeys for vaults
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 3: Deep analysis of sample pool structure...\n');

    const samplePools = await connection.getProgramAccounts(PUMPSWAP, {
        filters: [
            { dataSize: 211 },
            { memcmp: { offset: 75, bytes: SOL } }
        ]
    });

    if (samplePools.length === 0) {
        console.log('No pools found!');
        return;
    }

    const sample = samplePools[0];
    const data = sample.account.data;

    console.log(`Sample pool: ${sample.pubkey.toBase58()}`);
    console.log(`Data length: ${data.length}`);
    console.log(`Discriminator: ${data.slice(0, 8).toString('hex')}`);

    // Check every potential pubkey position
    console.log('\nChecking all potential pubkey positions for token accounts:\n');

    const potentialOffsets = [];
    for (let o = 0; o <= data.length - 32; o++) {
        potentialOffsets.push(o);
    }

    const foundVaults = [];

    for (const offset of potentialOffsets) {
        try {
            const pk = new PublicKey(data.slice(offset, offset + 32));
            const info = await connection.getAccountInfo(pk);

            if (info && info.data.length === 165) {
                const mint = new PublicKey(info.data.slice(0, 32)).toBase58();
                const amount = info.data.readBigUInt64LE(64);
                const isSol = mint === SOL;

                foundVaults.push({
                    offset,
                    address: pk.toBase58(),
                    mint: mint.slice(0, 16) + '...',
                    amount,
                    isSol,
                    solAmount: isSol ? Number(amount) / 1e9 : null
                });
            }
        } catch { }
    }

    console.log('Token accounts found in pool data:');
    for (const v of foundVaults) {
        const label = v.isSol ? '💰 SOL' : '🪙 TKN';
        const amtStr = v.isSol ? `${v.solAmount.toFixed(4)} SOL` : `${v.amount} tokens`;
        console.log(`  Offset ${v.offset.toString().padStart(3)}: ${label} | ${amtStr} | ${v.address.slice(0, 20)}...`);
    }

    // STEP 4: Sample 100 pools and check actual SOL amounts
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 4: Sampling 100 pools for SOL distribution...\n');

    const solAmounts = [];

    for (let i = 0; i < Math.min(100, samplePools.length); i++) {
        const d = samplePools[i].account.data;

        // Check the SOL vault we identified
        const solVaultOffset = foundVaults.find(v => v.isSol)?.offset || 171;
        const solVault = new PublicKey(d.slice(solVaultOffset, solVaultOffset + 32));

        try {
            const vaultInfo = await connection.getAccountInfo(solVault);
            if (vaultInfo?.data.length === 165) {
                const mint = new PublicKey(vaultInfo.data.slice(0, 32)).toBase58();
                if (mint === SOL) {
                    const amt = Number(vaultInfo.data.readBigUInt64LE(64)) / 1e9;
                    solAmounts.push(amt);
                }
            }
        } catch { }
    }

    solAmounts.sort((a, b) => b - a);

    console.log(`Sampled ${solAmounts.length} pools with valid SOL vaults`);
    console.log(`\nDistribution:`);
    console.log(`  Max: ${solAmounts[0]?.toFixed(4) || 0} SOL`);
    console.log(`  Top 5: ${solAmounts.slice(0, 5).map(a => a.toFixed(2)).join(', ')} SOL`);
    console.log(`  Median: ${solAmounts[Math.floor(solAmounts.length / 2)]?.toFixed(4) || 0} SOL`);
    console.log(`  Min: ${solAmounts[solAmounts.length - 1]?.toFixed(4) || 0} SOL`);

    const above60 = solAmounts.filter(a => a >= 60).length;
    const above80 = solAmounts.filter(a => a >= 80).length;
    const above100 = solAmounts.filter(a => a >= 100).length;

    console.log(`\n  Pools with ≥60 SOL: ${above60}`);
    console.log(`  Pools with ≥80 SOL: ${above80}`);
    console.log(`  Pools with ≥100 SOL: ${above100}`);

    // STEP 5: Maybe the issue is we're looking at the wrong account type
    // Check if there's a GlobalConfig that tells us something
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 5: Looking for GlobalConfig (321 bytes)...\n');

    try {
        const globalConfigs = await connection.getProgramAccounts(PUMPSWAP, {
            filters: [{ dataSize: 321 }]
        });

        console.log(`Found ${globalConfigs.length} GlobalConfig accounts`);

        if (globalConfigs.length > 0) {
            const gc = globalConfigs[0];
            console.log(`  Address: ${gc.pubkey.toBase58()}`);
            console.log(`  Discriminator: ${gc.account.data.slice(0, 8).toString('hex')}`);
        }
    } catch { }

    // STEP 6: Check if there are pools we're missing by looking at larger account sizes
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 6: Checking for pools in other account sizes...\n');

    // Try 220-byte accounts (maybe there's padding or extra fields)
    for (const size of [200, 212, 213, 214, 215, 216, 220, 230, 240, 250]) {
        try {
            const pools = await connection.getProgramAccounts(PUMPSWAP, {
                filters: [
                    { dataSize: size },
                    { memcmp: { offset: 75, bytes: SOL } }  // WSOL at expected offset
                ],
                dataSlice: { offset: 0, length: 8 }
            });

            if (pools.length > 0) {
                console.log(`  ${size} bytes with WSOL@75: ${pools.length} pools`);
            }
        } catch { }
    }

    // STEP 7: Direct query for high-value vaults
    console.log('\n' + '─'.repeat(70));
    console.log('STEP 7: Looking for WSOL token accounts with high balances...\n');

    // This is inefficient but might reveal if there are vaults we're missing
    // Check the pool we already know has 50 SOL and look at its vaults

    const topPool = samplePools[0];
    const topData = topPool.account.data;

    // Your decoder layout
    const baseMint = new PublicKey(topData.slice(43, 75)).toBase58();
    const quoteMint = new PublicKey(topData.slice(75, 107)).toBase58();
    const tokenVaultAddr = new PublicKey(topData.slice(139, 171)).toBase58();
    const solVaultAddr = new PublicKey(topData.slice(171, 203)).toBase58();

    console.log('Top pool decoded (using your layout):');
    console.log(`  baseMint: ${baseMint}`);
    console.log(`  quoteMint: ${quoteMint}`);
    console.log(`  quoteMint is SOL: ${quoteMint === SOL}`);
    console.log(`  tokenVault (139-171): ${tokenVaultAddr}`);
    console.log(`  solVault (171-203): ${solVaultAddr}`);

    // Verify vaults
    const [tokenVaultInfo, solVaultInfo] = await connection.getMultipleAccountsInfo([
        new PublicKey(tokenVaultAddr),
        new PublicKey(solVaultAddr)
    ]);

    if (tokenVaultInfo?.data.length === 165) {
        const mint = new PublicKey(tokenVaultInfo.data.slice(0, 32)).toBase58();
        const amt = tokenVaultInfo.data.readBigUInt64LE(64);
        console.log(`\n  Token vault check:`);
        console.log(`    Mint: ${mint}`);
        console.log(`    Matches baseMint: ${mint === baseMint}`);
        console.log(`    Amount: ${amt}`);
    }

    if (solVaultInfo?.data.length === 165) {
        const mint = new PublicKey(solVaultInfo.data.slice(0, 32)).toBase58();
        const amt = Number(solVaultInfo.data.readBigUInt64LE(64)) / 1e9;
        console.log(`\n  SOL vault check:`);
        console.log(`    Mint: ${mint}`);
        console.log(`    Is WSOL: ${mint === SOL}`);
        console.log(`    Amount: ${amt.toFixed(4)} SOL`);
    }

    console.log('\n' + '═'.repeat(70));
    console.log('CONCLUSION');
    console.log('═'.repeat(70));
    console.log(`
If max SOL is ~50 and graduation should bring ~85 SOL:

POSSIBLE ISSUES:
1. We're querying the wrong subset of pools
2. The vault offset is wrong  
3. There's a different pool type for high-liquidity pools
4. The memcmp filter is filtering out good pools
5. Account data is cached/stale

VERIFY BY:
1. Go to pump.fun → find a JUST graduated token
2. Get its pool address from Solscan
3. Query that specific pool directly
4. Compare to what our script shows

Or share a pool address you know has high liquidity and I'll debug it.
`);
}

main().catch(console.error);