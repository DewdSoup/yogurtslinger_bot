#!/usr/bin/env tsx
/**
 * RPC Thread Diagnostic Tool
 *
 * Tests RPC responsiveness with progressively larger requests.
 * Safe to run - will NOT flood your RPC.
 *
 * Usage: pnpm exec tsx scripts/test-rpc-threads.ts
 */

const RPC_ENDPOINT = process.env.RPC_ENDPOINT ?? 'http://127.0.0.1:8899';

interface TestResult {
    test: string;
    success: boolean;
    durationMs: number;
    error?: string;
    details?: string;
}

async function measureRpc<T>(
    name: string,
    fn: () => Promise<T>,
    validateResult?: (result: T) => string | null
): Promise<TestResult> {
    const start = Date.now();
    try {
        const result = await fn();
        const durationMs = Date.now() - start;
        const validation = validateResult ? validateResult(result) : null;

        return {
            test: name,
            success: validation === null,
            durationMs,
            error: validation ?? undefined,
            details: validation === null ? `OK` : undefined,
        };
    } catch (err: any) {
        return {
            test: name,
            success: false,
            durationMs: Date.now() - start,
            error: err.message ?? String(err),
        };
    }
}

async function rpcCall(method: string, params: any[]): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
        const response = await fetch(RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method,
                params,
            }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const json = await response.json() as any;
        if (json.error) {
            throw new Error(`RPC error: ${json.error.message}`);
        }

        return json.result;
    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            throw new Error('Timeout after 10s');
        }
        throw err;
    }
}

// Generate deterministic test pubkeys (SPL Token vaults from well-known pools)
function getTestPubkeys(count: number): string[] {
    // These are real SPL token vault addresses - safe to query
    const knownVaults = [
        'So11111111111111111111111111111111111111112', // Wrapped SOL (common)
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // ETH (Wormhole)
        'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
        'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
        '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
        'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
        'DUSTawucrTsGU8hcqRdHDCbuYhCPADMLM2VcCb8VnFnQ', // DUST
    ];

    // For larger counts, we'll repeat pubkeys (safe - just tests throughput)
    const result: string[] = [];
    for (let i = 0; i < count; i++) {
        result.push(knownVaults[i % knownVaults.length]!);
    }
    return result;
}

async function main(): Promise<void> {
    console.log('='.repeat(70));
    console.log('RPC THREAD DIAGNOSTIC TOOL');
    console.log('='.repeat(70));
    console.log(`RPC Endpoint: ${RPC_ENDPOINT}`);
    console.log('');
    console.log('Running progressive tests to check RPC responsiveness...');
    console.log('Each test has a 10s timeout. WILL NOT flood your RPC.');
    console.log('');

    const results: TestResult[] = [];

    // Test 1: Basic connectivity - getSlot (minimal load)
    console.log('Test 1: getSlot (basic connectivity)...');
    results.push(await measureRpc(
        'getSlot',
        () => rpcCall('getSlot', [{ commitment: 'confirmed' }]),
        (result) => typeof result === 'number' && result > 0 ? null : 'Invalid slot'
    ));
    console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);

    // Test 2: Single account fetch (1 account)
    console.log('Test 2: getAccountInfo (1 account)...');
    results.push(await measureRpc(
        'getAccountInfo (1)',
        () => rpcCall('getAccountInfo', ['So11111111111111111111111111111111111111112', { encoding: 'base64' }]),
        () => null // Any response is valid (account may or may not exist)
    ));
    console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);

    // Test 3: Small batch (10 accounts)
    console.log('Test 3: getMultipleAccounts (10 accounts)...');
    results.push(await measureRpc(
        'getMultipleAccounts (10)',
        () => rpcCall('getMultipleAccounts', [getTestPubkeys(10), { encoding: 'base64' }]),
        (result) => Array.isArray(result?.value) ? null : 'Invalid response'
    ));
    console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);

    // Test 4: Old limit (100 accounts)
    console.log('Test 4: getMultipleAccounts (100 accounts - old limit)...');
    results.push(await measureRpc(
        'getMultipleAccounts (100)',
        () => rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
        (result) => Array.isArray(result?.value) && result.value.length === 100 ? null : 'Invalid response'
    ));
    console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);

    // Only proceed with larger tests if basic tests passed
    const basicTestsPassed = results.every(r => r.success);

    if (basicTestsPassed) {
        // Test 5: Medium batch (500 accounts)
        console.log('Test 5: getMultipleAccounts (500 accounts)...');
        results.push(await measureRpc(
            'getMultipleAccounts (500)',
            () => rpcCall('getMultipleAccounts', [getTestPubkeys(500), { encoding: 'base64' }]),
            (result) => Array.isArray(result?.value) && result.value.length === 500 ? null : 'Invalid response'
        ));
        console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);

        // Test 6: New limit (2000 accounts) - only if 500 succeeded
        if (results[results.length - 1]!.success) {
            console.log('Test 6: getMultipleAccounts (2000 accounts - your new limit)...');
            results.push(await measureRpc(
                'getMultipleAccounts (2000)',
                () => rpcCall('getMultipleAccounts', [getTestPubkeys(2000), { encoding: 'base64' }]),
                (result) => Array.isArray(result?.value) && result.value.length === 2000 ? null : 'Invalid response'
            ));
            console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);
        }

        // Test 7: Concurrent requests (stress test) - 5 parallel 100-account requests
        console.log('Test 7: Concurrent requests (5 x 100 accounts in parallel)...');
        const concurrentStart = Date.now();
        try {
            const concurrentResults = await Promise.all([
                rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
                rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
                rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
                rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
                rpcCall('getMultipleAccounts', [getTestPubkeys(100), { encoding: 'base64' }]),
            ]);
            const allValid = concurrentResults.every(r => Array.isArray(r?.value));
            results.push({
                test: 'Concurrent (5 x 100)',
                success: allValid,
                durationMs: Date.now() - concurrentStart,
                error: allValid ? undefined : 'Some requests returned invalid data',
            });
        } catch (err: any) {
            results.push({
                test: 'Concurrent (5 x 100)',
                success: false,
                durationMs: Date.now() - concurrentStart,
                error: err.message,
            });
        }
        console.log(`  ${results[results.length - 1]!.success ? '✓' : '✗'} ${results[results.length - 1]!.durationMs}ms`);
    } else {
        console.log('\n⚠️  Skipping larger tests - basic tests failed');
    }

    // Summary
    console.log('');
    console.log('='.repeat(70));
    console.log('RESULTS SUMMARY');
    console.log('='.repeat(70));

    const passed = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`Passed: ${passed}/${results.length}`);
    console.log(`Failed: ${failed}/${results.length}`);
    console.log('');

    for (const r of results) {
        const status = r.success ? '✓' : '✗';
        const timing = `${r.durationMs}ms`.padStart(7);
        console.log(`${status} ${r.test.padEnd(35)} ${timing}${r.error ? ` - ${r.error}` : ''}`);
    }

    // Diagnosis
    console.log('');
    console.log('='.repeat(70));
    console.log('DIAGNOSIS');
    console.log('='.repeat(70));

    const slot100 = results.find(r => r.test === 'getMultipleAccounts (100)');
    const slot500 = results.find(r => r.test === 'getMultipleAccounts (500)');
    const slot2000 = results.find(r => r.test === 'getMultipleAccounts (2000)');
    const concurrent = results.find(r => r.test === 'Concurrent (5 x 100)');

    if (!basicTestsPassed) {
        console.log('❌ CRITICAL: Basic RPC connectivity failed');
        console.log('   - Check if validator is running');
        console.log('   - Check RPC endpoint URL');
        console.log('   - Check firewall/network settings');
    } else if (slot2000 && !slot2000.success) {
        console.log('❌ ISSUE: 2000-account batch limit NOT supported');
        console.log('   Your validator may not have --rpc-max-multiple-accounts 2000');
        console.log('');
        console.log('   FIX: Add to start-validator.sh:');
        console.log('     --rpc-max-multiple-accounts 2000');
    } else if (concurrent && !concurrent.success) {
        console.log('⚠️  ISSUE: Concurrent requests failed (thread exhaustion)');
        console.log('   Your 24-thread fix may not be sufficient');
        console.log('');
        console.log('   FIX: Try increasing RPC threads further or add rate limiting');
    } else if (slot2000 && slot2000.durationMs > 5000) {
        console.log('⚠️  WARNING: 2000-account requests are slow (>5s)');
        console.log(`   Actual time: ${slot2000.durationMs}ms`);
        console.log('');
        console.log('   This may cause timeouts during bootstrap.');
        console.log('   Consider reducing RPC_BATCH_LIMIT to 1000 or adding delays.');
    } else {
        console.log('✓ RPC appears healthy!');
        console.log('');
        if (slot2000) {
            console.log(`  2000-account requests: ${slot2000.durationMs}ms`);
        }
        if (concurrent) {
            console.log(`  Concurrent handling: ${concurrent.durationMs}ms for 5 parallel requests`);
        }
        console.log('');
        console.log('If you still see flooding, the issue is likely:');
        console.log('  1. getProgramAccounts (fetches ALL accounts for program)');
        console.log('  2. Too many concurrent fetchPoolDeps calls (check MAX_CONCURRENT_RPC)');
        console.log('  3. gRPC triggering individual RPC calls after bootstrap');
    }

    console.log('='.repeat(70));
}

main().catch(console.error);
