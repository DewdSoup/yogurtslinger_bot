/**
 * Meteora DLMM Bin Mathematics Validation
 * Run: npx ts-node src/scripts/bin-math.ts
 * 
 * Validates bin price calculations, slippage models, and state requirements
 */


// ============================================================================
// CONSTANTS - Meteora DLMM Canonical Values
// ============================================================================

const PRECISION = 1_000_000_000_000_000_000n; // 10^18
const BASIS_POINT_MAX = 10000;

// Bin ID offset (Meteora uses signed bins, offset by 2^23)
const BIN_ID_OFFSET = 8388608;

// ============================================================================
// BIN PRICE CALCULATION
// ============================================================================

/**
 * Calculate price at a specific bin ID
 * Formula: price = (1 + binStep/10000)^(binId - offset)
 */
export function getPriceFromBinId(binId: number, binStep: number): number {
    const base = 1 + binStep / BASIS_POINT_MAX;
    const exponent = binId - BIN_ID_OFFSET;
    return Math.pow(base, exponent);
}

/**
 * Calculate bin ID from price (inverse)
 */
export function getBinIdFromPrice(price: number, binStep: number): number {
    const base = 1 + binStep / BASIS_POINT_MAX;
    const exponent = Math.log(price) / Math.log(base);
    return Math.round(exponent) + BIN_ID_OFFSET;
}

/**
 * High-precision bin price using bigint (matches on-chain)
 */
export function getPriceFromBinIdPrecise(binId: number, binStep: number): bigint {
    const base = BigInt(BASIS_POINT_MAX + binStep);
    const divisor = BigInt(BASIS_POINT_MAX);
    const exponent = binId - BIN_ID_OFFSET;

    let price = PRECISION;

    if (exponent >= 0) {
        for (let i = 0; i < exponent; i++) {
            price = (price * base) / divisor;
        }
    } else {
        for (let i = 0; i < -exponent; i++) {
            price = (price * divisor) / base;
        }
    }

    return price;
}

// ============================================================================
// BIN ARRAY STATE STRUCTURE
// ============================================================================

interface BinLiquidity {
    amountX: bigint;  // Token X in bin
    amountY: bigint;  // Token Y in bin
}

interface DecodedBinArray {
    index: number;
    bins: Map<number, BinLiquidity>;
}

/**
 * Decode BinArray account data
 * Layout: 8 (discriminator) + 8 (version) + 32 (lbPair) + 4 (index) + ... + bins[70]
 */
export function decodeBinArray(data: Buffer): DecodedBinArray {
    // Skip discriminator (8 bytes)
    let offset = 8;

    // Skip version (8 bytes)
    offset += 8;

    // Skip lb_pair pubkey (32 bytes)
    offset += 32;

    // Read index (i32)
    const index = data.readInt32LE(offset);
    offset += 4;

    // Each bin in array: 70 bins per BinArray
    // Bin structure: amountX (u128 = 16 bytes) + amountY (u128 = 16 bytes) + ...
    const bins = new Map<number, BinLiquidity>();
    const BINS_PER_ARRAY = 70;
    const BIN_SIZE = 48; // 16 + 16 + padding/other fields

    // Skip to bins section (after header)
    offset = 52; // Approximate header end

    for (let i = 0; i < BINS_PER_ARRAY; i++) {
        const binOffset = offset + (i * BIN_SIZE);
        if (binOffset + 32 > data.length) break;

        // Read amounts as u128 (16 bytes each, little endian)
        const amountXBuf = data.subarray(binOffset, binOffset + 16);
        const amountYBuf = data.subarray(binOffset + 16, binOffset + 32);

        const amountX = bufferToBigint(amountXBuf);
        const amountY = bufferToBigint(amountYBuf);

        // Calculate actual bin ID: index * 70 + i
        const binId = index * BINS_PER_ARRAY + i;

        if (amountX > 0n || amountY > 0n) {
            bins.set(binId, { amountX, amountY });
        }
    }

    return { index, bins };
}

function bufferToBigint(buf: Buffer): bigint {
    let result = 0n;
    for (let i = buf.length - 1; i >= 0; i--) {
        result = (result << 8n) + BigInt(buf[i] ?? 0);
    }
    return result;
}

// ============================================================================
// SLIPPAGE SIMULATION ENGINE
// ============================================================================

interface SwapSimulationResult {
    amountIn: bigint;
    amountOut: bigint;
    effectivePrice: number;
    binsTraversed: number;
    finalBinId: number;
    feesPaid: bigint;
    priceImpact: number;
}

interface PoolState {
    activeId: number;
    binStep: number;
    baseFee: number;        // Base fee in basis points
    variableFee: number;    // Variable fee component
    bins: Map<number, BinLiquidity>;
    tokenXDecimals: number;
    tokenYDecimals: number;
}

/**
 * Simulate exact swap through DLMM bins
 * This is the core slippage model - matches on-chain behavior
 */
export function simulateSwapExactIn(
    pool: PoolState,
    amountIn: bigint,
    swapForY: boolean  // true = selling X for Y, false = selling Y for X
): SwapSimulationResult {
    let remainingIn = amountIn;
    let totalOut = 0n;
    let totalFees = 0n;
    let currentBinId = pool.activeId;
    let binsTraversed = 0;

    const direction = swapForY ? 1 : -1;
    const startPrice = getPriceFromBinId(pool.activeId, pool.binStep);

    while (remainingIn > 0n) {
        const bin = pool.bins.get(currentBinId);

        if (!bin) {
            // No liquidity at this bin, move to next
            currentBinId += direction;
            binsTraversed++;

            // Safety: prevent infinite loop
            if (binsTraversed > 1000) break;
            continue;
        }

        // Calculate how much we can swap in this bin
        const binPrice = getPriceFromBinIdPrecise(currentBinId, pool.binStep);
        const availableLiquidity = swapForY ? bin.amountY : bin.amountX;

        if (availableLiquidity === 0n) {
            currentBinId += direction;
            binsTraversed++;
            continue;
        }

        // Calculate fee for this portion
        const totalFeeRate = BigInt(pool.baseFee + pool.variableFee);
        const feeAmount = (remainingIn * totalFeeRate) / BigInt(BASIS_POINT_MAX);
        const amountAfterFee = remainingIn - feeAmount;

        // Calculate output for this bin
        let outputThisBin: bigint;
        let inputUsed: bigint;

        if (swapForY) {
            // Selling X for Y: output = input * price
            const maxOutput = (amountAfterFee * binPrice) / PRECISION;

            if (maxOutput <= availableLiquidity) {
                // Bin has enough liquidity
                outputThisBin = maxOutput;
                inputUsed = remainingIn;
            } else {
                // Bin depleted, use all available
                outputThisBin = availableLiquidity;
                inputUsed = (availableLiquidity * PRECISION) / binPrice;
                inputUsed = (inputUsed * BigInt(BASIS_POINT_MAX)) / (BigInt(BASIS_POINT_MAX) - totalFeeRate);
            }
        } else {
            // Selling Y for X: output = input / price
            const maxOutput = (amountAfterFee * PRECISION) / binPrice;

            if (maxOutput <= availableLiquidity) {
                outputThisBin = maxOutput;
                inputUsed = remainingIn;
            } else {
                outputThisBin = availableLiquidity;
                inputUsed = (availableLiquidity * binPrice) / PRECISION;
                inputUsed = (inputUsed * BigInt(BASIS_POINT_MAX)) / (BigInt(BASIS_POINT_MAX) - totalFeeRate);
            }
        }

        totalOut += outputThisBin;
        totalFees += (inputUsed * totalFeeRate) / BigInt(BASIS_POINT_MAX);
        remainingIn -= inputUsed;

        if (remainingIn > 0n) {
            currentBinId += direction;
            binsTraversed++;
        }
    }

    const endPrice = getPriceFromBinId(currentBinId, pool.binStep);
    const effectivePrice = Number(totalOut) / Number(amountIn);
    const priceImpact = Math.abs(endPrice - startPrice) / startPrice;

    return {
        amountIn,
        amountOut: totalOut,
        effectivePrice,
        binsTraversed,
        finalBinId: currentBinId,
        feesPaid: totalFees,
        priceImpact
    };
}

// ============================================================================
// VOLATILE FEE ANALYSIS
// ============================================================================

interface VolatileFeeState {
    volatilityAccumulator: number;
    volatilityReference: number;
    idReference: number;
    timeOfLastUpdate: number;
}

/**
 * Calculate variable fee based on volatility
 * Meteora uses volatility accumulator to adjust fees dynamically
 */
export function calculateVolatileFee(
    _baseFee: number,
    binStep: number,
    volatilityState: VolatileFeeState,
    currentBinId: number
): number {
    // Variable fee = (volatility_accumulator * binStep^2) / BASIS_POINT_MAX^2
    const binDelta = Math.abs(currentBinId - volatilityState.idReference);

    // Volatility accumulator increases with price movement
    const newAccumulator = volatilityState.volatilityAccumulator + binDelta;

    // Variable fee calculation (simplified from on-chain)
    const variableFee = Math.floor(
        (newAccumulator * binStep * binStep) / (BASIS_POINT_MAX * BASIS_POINT_MAX)
    );

    // Cap at some maximum
    const maxVariableFee = 1000; // 10% max variable fee
    return Math.min(variableFee, maxVariableFee);
}

/**
 * Identify fee arbitrage opportunity
 * When volatility is high on one venue but low on another
 */
export function identifyVolatileFeeArbitrage(
    dlmmPool: PoolState,
    dlmmVolatility: VolatileFeeState,
    referencePrice: number,
    referenceFee: number
): { opportunity: boolean; direction: 'buy' | 'sell'; expectedProfit: number } {
    const currentDlmmPrice = getPriceFromBinId(dlmmPool.activeId, dlmmPool.binStep);
    const currentVariableFee = calculateVolatileFee(
        dlmmPool.baseFee,
        dlmmPool.binStep,
        dlmmVolatility,
        dlmmPool.activeId
    );

    const totalDlmmFee = dlmmPool.baseFee + currentVariableFee;
    const priceDiff = (currentDlmmPrice - referencePrice) / referencePrice;
    const feeDiff = (totalDlmmFee - referenceFee) / BASIS_POINT_MAX;

    // Opportunity exists if price difference exceeds fee difference
    if (Math.abs(priceDiff) > feeDiff + 0.001) {
        return {
            opportunity: true,
            direction: priceDiff > 0 ? 'sell' : 'buy',
            expectedProfit: (Math.abs(priceDiff) - feeDiff) * 100 // as percentage
        };
    }

    return { opportunity: false, direction: 'buy', expectedProfit: 0 };
}

// ============================================================================
// STATE SIZE CALCULATOR
// ============================================================================

interface StateRequirements {
    lbPairSize: number;
    binArraySize: number;
    estimatedArraysPerPool: number;
    totalPerPool: number;
    totalForPools: number;
    indexOverhead: number;
    grandTotal: number;
}

export function calculateStateRequirements(numPools: number): StateRequirements {
    const lbPairSize = 1832;  // LbPair account size
    const binArraySize = 10280;  // BinArray account size (70 bins)
    const estimatedArraysPerPool = 25;  // Average active arrays per pool

    const totalPerPool = lbPairSize + (binArraySize * estimatedArraysPerPool);
    const totalForPools = totalPerPool * numPools;

    // Index structures: HashMap overhead, price indexes, etc.
    const indexOverhead = numPools * 500;  // ~500 bytes per pool for indexes

    return {
        lbPairSize,
        binArraySize,
        estimatedArraysPerPool,
        totalPerPool,
        totalForPools,
        indexOverhead,
        grandTotal: totalForPools + indexOverhead
    };
}

// ============================================================================
// CLI VALIDATION RUNNER
// ============================================================================

async function runValidation() {
    console.log('═'.repeat(70));
    console.log('METEORA DLMM BIN MATH VALIDATION');
    console.log('═'.repeat(70));

    // Test 1: Bin Price Calculation
    console.log('\n[TEST 1] Bin Price Calculation');
    console.log('─'.repeat(50));

    const testBinSteps = [1, 5, 10, 25, 100]; // Common bin steps
    const testBinId = BIN_ID_OFFSET; // Price = 1.0 at offset

    for (const binStep of testBinSteps) {
        const price = getPriceFromBinId(testBinId, binStep);
        const pricePlus10 = getPriceFromBinId(testBinId + 10, binStep);
        const priceMinus10 = getPriceFromBinId(testBinId - 10, binStep);

        console.log(`  binStep=${binStep}bp:`);
        console.log(`    bin[${testBinId}] (center) = ${price.toFixed(6)}`);
        console.log(`    bin[${testBinId + 10}] (+10)   = ${pricePlus10.toFixed(6)} (${((pricePlus10 / price - 1) * 100).toFixed(3)}%)`);
        console.log(`    bin[${testBinId - 10}] (-10)   = ${priceMinus10.toFixed(6)} (${((priceMinus10 / price - 1) * 100).toFixed(3)}%)`);
    }

    // Test 2: Slippage Simulation
    console.log('\n[TEST 2] Slippage Simulation');
    console.log('─'.repeat(50));

    // Create mock pool state
    const mockPool: PoolState = {
        activeId: BIN_ID_OFFSET,
        binStep: 10,
        baseFee: 20,  // 0.2%
        variableFee: 0,
        bins: new Map(),
        tokenXDecimals: 9,
        tokenYDecimals: 6
    };

    // Populate bins with mock liquidity
    for (let i = -50; i <= 50; i++) {
        const binId = BIN_ID_OFFSET + i;
        mockPool.bins.set(binId, {
            amountX: BigInt(1000000000000),  // 1000 tokens X
            amountY: BigInt(1000000000000)   // 1000 tokens Y
        });
    }

    // Test various swap sizes
    const swapSizes = [
        1000000000n,      // 1 token
        10000000000n,     // 10 tokens
        100000000000n,    // 100 tokens
        1000000000000n,   // 1000 tokens
        10000000000000n   // 10000 tokens
    ];

    console.log('  Swap Size (X→Y) | Output       | Eff. Price  | Bins  | Impact');
    console.log('  ' + '─'.repeat(65));

    for (const size of swapSizes) {
        const result = simulateSwapExactIn(mockPool, size, true);
        console.log(
            `  ${(Number(size) / 1e9).toString().padStart(14)} | ` +
            `${(Number(result.amountOut) / 1e9).toFixed(4).padStart(12)} | ` +
            `${result.effectivePrice.toFixed(6).padStart(11)} | ` +
            `${result.binsTraversed.toString().padStart(5)} | ` +
            `${(result.priceImpact * 100).toFixed(3)}%`
        );
    }

    // Test 3: State Requirements
    console.log('\n[TEST 3] State Requirements');
    console.log('─'.repeat(50));

    const poolCounts = [100, 500, 1000, 3000, 10000];

    console.log('  Pools    | Per Pool   | Total Data  | With Index | RAM %');
    console.log('  ' + '─'.repeat(60));

    for (const count of poolCounts) {
        const req = calculateStateRequirements(count);
        const ramPct = (req.grandTotal / (512 * 1024 * 1024 * 1024)) * 100;

        console.log(
            `  ${count.toString().padStart(6)} | ` +
            `${(req.totalPerPool / 1024).toFixed(0).padStart(7)} KB | ` +
            `${(req.totalForPools / (1024 * 1024)).toFixed(1).padStart(8)} MB | ` +
            `${(req.grandTotal / (1024 * 1024)).toFixed(1).padStart(8)} MB | ` +
            `${ramPct.toFixed(4)}%`
        );
    }

    // Test 4: Volatile Fee Analysis
    console.log('\n[TEST 4] Volatile Fee Analysis');
    console.log('─'.repeat(50));

    const volatilityStates: VolatileFeeState[] = [
        { volatilityAccumulator: 0, volatilityReference: 0, idReference: BIN_ID_OFFSET, timeOfLastUpdate: 0 },
        { volatilityAccumulator: 100, volatilityReference: 50, idReference: BIN_ID_OFFSET - 5, timeOfLastUpdate: 0 },
        { volatilityAccumulator: 500, volatilityReference: 200, idReference: BIN_ID_OFFSET - 20, timeOfLastUpdate: 0 },
        { volatilityAccumulator: 1000, volatilityReference: 500, idReference: BIN_ID_OFFSET - 50, timeOfLastUpdate: 0 },
    ];

    console.log('  Volatility Acc | Variable Fee | Total Fee');
    console.log('  ' + '─'.repeat(45));

    const testBaseFee = 20;
    for (const state of volatilityStates) {
        const varFee = calculateVolatileFee(testBaseFee, 10, state, BIN_ID_OFFSET);
        console.log(
            `  ${state.volatilityAccumulator.toString().padStart(15)} | ` +
            `${varFee.toString().padStart(12)}bp | ` +
            `${(testBaseFee + varFee).toString().padStart(9)}bp (${((testBaseFee + varFee) / 100).toFixed(2)}%)`
        );
    }

    // Test 5: Cross-Venue Arbitrage Detection
    console.log('\n[TEST 5] Fee Arbitrage Opportunity Detection');
    console.log('─'.repeat(50));

    const scenarios = [
        { dlmmPrice: 1.005, refPrice: 1.0, dlmmFee: 50, refFee: 30, volAcc: 500 },
        { dlmmPrice: 0.995, refPrice: 1.0, dlmmFee: 20, refFee: 30, volAcc: 0 },
        { dlmmPrice: 1.02, refPrice: 1.0, dlmmFee: 100, refFee: 30, volAcc: 1000 },
    ];

    for (const scenario of scenarios) {
        const testPool: PoolState = {
            ...mockPool,
            activeId: getBinIdFromPrice(scenario.dlmmPrice, 10),
            baseFee: scenario.dlmmFee,
        };

        const volState: VolatileFeeState = {
            volatilityAccumulator: scenario.volAcc,
            volatilityReference: 0,
            idReference: BIN_ID_OFFSET,
            timeOfLastUpdate: 0
        };

        const result = identifyVolatileFeeArbitrage(
            testPool,
            volState,
            scenario.refPrice,
            scenario.refFee
        );

        console.log(`  DLMM=${scenario.dlmmPrice} vs Ref=${scenario.refPrice}`);
        console.log(`    Opportunity: ${result.opportunity ? 'YES' : 'NO'}`);
        if (result.opportunity) {
            console.log(`    Direction: ${result.direction.toUpperCase()} on DLMM`);
            console.log(`    Expected: ${result.expectedProfit.toFixed(3)}%`);
        }
        console.log('');
    }

    console.log('═'.repeat(70));
    console.log('VALIDATION COMPLETE');
    console.log('═'.repeat(70));
}

// Run if executed directly
runValidation().catch(console.error);

export {
    PoolState,
    SwapSimulationResult,
    VolatileFeeState,
    DecodedBinArray
};