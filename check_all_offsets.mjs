import { Connection, PublicKey } from '@solana/web3.js';

const conn = new Connection('https://api.mainnet-beta.solana.com');
const pool = new PublicKey('5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6');

const info = await conn.getAccountInfo(pool);
if (!info) { console.log('Pool not found'); process.exit(1); }

const d = info.data;
console.log('=== METEORA OFFSET VERIFICATION ===');
console.log('Discriminator:', d.subarray(0, 8).toString('hex'));
console.log('---');
console.log('Offset 8 (baseFactor u16):', d.readUInt16LE(8));
console.log('Offset 16 (variableFeeCtl u32):', d.readUInt32LE(16));
console.log('Offset 32 (protocolShare u16):', d.readUInt16LE(32), '= 5%');
console.log('Offset 72 (volatilityAcc u32):', d.readUInt32LE(72));
console.log('Offset 76 (activeId i32):', d.readInt32LE(76));
console.log('Offset 80 (binStep u16):', d.readUInt16LE(80));
console.log('---');

// Calculate fee with these values
const baseFactor = d.readUInt16LE(8);
const binStep = d.readUInt16LE(80);
const variableFeeControl = d.readUInt32LE(16);
const volatilityAccumulator = d.readUInt32LE(72);

const baseFee = (baseFactor * binStep) / 1_000_000;
const vBs = BigInt(volatilityAccumulator) * BigInt(binStep);
const varFee = Number((BigInt(variableFeeControl) * vBs * vBs) / 1_000_000_000_000_000n);
const totalFee = Math.min(baseFee + varFee, 0.10);

console.log('COMPUTED FEES:');
console.log('  baseFee:', (baseFee * 100).toFixed(4) + '%');
console.log('  varFee:', (varFee * 100).toFixed(6) + '%');
console.log('  totalFee:', (totalFee * 100).toFixed(4) + '%');
console.log('  tradeable (≤5%):', totalFee <= 0.05);
