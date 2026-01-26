import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://api.mainnet-beta.solana.com');

// We need to find a memecoin pool - let's check a few random ones
// These are from recent Meteora activity (may need to find live ones)
const pools = [
    'FoSDw2L5DmTuQTFe55gWPDXf88euaxAEKFre74CnvQbX', // Example - may not exist
];

for (const poolAddr of pools) {
    try {
        const pool = new PublicKey(poolAddr);
        const info = await conn.getAccountInfo(pool);
        if (!info) continue;
        
        const d = info.data;
        const baseFactor = d.readUInt16LE(8);
        const binStep = d.readUInt16LE(80);
        const baseFee = Math.min((baseFactor * binStep) / 1_000_000, 0.10);
        
        console.log(`Pool: ${poolAddr.slice(0,8)}...`);
        console.log(`  baseFactor=${baseFactor}, binStep=${binStep}`);
        console.log(`  baseFee=${(baseFee * 100).toFixed(2)}%`);
        console.log(`  Tradeable: ${baseFee <= 0.05}`);
        console.log('---');
    } catch (e) {
        console.log(`Pool ${poolAddr.slice(0,8)} not found`);
    }
}
