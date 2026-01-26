import { Connection, PublicKey } from '@solana/web3.js';

// Public RPC - slower but no rate limit for single calls
const conn = new Connection('https://api.mainnet-beta.solana.com');
const pool = new PublicKey('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');

const info = await conn.getAccountInfo(pool);
if (!info) { 
    console.log('Pool not found'); 
    process.exit(1); 
}

console.log('Data length:', info.data.length);
console.log('Owner:', info.owner.toBase58());
console.log('---');
console.log('Offset 24 (u16):', info.data.readUInt16LE(24));
console.log('Offset 32 (u16):', info.data.readUInt16LE(32));
console.log('Offset 40 (u16):', info.data.readUInt16LE(40));
