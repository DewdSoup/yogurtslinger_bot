/**
 * Solana MEV Deep Analysis Pipeline
 * Purpose: Reverse-engineer non-traditional MEV strategies
 * Focus: Token creation exploits, Jupiter routing inefficiencies, programmatic edge cases
 */

// Configuration
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Target transactions for analysis
const TARGET_SIGNATURES = [
    '3NxdJPMkxy66y7zzLfvV1dmTuu6bdgGHHg46QHDvpHTKvvrxMJRDSS41GsNaYhBrVqqhYiPxociR5gJ53BYhiV6m',
    '3mxA7m9J7LZQSpEB3buCuxoMS1K59mjGYMWBUBaodLKRcvjYrYpLcJ5eDhoqyhR7nLEm7Y8PeaeSNowaXd1dufBL',
    '4BFKAXPNnwcN7DjCqCY2xav3JLtrXEjKs8jzT14LJuQ7GoXSLCx8tQwYFrsjpRBZYvNCdrAPPkoniYVwoYE98ghC',
    '43WXrjuKcnsTEk7v1pCDZwhDzcMWaxM1j1b7brL1eigcNrvc1z4LnEy1o8rAp2GuDsmdtnBrYSn1aHQbtbVEsjNz',
    '63ShfnkpYPJ5CXCNETi15ay7NKwNTPNzJzWknAuo3f6DSE7Aoex9ctHqV3GhqzTpG3QbTZ55xgcvBNiNTAak87sz',
    '5vQTAN5rGji4ufm8Xz6d4fsmiz4gmFmdVvtfY3cWMLs4RfHJecpqqTyg2WzynEqajoVXKSTCXNV1FTdLdqJx8Ucb',
    '22kFAoz9YQATZXev3sZ4Df83MpojhPcqLqMqrG2tYyEaQsYbBtDYKReRoM3ZP5CbnpqMjjY931bUf2oMSVTWXEE9',
    '2mSQtGefBmod78799psb15psBfqmgJAVKMFchSSiv7XEouub5tdi2Fxkf113SYRPSYGJjFmKQ75HQKjZFuypZrrT',
    '5D96kjvhu6EwQ32tG1UBHAAfWdy5HGVnYkreooLniYHhShy5xEQjGCRGX1v47sW6eHSDeFseSDyk7rsfFPiTfoSp',
    '3tM8WBt1gCtpYovyLwDzcC6rCVssqi5NXQxtkjJaSXufsZ5fQT4dsVsvrEteskw5ipKGGcvPA7S2qamQumQqixGW'
];

// Known program IDs for classification
const KNOWN_PROGRAMS: Record<string, string> = {
    // DEX Programs
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4': 'Jupiter Aggregator V6',
    'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB': 'Jupiter Aggregator V4',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool',
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium V4 AMM',
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG': 'Meteora DAMM V2',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
    'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ': 'Saber Stable Swap',
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca V1',
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pools',

    // Token Creation / Launch Programs
    '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'Pump.fun',
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM': 'Pump.fun Token Mint',

    // Infrastructure
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'Token Program',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL': 'Associated Token Program',
    '11111111111111111111111111111111': 'System Program',
    'ComputeBudget111111111111111111111111111111': 'Compute Budget',

    // Jito
    'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt': 'Jito Tip Program',
    'HFqU5x63VTqvQss8hp11i4bVoTfMGMr2DmKp6ZFr4LSi': 'Jito Tip Account 1',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5': 'Jito Tip Account 2',

    // Other
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr': 'Memo Program',
};

// Jito tip accounts for detection
const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4bVoTfMGMr2DmKp6ZFr4LSi',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSuUM31QUdMb6GfPvrg',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT'
];

interface TransactionAnalysis {
    signature: string;
    slot: number;
    blockTime: number;
    fee: number;
    computeUnitsConsumed: number;
    computeUnitLimit: number;
    priorityFee: number;
    priorityFeePerCU: number;
    signers: string[];
    programsInvoked: string[];
    programClassification: Record<string, string>;
    jitoTipDetected: boolean;
    jitoTipAmount: number;
    tokenTransfers: TokenTransfer[];
    instructionCount: number;
    innerInstructionCount: number;
    accountsAccessed: number;
    addressLookupTables: string[];

    // Strategy classification
    strategySignals: StrategySignal[];

    // Token analysis
    tokensInvolved: TokenInfo[];

    // Profit analysis
    estimatedProfit: ProfitEstimate;

    // Anomaly flags
    anomalies: string[];
}

interface TokenTransfer {
    mint: string;
    fromOwner: string;
    toOwner: string;
    amount: number;
    decimals: number;
}

interface StrategySignal {
    signal: string;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    evidence: string;
}

interface TokenInfo {
    mint: string;
    symbol?: string;
    isPumpFun: boolean;
    creationSlot?: number;
    ageAtTrade?: number; // slots since creation
}

interface ProfitEstimate {
    inputToken: string;
    inputAmount: number;
    outputToken: string;
    outputAmount: number;
    netChange: number;
    feesTotal: number;
}

// RPC helper
async function rpcCall(method: string, params: any[]): Promise<any> {
    const response = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params
        })
    });
    const data = await response.json() as any;
    if (data.error) {
        throw new Error(`RPC Error: ${JSON.stringify(data.error)}`);
    }
    return data.result;
}

// Fetch parsed transaction
async function getTransaction(signature: string): Promise<any> {
    return rpcCall('getTransaction', [
        signature,
        {
            encoding: 'jsonParsed',
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        }
    ]);
}

// Detect Jito tip in transaction
function detectJitoTip(tx: any): { detected: boolean; amount: number } {
    let totalTip = 0;
    let detected = false;

    const instructions = tx?.transaction?.message?.instructions || [];
    const innerInstructions = tx?.meta?.innerInstructions || [];

    // Check main instructions
    for (const ix of instructions) {
        if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
            const dest = ix.parsed.info.destination;
            if (JITO_TIP_ACCOUNTS.includes(dest)) {
                detected = true;
                totalTip += ix.parsed.info.lamports;
            }
        }
    }

    // Check inner instructions
    for (const innerSet of innerInstructions) {
        for (const ix of innerSet.instructions || []) {
            if (ix.program === 'system' && ix.parsed?.type === 'transfer') {
                const dest = ix.parsed.info.destination;
                if (JITO_TIP_ACCOUNTS.includes(dest)) {
                    detected = true;
                    totalTip += ix.parsed.info.lamports;
                }
            }
        }
    }

    return { detected, amount: totalTip };
}

// Extract compute budget info
function extractComputeBudget(tx: any): { limit: number; priorityFee: number } {
    let limit = 200000; // default
    let priorityFee = 0;

    const instructions = tx?.transaction?.message?.instructions || [];

    for (const ix of instructions) {
        if (ix.programId === 'ComputeBudget111111111111111111111111111111') {
            // Parse compute budget instruction data
            if (ix.data) {
                const data = Buffer.from(ix.data, 'base64');
                const discriminator = data[0];

                if (discriminator === 2) { // SetComputeUnitLimit
                    limit = data.readUInt32LE(1);
                } else if (discriminator === 3) { // SetComputeUnitPrice
                    priorityFee = Number(data.readBigUInt64LE(1));
                }
            }
        }
    }

    return { limit, priorityFee };
}

// Extract all programs invoked
function extractPrograms(tx: any): string[] {
    const programs = new Set<string>();

    const instructions = tx?.transaction?.message?.instructions || [];
    const innerInstructions = tx?.meta?.innerInstructions || [];

    for (const ix of instructions) {
        if (ix.programId) programs.add(ix.programId);
    }

    for (const innerSet of innerInstructions) {
        for (const ix of innerSet.instructions || []) {
            if (ix.programId) programs.add(ix.programId);
        }
    }

    return Array.from(programs);
}

// Classify programs
function classifyPrograms(programs: string[]): Record<string, string> {
    const classified: Record<string, string> = {};
    for (const prog of programs) {
        classified[prog] = KNOWN_PROGRAMS[prog] || 'UNKNOWN';
    }
    return classified;
}

// Extract token transfers from transaction
function extractTokenTransfers(tx: any): TokenTransfer[] {
    const transfers: TokenTransfer[] = [];

    // From pre/post token balances
    const preBalances = tx?.meta?.preTokenBalances || [];
    const postBalances = tx?.meta?.postTokenBalances || [];

    // Create lookup maps
    const preMap = new Map<string, any>();
    for (const bal of preBalances) {
        const key = `${bal.accountIndex}-${bal.mint}`;
        preMap.set(key, bal);
    }

    for (const post of postBalances) {
        const key = `${post.accountIndex}-${post.mint}`;
        const pre = preMap.get(key);

        const preAmount = pre ? parseFloat(pre.uiTokenAmount?.uiAmount || '0') : 0;
        const postAmount = parseFloat(post.uiTokenAmount?.uiAmount || '0');
        const diff = postAmount - preAmount;

        if (diff !== 0) {
            transfers.push({
                mint: post.mint,
                fromOwner: diff < 0 ? post.owner : '',
                toOwner: diff > 0 ? post.owner : '',
                amount: Math.abs(diff),
                decimals: post.uiTokenAmount?.decimals || 0
            });
        }
    }

    return transfers;
}

// Check if token is PumpFun token
function isPumpFunToken(mint: string): boolean {
    // PumpFun tokens have vanity addresses ending in 'pump'
    return mint.toLowerCase().endsWith('pump');
}

// Detect strategy signals
function detectStrategySignals(tx: any, programs: string[], transfers: TokenTransfer[]): StrategySignal[] {
    const signals: StrategySignal[] = [];

    // Check for Jupiter usage
    const usesJupiter = programs.some(p => p.startsWith('JUP'));
    if (usesJupiter) {
        signals.push({
            signal: 'JUPITER_AGGREGATION',
            confidence: 'HIGH',
            evidence: 'Jupiter program invoked'
        });
    }

    // Check for multi-venue routing
    const dexPrograms = programs.filter(p =>
        KNOWN_PROGRAMS[p]?.includes('Raydium') ||
        KNOWN_PROGRAMS[p]?.includes('Orca') ||
        KNOWN_PROGRAMS[p]?.includes('Meteora')
    );
    if (dexPrograms.length > 1) {
        signals.push({
            signal: 'MULTI_VENUE_ROUTING',
            confidence: 'HIGH',
            evidence: `Routes through ${dexPrograms.length} DEXs: ${dexPrograms.map(p => KNOWN_PROGRAMS[p]).join(', ')}`
        });
    }

    // Check for PumpFun token involvement
    const pumpFunTokens = transfers.filter(t => isPumpFunToken(t.mint));
    if (pumpFunTokens.length > 0) {
        signals.push({
            signal: 'PUMPFUN_TOKEN_TRADE',
            confidence: 'HIGH',
            evidence: `Trades ${pumpFunTokens.length} PumpFun token(s)`
        });
    }

    // Check for new token trading (very few transfers, specific pattern)
    const uniqueMints = new Set(transfers.map(t => t.mint));
    if (uniqueMints.size === 2) { // Typical swap pattern
        signals.push({
            signal: 'SIMPLE_SWAP_PATTERN',
            confidence: 'MEDIUM',
            evidence: 'Two-token swap detected'
        });
    }

    // Check for complex multi-hop
    if (uniqueMints.size > 3) {
        signals.push({
            signal: 'COMPLEX_MULTI_HOP',
            confidence: 'HIGH',
            evidence: `${uniqueMints.size} unique tokens in single tx`
        });
    }

    // Check for no Jito tip (non-traditional MEV)
    const jito = detectJitoTip(tx);
    if (!jito.detected) {
        signals.push({
            signal: 'NO_JITO_BUNDLE',
            confidence: 'HIGH',
            evidence: 'No Jito tip detected - non-bundled execution'
        });
    }

    // Check for low priority fee (not competing on gas)
    const compute = extractComputeBudget(tx);
    if (compute.priorityFee < 1000) { // Less than 1000 microlamports/CU
        signals.push({
            signal: 'LOW_PRIORITY_FEE',
            confidence: 'MEDIUM',
            evidence: `Priority fee: ${compute.priorityFee} μlamports/CU - not gas-competing`
        });
    }

    // Check instruction complexity
    const innerCount = (tx?.meta?.innerInstructions || []).reduce(
        (acc: number, inner: any) => acc + (inner.instructions?.length || 0), 0
    );
    if (innerCount > 20) {
        signals.push({
            signal: 'HIGH_INSTRUCTION_COMPLEXITY',
            confidence: 'MEDIUM',
            evidence: `${innerCount} inner instructions - complex execution path`
        });
    }

    return signals;
}

// Detect anomalies
function detectAnomalies(analysis: Partial<TransactionAnalysis>): string[] {
    const anomalies: string[] = [];

    // High profit with no Jito
    if (!analysis.jitoTipDetected && analysis.estimatedProfit && analysis.estimatedProfit.netChange > 0.1) {
        anomalies.push('HIGH_PROFIT_NO_JITO: Profitable trade without Jito bundle');
    }

    // Very low CU usage
    if (analysis.computeUnitsConsumed && analysis.computeUnitLimit) {
        const efficiency = analysis.computeUnitsConsumed / analysis.computeUnitLimit;
        if (efficiency < 0.3) {
            anomalies.push(`CU_OVERESTIMATE: Only used ${(efficiency * 100).toFixed(1)}% of requested CU`);
        }
    }

    // Unknown programs
    const unknownPrograms = Object.entries(analysis.programClassification || {})
        .filter(([_, name]) => name === 'UNKNOWN')
        .map(([addr, _]) => addr);
    if (unknownPrograms.length > 0) {
        anomalies.push(`UNKNOWN_PROGRAMS: ${unknownPrograms.length} unclassified program(s)`);
    }

    return anomalies;
}

// Main analysis function
async function analyzeTransaction(signature: string): Promise<TransactionAnalysis | null> {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Analyzing: ${signature}`);
    console.log('='.repeat(80));

    try {
        const tx = await getTransaction(signature);

        if (!tx) {
            console.log('Transaction not found');
            return null;
        }

        // Basic extraction
        const slot = tx.slot;
        const blockTime = tx.blockTime;
        const fee = tx.meta?.fee || 0;
        const computeUnitsConsumed = tx.meta?.computeUnitsConsumed || 0;
        const { limit: computeUnitLimit, priorityFee } = extractComputeBudget(tx);

        // Signers
        const signers = tx.transaction?.message?.accountKeys
            ?.filter((acc: any) => acc.signer)
            ?.map((acc: any) => acc.pubkey) || [];

        // Programs
        const programsInvoked = extractPrograms(tx);
        const programClassification = classifyPrograms(programsInvoked);

        // Jito detection
        const jito = detectJitoTip(tx);

        // Token transfers
        const tokenTransfers = extractTokenTransfers(tx);

        // Instruction counts
        const instructionCount = tx.transaction?.message?.instructions?.length || 0;
        const innerInstructionCount = (tx.meta?.innerInstructions || []).reduce(
            (acc: number, inner: any) => acc + (inner.instructions?.length || 0), 0
        );

        // Account count
        const accountsAccessed = tx.transaction?.message?.accountKeys?.length || 0;

        // Address lookup tables
        const addressLookupTables = tx.transaction?.message?.addressTableLookups?.map(
            (alt: any) => alt.accountKey
        ) || [];

        // Strategy signals
        const strategySignals = detectStrategySignals(tx, programsInvoked, tokenTransfers);

        // Token info
        const tokensInvolved: TokenInfo[] = [...new Set(tokenTransfers.map(t => t.mint))].map(mint => ({
            mint,
            isPumpFun: isPumpFunToken(mint)
        }));

        // Basic profit estimate (needs enhancement with price data)
        const estimatedProfit: ProfitEstimate = {
            inputToken: 'SOL',
            inputAmount: 0,
            outputToken: 'Unknown',
            outputAmount: 0,
            netChange: 0,
            feesTotal: fee + jito.amount
        };

        const analysis: TransactionAnalysis = {
            signature,
            slot,
            blockTime,
            fee,
            computeUnitsConsumed,
            computeUnitLimit,
            priorityFee,
            priorityFeePerCU: computeUnitsConsumed > 0 ? priorityFee / computeUnitsConsumed : 0,
            signers,
            programsInvoked,
            programClassification,
            jitoTipDetected: jito.detected,
            jitoTipAmount: jito.amount,
            tokenTransfers,
            instructionCount,
            innerInstructionCount,
            accountsAccessed,
            addressLookupTables,
            strategySignals,
            tokensInvolved,
            estimatedProfit,
            anomalies: []
        };

        // Detect anomalies
        analysis.anomalies = detectAnomalies(analysis);

        // Print summary
        printAnalysisSummary(analysis);

        return analysis;

    } catch (error) {
        console.error(`Error analyzing ${signature}:`, error);
        return null;
    }
}

function printAnalysisSummary(a: TransactionAnalysis) {
    console.log('\n--- BASIC METRICS ---');
    console.log(`Slot: ${a.slot}`);
    console.log(`Block Time: ${new Date(a.blockTime * 1000).toISOString()}`);
    console.log(`Base Fee: ${a.fee / 1e9} SOL`);
    console.log(`CU Used/Limit: ${a.computeUnitsConsumed.toLocaleString()} / ${a.computeUnitLimit.toLocaleString()} (${(a.computeUnitsConsumed / a.computeUnitLimit * 100).toFixed(1)}%)`);
    console.log(`Priority Fee: ${a.priorityFee} μlamports/CU`);

    console.log('\n--- JITO ANALYSIS ---');
    console.log(`Jito Bundle: ${a.jitoTipDetected ? 'YES' : 'NO'}`);
    if (a.jitoTipDetected) {
        console.log(`Jito Tip: ${a.jitoTipAmount / 1e9} SOL`);
    }

    console.log('\n--- PROGRAMS INVOKED ---');
    for (const [prog, name] of Object.entries(a.programClassification)) {
        const shortProg = prog.slice(0, 8) + '...' + prog.slice(-4);
        console.log(`  ${shortProg}: ${name}`);
    }

    console.log('\n--- TOKEN TRANSFERS ---');
    for (const transfer of a.tokenTransfers) {
        const pumpTag = isPumpFunToken(transfer.mint) ? ' [PUMPFUN]' : '';
        console.log(`  ${transfer.mint.slice(0, 8)}...${pumpTag}: ${transfer.amount.toFixed(6)} (${transfer.decimals} decimals)`);
    }

    console.log('\n--- STRATEGY SIGNALS ---');
    for (const signal of a.strategySignals) {
        console.log(`  [${signal.confidence}] ${signal.signal}: ${signal.evidence}`);
    }

    if (a.anomalies.length > 0) {
        console.log('\n--- ANOMALIES DETECTED ---');
        for (const anomaly of a.anomalies) {
            console.log(`  ⚠️  ${anomaly}`);
        }
    }

    console.log('\n--- EXECUTION COMPLEXITY ---');
    console.log(`Instructions: ${a.instructionCount} main, ${a.innerInstructionCount} inner`);
    console.log(`Accounts Accessed: ${a.accountsAccessed}`);
    console.log(`Address Lookup Tables: ${a.addressLookupTables.length}`);
    console.log(`Signers: ${a.signers.join(', ')}`);
}

// Cross-transaction pattern analysis
function analyzePatterns(analyses: TransactionAnalysis[]) {
    console.log('\n\n' + '█'.repeat(80));
    console.log('CROSS-TRANSACTION PATTERN ANALYSIS');
    console.log('█'.repeat(80));

    // Jito usage statistics
    const jitoCount = analyses.filter(a => a.jitoTipDetected).length;
    console.log(`\n--- JITO USAGE ---`);
    console.log(`Jito Bundles: ${jitoCount}/${analyses.length} (${(jitoCount / analyses.length * 100).toFixed(1)}%)`);

    if (jitoCount < analyses.length) {
        console.log(`\n⚡ NON-JITO TRANSACTIONS DETECTED: ${analyses.length - jitoCount}`);
        console.log('   This suggests strategy does NOT rely on bundle ordering/atomicity');
    }

    // Program frequency
    const programFreq: Record<string, number> = {};
    for (const a of analyses) {
        for (const prog of a.programsInvoked) {
            programFreq[prog] = (programFreq[prog] || 0) + 1;
        }
    }

    console.log('\n--- PROGRAM FREQUENCY ---');
    const sortedPrograms = Object.entries(programFreq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
    for (const [prog, count] of sortedPrograms) {
        const name = KNOWN_PROGRAMS[prog] || 'UNKNOWN';
        const pct = (count / analyses.length * 100).toFixed(0);
        console.log(`  ${count}/${analyses.length} (${pct}%): ${name}`);
    }

    // Unknown programs (potential custom contracts)
    const unknownPrograms = new Set<string>();
    for (const a of analyses) {
        for (const [prog, name] of Object.entries(a.programClassification)) {
            if (name === 'UNKNOWN') unknownPrograms.add(prog);
        }
    }

    if (unknownPrograms.size > 0) {
        console.log('\n--- UNKNOWN PROGRAMS (POTENTIAL CUSTOM CONTRACTS) ---');
        for (const prog of unknownPrograms) {
            const count = programFreq[prog] || 0;
            console.log(`  ${prog}: appears in ${count} tx(s)`);
        }
    }

    // Strategy signal aggregation
    const signalFreq: Record<string, number> = {};
    for (const a of analyses) {
        for (const signal of a.strategySignals) {
            signalFreq[signal.signal] = (signalFreq[signal.signal] || 0) + 1;
        }
    }

    console.log('\n--- STRATEGY SIGNAL FREQUENCY ---');
    const sortedSignals = Object.entries(signalFreq)
        .sort((a, b) => b[1] - a[1]);
    for (const [signal, count] of sortedSignals) {
        const pct = (count / analyses.length * 100).toFixed(0);
        console.log(`  ${count}/${analyses.length} (${pct}%): ${signal}`);
    }

    // PumpFun token analysis
    const pumpFunTxs = analyses.filter(a =>
        a.tokensInvolved.some(t => t.isPumpFun)
    );
    console.log(`\n--- PUMPFUN TOKEN INVOLVEMENT ---`);
    console.log(`Transactions with PumpFun tokens: ${pumpFunTxs.length}/${analyses.length}`);

    // Unique signers
    const uniqueSigners = new Set<string>();
    for (const a of analyses) {
        for (const signer of a.signers) {
            uniqueSigners.add(signer);
        }
    }
    console.log(`\n--- SIGNER ANALYSIS ---`);
    console.log(`Unique signers: ${uniqueSigners.size}`);
    for (const signer of uniqueSigners) {
        const count = analyses.filter(a => a.signers.includes(signer)).length;
        console.log(`  ${signer}: ${count} tx(s)`);
    }

    // Priority fee distribution
    const priorityFees = analyses.map(a => a.priorityFee).filter(f => f > 0);
    if (priorityFees.length > 0) {
        const avgFee = priorityFees.reduce((a, b) => a + b, 0) / priorityFees.length;
        const maxFee = Math.max(...priorityFees);
        const minFee = Math.min(...priorityFees);
        console.log(`\n--- PRIORITY FEE DISTRIBUTION ---`);
        console.log(`  Min: ${minFee} μlamports/CU`);
        console.log(`  Max: ${maxFee} μlamports/CU`);
        console.log(`  Avg: ${avgFee.toFixed(2)} μlamports/CU`);
    }

    // Hypothesis generation
    console.log('\n' + '─'.repeat(80));
    console.log('PRELIMINARY HYPOTHESIS');
    console.log('─'.repeat(80));

    if (jitoCount < analyses.length / 2) {
        console.log('\n📊 LOW JITO USAGE suggests:');
        console.log('   - Strategy does NOT compete on bundle ordering');
        console.log('   - May be exploiting timing/routing inefficiency rather than MEV');
        console.log('   - Possibly front-running token creation or bonding curve states');
    }

    if (pumpFunTxs.length > analyses.length / 2) {
        console.log('\n🎯 HIGH PUMPFUN INVOLVEMENT suggests:');
        console.log('   - Targeting newly created tokens');
        console.log('   - Possible bonding curve arbitrage');
        console.log('   - May be exploiting migration timing from PumpFun to Raydium');
    }

    const jupiterUsage = analyses.filter(a =>
        a.programsInvoked.some(p => p.startsWith('JUP'))
    ).length;
    if (jupiterUsage > analyses.length * 0.7) {
        console.log('\n🔀 HIGH JUPITER USAGE suggests:');
        console.log('   - Leveraging aggregator for optimal routing');
        console.log('   - May be exploiting route calculation inefficiencies');
        console.log('   - Could be using Jupiter for price discovery arbitrage');
    }

    if (unknownPrograms.size > 0) {
        console.log('\n🔍 UNKNOWN PROGRAMS present:');
        console.log('   - Custom smart contracts in use');
        console.log('   - Warrants deeper investigation of program logic');
        console.log('   - May contain proprietary strategy implementation');
    }
}

// Main execution
async function main() {
    console.log('╔════════════════════════════════════════════════════════════════════════════╗');
    console.log('║          SOLANA MEV DEEP ANALYSIS - STRATEGY REVERSE ENGINEERING           ║');
    console.log('╚════════════════════════════════════════════════════════════════════════════╝');
    console.log(`\nAnalyzing ${TARGET_SIGNATURES.length} transactions...`);
    console.log(`Timestamp: ${new Date().toISOString()}`);

    const analyses: TransactionAnalysis[] = [];

    for (const sig of TARGET_SIGNATURES) {
        const analysis = await analyzeTransaction(sig);
        if (analysis) {
            analyses.push(analysis);
        }
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (analyses.length > 0) {
        analyzePatterns(analyses);
    }

    // Export raw data
    const outputPath = '/mnt/user-data/outputs/mev_analysis_results.json';
    const fs = await import('fs');
    fs.writeFileSync(outputPath, JSON.stringify(analyses, null, 2));
    console.log(`\n\nRaw analysis data exported to: ${outputPath}`);
}

main().catch(console.error);
