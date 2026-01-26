
import { createPoolCache } from '../src/cache/pool.js';
import { createTickCache } from '../src/cache/tick.js';
import { createBinCache } from '../src/cache/bin.js';
import { createVaultCache } from '../src/cache/vault.js';
import { createLifecycleRegistry } from '../src/cache/lifecycle.js';
import { PublicKey } from '@solana/web3.js';

function getMemoryUsage() {
    const used = process.memoryUsage();
    return used.heapUsed / 1024 / 1024; // MB
}

function randomPubkey() {
    return new PublicKey(Buffer.from(Array(32).fill(0).map(() => Math.floor(Math.random() * 256)))).toBuffer();
}

function randomData(size: number) {
    return Buffer.alloc(size, 1);
}

const N_POOLS = 100_000;
const N_TICKS_PER_POOL = 100;
const N_BINS_PER_POOL = 100;

console.log(`Starting Memory Profile... Baseline: ${getMemoryUsage().toFixed(2)} MB`);

// 1. Profile Pool Cache
console.log(`\n--- Profiling PoolCache (${N_POOLS} entries) ---`);
const poolCache = createPoolCache();
const startPool = getMemoryUsage();
for (let i = 0; i < N_POOLS; i++) {
    const pubkey = randomPubkey();
    poolCache.set(pubkey, {} as any, 100, 1n, 500, 'grpc');
}
const endPool = getMemoryUsage();
console.log(`PoolCache Size: ${(endPool - startPool).toFixed(2)} MB`);
console.log(`Per Entry: ${((endPool - startPool) * 1024 * 1024 / N_POOLS).toFixed(0)} bytes`);


// 2. Profile Tick Cache (heavy scenario)
console.log(`\n--- Profiling TickCache (${N_POOLS / 10} pools * ${N_TICKS_PER_POOL} ticks = ${N_POOLS * 10} entries) ---`);
const tickCache = createTickCache();
const startTick = getMemoryUsage();
for (let i = 0; i < N_POOLS / 10; i++) {
    const poolPubkey = randomPubkey();
    for (let j = 0; j < N_TICKS_PER_POOL; j++) {
        const tickPubkey = randomPubkey();
        tickCache.set(poolPubkey, j, {} as any, 100, 1n, tickPubkey, 1000, 'grpc');
    }
}
const endTick = getMemoryUsage();
console.log(`TickCache Size: ${(endTick - startTick).toFixed(2)} MB`);
console.log(`Per Entry: ${((endTick - startTick) * 1024 * 1024 / (N_POOLS * 10)).toFixed(0)} bytes`);


// 3. Profile Bin Cache (heavy scenario)
console.log(`\n--- Profiling BinCache (${N_POOLS / 10} pools * ${N_BINS_PER_POOL} bins = ${N_POOLS * 10} entries) ---`);
const binCache = createBinCache();
const startBin = getMemoryUsage();
for (let i = 0; i < N_POOLS / 10; i++) {
    const poolPubkey = randomPubkey();
    for (let j = 0; j < N_BINS_PER_POOL; j++) {
        const binPubkey = randomPubkey();
        binCache.set(poolPubkey, j, {} as any, 100, 1n, binPubkey, 1000, 'grpc');
    }
}
const endBin = getMemoryUsage();
console.log(`BinCache Size: ${(endBin - startBin).toFixed(2)} MB`);
console.log(`Per Entry: ${((endBin - startBin) * 1024 * 1024 / (N_POOLS * 10)).toFixed(0)} bytes`);


// 4. Profile Lifecycle Registry
console.log(`\n--- Profiling LifecycleRegistry (${N_POOLS} entries) ---`);
const lifecycle = createLifecycleRegistry();
const startLifecycle = getMemoryUsage();
for (let i = 0; i < N_POOLS; i++) {
    const pubkey = randomPubkey();
    lifecycle.discover(pubkey, 100);
}
const endLifecycle = getMemoryUsage();
console.log(`LifecycleRegistry Size: ${(endLifecycle - startLifecycle).toFixed(2)} MB`);
console.log(`Per Entry: ${((endLifecycle - startLifecycle) * 1024 * 1024 / N_POOLS).toFixed(0)} bytes`);
