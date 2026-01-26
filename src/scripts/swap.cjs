#!/usr/bin/env node
/**
 * COMPLETE SWAP TRANSACTION COLLECTOR
 * 
 * Captures EVERYTHING for simulation validation:
 * - Full instruction data (bytes)
 * - Inner instructions (CPI calls)
 * - All account states (raw base64)
 * - Pre/post balances (SOL + token)
 * - Fees, compute units
 * - Log messages
 */

const https = require('https');
const fs = require('fs');

const HELIUS_API_KEY = 'bff504b3-c294-46e9-b7d8-dacbcb4b9e3d';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const PROGRAMS = {
    pumpswap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    raydium_v4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
    raydium_clmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    meteora_dlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
};

// Per-program data storage
const programData = {};
for (const name of Object.keys(PROGRAMS)) {
    programData[name] = { collectedAt: new Date().toISOString(), program: name, programId: PROGRAMS[name], cases: [] };
}

const QUOTE_MINTS = {
    'So11111111111111111111111111111111111111112': { decimals: 9, solPrice: 1 },
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { decimals: 6, solPrice: 0.005 },
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { decimals: 6, solPrice: 0.005 },
};

const TARGET = { small: 3, medium: 3, large: 3, edge: 3 };
const MAX_SIGS = 300;

function getFilename(name) {
    return `./${name}.json`;
}

function save(name) {
    fs.writeFileSync(getFilename(name), JSON.stringify(programData[name], null, 2));
}

function saveAll() {
    for (const name of Object.keys(PROGRAMS)) {
        save(name);
    }
}

function load(name) {
    const file = getFilename(name);
    if (fs.existsSync(file)) {
        try {
            programData[name] = JSON.parse(fs.readFileSync(file, 'utf8'));
            console.log(`Loaded ${programData[name].cases.length} existing cases from ${file}`);
        } catch (e) { }
    }
}

function loadAll() {
    for (const name of Object.keys(PROGRAMS)) {
        load(name);
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function rpc(method, params) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
        const url = new URL(HELIUS_RPC);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try {
                    const j = JSON.parse(d);
                    j.error ? reject(new Error(j.error.message)) : resolve(j.result);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

async function getSigs(program, limit, before = null) {
    const p = { limit, commitment: 'confirmed' };
    if (before) p.before = before;
    return rpc('getSignaturesForAddress', [program, p]);
}

// Get transaction with BOTH encodings - jsonParsed for readability, base64 for raw data
async function getFullTx(sig) {
    const [parsed, raw] = await Promise.all([
        rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
        rpc('getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]),
    ]);
    return { parsed, raw };
}

async function getAccount(pubkey) {
    try {
        const r = await rpc('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }]);
        if (r?.value) {
            return {
                owner: r.value.owner,
                lamports: r.value.lamports,
                executable: r.value.executable,
                rentEpoch: r.value.rentEpoch,
                data: r.value.data[0],
                dataEncoding: r.value.data[1] || 'base64',
                dataLength: r.value.data[0] ? Buffer.from(r.value.data[0], 'base64').length : 0,
            };
        }
    } catch (e) { }
    return null;
}

function analyzeFullTx(parsed, raw, programId) {
    if (!parsed || parsed.meta?.err) return null;

    const sig = parsed.transaction?.signatures?.[0];
    const slot = parsed.slot;
    const blockTime = parsed.blockTime;

    // Account keys with signer/writable info
    const accountKeys = parsed.transaction?.message?.accountKeys || [];
    const accounts = accountKeys.map(k => ({
        pubkey: typeof k === 'string' ? k : k.pubkey,
        signer: k.signer || false,
        writable: k.writable || false,
        source: k.source || 'transaction',
    }));

    // Get the raw transaction data (base64)
    const rawTxData = raw?.transaction?.[0] || null;

    // Instructions - both parsed and raw
    const instructions = [];
    const parsedIxs = parsed.transaction?.message?.instructions || [];

    for (let i = 0; i < parsedIxs.length; i++) {
        const ix = parsedIxs[i];
        const programIdStr = typeof ix.programId === 'string' ? ix.programId : ix.programId?.pubkey;

        instructions.push({
            index: i,
            programId: programIdStr,
            // Parsed info if available
            parsed: ix.parsed || null,
            program: ix.program || null,
            // Raw data if available (base58 encoded in jsonParsed)
            data: ix.data || null,
            // Account indices
            accounts: ix.accounts || [],
        });
    }

    // Inner instructions (CPI calls) - CRITICAL for simulation
    const innerInstructions = [];
    const innerIxs = parsed.meta?.innerInstructions || [];

    for (const outer of innerIxs) {
        for (const inner of outer.instructions || []) {
            const programIdStr = typeof inner.programId === 'string' ? inner.programId : inner.programId?.pubkey;

            innerInstructions.push({
                outerIndex: outer.index,
                programId: programIdStr,
                parsed: inner.parsed || null,
                program: inner.program || null,
                data: inner.data || null,
                accounts: inner.accounts || [],
                // Stack height if available
                stackHeight: inner.stackHeight || null,
            });
        }
    }

    // Token balance changes - THE GROUND TRUTH
    const preTokenBalances = parsed.meta?.preTokenBalances || [];
    const postTokenBalances = parsed.meta?.postTokenBalances || [];

    // Compute token diffs
    const tokenChanges = [];
    const mints = new Set();

    for (const post of postTokenBalances) {
        const pre = preTokenBalances.find(p => p.accountIndex === post.accountIndex);
        const preAmt = BigInt(pre?.uiTokenAmount?.amount || '0');
        const postAmt = BigInt(post.uiTokenAmount?.amount || '0');
        const diff = postAmt - preAmt;

        if (diff !== 0n) {
            const dec = post.uiTokenAmount?.decimals || 0;
            tokenChanges.push({
                accountIndex: post.accountIndex,
                account: accounts[post.accountIndex]?.pubkey,
                mint: post.mint,
                owner: post.owner,
                programId: post.programId, // Token program used
                preAmount: preAmt.toString(),
                postAmount: postAmt.toString(),
                change: diff.toString(),
                decimals: dec,
                uiChange: Number(diff) / Math.pow(10, dec),
            });
            mints.add(post.mint);
        }
    }

    if (tokenChanges.length < 2) return null;

    // SOL balance changes
    const preBalances = parsed.meta?.preBalances || [];
    const postBalances = parsed.meta?.postBalances || [];
    const solChanges = [];

    for (let i = 0; i < preBalances.length && i < postBalances.length; i++) {
        const change = postBalances[i] - preBalances[i];
        if (Math.abs(change) > 0) {
            solChanges.push({
                accountIndex: i,
                account: accounts[i]?.pubkey,
                preBalance: preBalances[i],
                postBalance: postBalances[i],
                change,
                changeSol: change / 1e9,
            });
        }
    }

    // Fee info
    const fee = parsed.meta?.fee || 0;

    // Compute units
    const computeUnitsConsumed = parsed.meta?.computeUnitsConsumed || null;

    // Rewards (usually empty for swaps)
    const rewards = parsed.meta?.rewards || [];

    // Log messages - FULL
    const logMessages = parsed.meta?.logMessages || [];

    // Return data
    const returnData = parsed.meta?.returnData || null;

    // Loaded addresses (for address lookup tables)
    const loadedAddresses = parsed.meta?.loadedAddresses || null;

    // Estimate size
    let sizeSol = 0;
    for (const c of tokenChanges) {
        const q = QUOTE_MINTS[c.mint];
        if (q) {
            const s = Math.abs(c.uiChange) * q.solPrice;
            if (s > sizeSol) sizeSol = s;
        }
    }
    for (const c of solChanges) {
        const s = Math.abs(c.changeSol);
        if (s > sizeSol && s < 1000) sizeSol = s; // Cap to avoid fee confusion
    }

    // Edge cases
    const edge = [];
    if (innerInstructions.length > 10) edge.push('high_cpi_count');

    let transfers = innerInstructions.filter(ix =>
        ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked'
    ).length;

    if (programId === PROGRAMS.raydium_clmm && transfers > 4) edge.push('multi_tick');
    if (programId === PROGRAMS.meteora_dlmm && transfers > 4) edge.push('multi_bin');
    if (accounts.some(a => a.pubkey === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')) edge.push('token_2022');

    // Category
    let cat = 'small';
    if (sizeSol >= 10) cat = 'large';
    else if (sizeSol >= 0.5) cat = 'medium';
    if (edge.length > 0) cat = 'edge';

    // Input/output
    let input = null, output = null;
    for (const c of tokenChanges) {
        const ch = BigInt(c.change);
        if (ch < 0n && !input) {
            input = { mint: c.mint, amount: (-ch).toString(), decimals: c.decimals, uiAmount: Math.abs(c.uiChange), account: c.account, owner: c.owner };
        } else if (ch > 0n && !output) {
            output = { mint: c.mint, amount: ch.toString(), decimals: c.decimals, uiAmount: c.uiChange, account: c.account, owner: c.owner };
        }
    }

    return {
        // Identification
        signature: sig,
        slot,
        blockTime,
        blockTimeISO: blockTime ? new Date(blockTime * 1000).toISOString() : null,

        // Program info
        program: Object.entries(PROGRAMS).find(([, v]) => v === programId)?.[0] || 'UNKNOWN',
        programId,

        // Classification
        category: cat,
        sizeSol,
        edgeCases: edge,

        // THE SWAP
        input,
        output,

        // Fee and compute
        fee,
        feeSol: fee / 1e9,
        computeUnitsConsumed,

        // ALL ACCOUNTS with metadata
        accounts,

        // INSTRUCTIONS - the actual swap call
        instructions,

        // INNER INSTRUCTIONS - CPI calls (token transfers, etc)
        innerInstructions,

        // RAW TRANSACTION DATA (base64)
        rawTransactionData: rawTxData,

        // TOKEN BALANCES - ground truth
        preTokenBalances,
        postTokenBalances,
        tokenChanges,

        // SOL BALANCES
        preBalances,
        postBalances,
        solChanges,

        // LOGS
        logMessages,

        // Return data (if any)
        returnData,

        // Loaded addresses (ALT)
        loadedAddresses,

        // Mints involved
        mints: Array.from(mints),

        // Rewards
        rewards,
    };
}

function identifyRoles(swap, programId) {
    const roles = {};
    const accs = swap.accounts.map(a => a.pubkey);

    // Token accounts from changes
    for (const c of swap.tokenChanges) {
        roles[c.account] = c.change.startsWith('-') ? 'user_token_in' : 'user_token_out';
    }

    // Mints
    for (const m of swap.mints) roles[m] = 'mint';

    // Programs
    roles[programId] = 'swap_program';
    roles['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] = 'token_program';
    roles['TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'] = 'token_2022_program';
    roles['11111111111111111111111111111111'] = 'system_program';

    // Protocol-specific
    if (programId === PROGRAMS.raydium_clmm && accs.length >= 9) {
        roles[accs[0]] = 'payer';
        roles[accs[1]] = 'clmm_amm_config';
        roles[accs[2]] = 'clmm_pool_state';
        roles[accs[3]] = 'user_input_token_account';
        roles[accs[4]] = 'user_output_token_account';
        roles[accs[5]] = 'clmm_input_vault';
        roles[accs[6]] = 'clmm_output_vault';
        roles[accs[7]] = 'clmm_observation_state';
        for (let i = 8; i < accs.length - 2 && i < 14; i++) {
            roles[accs[i]] = `clmm_tick_array_${i - 8}`;
        }
    }

    if (programId === PROGRAMS.meteora_dlmm && accs.length >= 10) {
        roles[accs[0]] = 'dlmm_lb_pair';
        roles[accs[1]] = 'dlmm_bin_array_bitmap_extension';
        roles[accs[2]] = 'dlmm_reserve_x';
        roles[accs[3]] = 'dlmm_reserve_y';
        roles[accs[4]] = 'user_token_x';
        roles[accs[5]] = 'user_token_y';
        roles[accs[6]] = 'dlmm_token_x_mint';
        roles[accs[7]] = 'dlmm_token_y_mint';
        roles[accs[8]] = 'dlmm_oracle';
        roles[accs[9]] = 'host_fee_in';
        for (let i = 10; i < accs.length - 3 && i < 20; i++) {
            roles[accs[i]] = `dlmm_bin_array_${i - 10}`;
        }
    }

    if (programId === PROGRAMS.raydium_v4 && accs.length >= 17) {
        roles[accs[0]] = 'token_program';
        roles[accs[1]] = 'v4_amm_id';
        roles[accs[2]] = 'v4_amm_authority';
        roles[accs[3]] = 'v4_amm_open_orders';
        roles[accs[4]] = 'v4_amm_target_orders';
        roles[accs[5]] = 'v4_pool_coin_vault';
        roles[accs[6]] = 'v4_pool_pc_vault';
        roles[accs[7]] = 'serum_program';
        roles[accs[8]] = 'serum_market';
        roles[accs[9]] = 'serum_bids';
        roles[accs[10]] = 'serum_asks';
        roles[accs[11]] = 'serum_event_queue';
        roles[accs[12]] = 'serum_coin_vault';
        roles[accs[13]] = 'serum_pc_vault';
        roles[accs[14]] = 'serum_vault_signer';
        roles[accs[15]] = 'user_source_token';
        roles[accs[16]] = 'user_dest_token';
        if (accs[17]) roles[accs[17]] = 'user_owner';
    }

    if (programId === PROGRAMS.pumpswap && accs.length >= 12) {
        roles[accs[0]] = 'pumpswap_global';
        roles[accs[1]] = 'pumpswap_fee_recipient';
        roles[accs[2]] = 'pumpswap_mint';
        roles[accs[3]] = 'pumpswap_bonding_curve';
        roles[accs[4]] = 'pumpswap_associated_bonding_curve';
        roles[accs[5]] = 'pumpswap_associated_user';
        roles[accs[6]] = 'user';
        roles[accs[7]] = 'system_program';
        roles[accs[8]] = 'token_program';
        roles[accs[9]] = 'rent';
        roles[accs[10]] = 'pumpswap_event_authority';
        roles[accs[11]] = 'pumpswap_program';
    }

    return roles;
}

async function fetchAllAccountStates(swap, programId) {
    const states = {};
    const roles = identifyRoles(swap, programId);

    // Get all unique accounts
    const toFetch = new Set();
    for (const a of swap.accounts) {
        if (a.pubkey !== '11111111111111111111111111111111') {
            toFetch.add(a.pubkey);
        }
    }
    for (const m of swap.mints) toFetch.add(m);

    console.log(`  Fetching ${toFetch.size} accounts...`);

    let fetched = 0;
    for (const pubkey of toFetch) {
        await sleep(25);
        const state = await getAccount(pubkey);
        if (state) {
            states[pubkey] = {
                ...state,
                role: roles[pubkey] || 'unknown',
            };
            fetched++;
        }

        if (fetched % 10 === 0) {
            process.stdout.write(`\r  Fetched ${fetched}/${toFetch.size}...`);
        }
    }
    console.log(`\r  Fetched ${fetched} account states`);

    return { states, roles };
}

async function collectForProgram(name, programId) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`${name.toUpperCase()} (${getFilename(name)})`);
    console.log('═'.repeat(60));

    const data = programData[name];
    const counts = { small: 0, medium: 0, large: 0, edge: 0 };

    // Count existing
    for (const c of data.cases) {
        if (counts[c.category] !== undefined) {
            counts[c.category]++;
        }
    }

    console.log(`Existing: s:${counts.small} m:${counts.medium} l:${counts.large} e:${counts.edge}`);

    if (Object.entries(TARGET).every(([k, v]) => counts[k] >= v)) {
        console.log('✓ Already complete');
        return;
    }

    // Fetch signatures
    let sigs = [];
    let lastSig = null;

    while (sigs.length < MAX_SIGS) {
        try {
            await sleep(50);
            const batch = await getSigs(programId, 100, lastSig);
            if (!batch?.length) break;
            sigs = sigs.concat(batch);
            lastSig = batch[batch.length - 1].signature;
            process.stdout.write(`\rFetched ${sigs.length} signatures...`);
        } catch (e) { break; }
    }
    console.log();

    for (let i = 0; i < sigs.length; i++) {
        if (Object.entries(TARGET).every(([k, v]) => counts[k] >= v)) {
            console.log('✓ Complete');
            break;
        }

        if (i > 0 && i % 50 === 0) {
            console.log(`[${i}/${sigs.length}] s:${counts.small} m:${counts.medium} l:${counts.large} e:${counts.edge}`);
        }

        const sig = sigs[i].signature;
        if (data.cases.some(c => c.signature === sig)) continue;

        try {
            await sleep(50);
            const { parsed, raw } = await getFullTx(sig);
            const swap = analyzeFullTx(parsed, raw, programId);
            if (!swap) continue;

            if (counts[swap.category] >= TARGET[swap.category]) continue;

            console.log(`\n✓ ${swap.category.toUpperCase()} | ${sig.slice(0, 24)}...`);
            console.log(`  Size: ${swap.sizeSol.toFixed(4)} SOL | Fee: ${swap.feeSol.toFixed(6)} SOL | CU: ${swap.computeUnitsConsumed || '?'}`);
            console.log(`  Edge: ${swap.edgeCases.join(', ') || 'none'}`);
            console.log(`  Instructions: ${swap.instructions.length} outer, ${swap.innerInstructions.length} inner`);

            const { states, roles } = await fetchAllAccountStates(swap, programId);

            const testCase = {
                ...swap,
                accountStates: states,
                accountRoles: roles,
                accountStateCount: Object.keys(states).length,
            };

            data.cases.push(testCase);
            counts[swap.category]++;

            save(name);
            console.log(`  ✓ SAVED to ${getFilename(name)}`);

        } catch (e) {
            // Skip
        }
    }
}

async function main() {
    console.log('═'.repeat(60));
    console.log('COMPLETE SWAP TRANSACTION COLLECTOR');
    console.log('═'.repeat(60));
    console.log(`Output files: ${Object.keys(PROGRAMS).map(n => getFilename(n)).join(', ')}`);
    console.log(`Target per program: ${JSON.stringify(TARGET)}`);

    loadAll();

    process.on('SIGINT', () => {
        console.log('\n\nSaving all...');
        saveAll();
        printSummary();
        process.exit(0);
    });

    for (const [name, pid] of Object.entries(PROGRAMS)) {
        await collectForProgram(name, pid);
    }

    printSummary();
}

function printSummary() {
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));

    let total = 0;
    for (const [name, data] of Object.entries(programData)) {
        const ct = { small: 0, medium: 0, large: 0, edge: 0 };
        for (const c of data.cases) {
            if (ct[c.category] !== undefined) ct[c.category]++;
        }
        const count = data.cases.length;
        total += count;
        console.log(`${name}: s:${ct.small} m:${ct.medium} l:${ct.large} e:${ct.edge} (${count} total) → ${getFilename(name)}`);
    }
    console.log(`\nTotal: ${total} cases across ${Object.keys(PROGRAMS).length} programs`);
}

main().catch(e => {
    console.error('Error:', e);
    saveAll();
    process.exit(1);
});