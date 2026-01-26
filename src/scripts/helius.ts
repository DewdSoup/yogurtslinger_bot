// crossVenueScanner.ts
// Fixed version with actual decoders - validates cross-venue opportunity thesis

import { Connection, PublicKey } from "@solana/web3.js";

const HELIUS_RPC = process.env.HELIUS_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=bff504b3-c294-46e9-b7d8-dacbcb4b9e3d";
const MIN_LIQUIDITY_SOL = 1;

// Program IDs
const PUMPSWAP_PROGRAM = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const RAYDIUM_V4_PROGRAM = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

// PumpSwap discriminator: [241, 154, 109, 4, 17, 177, 109, 188]
const PUMPSWAP_POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

interface PoolState {
    venue: string;
    poolAddress: string;
    baseMint: string;
    quoteMint: string;
    baseVault: string;
    quoteVault: string;
    baseReserve: bigint;
    quoteReserve: bigint;
    price: number;
    liquiditySOL: number;
}

interface ScanResult {
    pumpswapPools: number;
    raydiumPools: number;
    tokensWithBothVenues: number;
    opportunities: Array<{
        baseMint: string;
        pumpswapPrice: number;
        raydiumPrice: number;
        divergencePct: number;
        profitableBps: number;
    }>;
}

class CrossVenueScanner {
    private connection: Connection;
    private pumpswapPools: Map<string, PoolState> = new Map(); // baseMint -> pool
    private raydiumPools: Map<string, PoolState> = new Map();

    constructor(rpcUrl: string) {
        this.connection = new Connection(rpcUrl, "confirmed");
    }

    async scanPumpSwapPools(): Promise<number> {
        console.log("Scanning PumpSwap pools...");

        try {
            const accounts = await this.connection.getProgramAccounts(PUMPSWAP_PROGRAM, {
                commitment: "confirmed",
                filters: [
                    { dataSize: 211 }, // PumpSwap pool account size
                ],
            });

            console.log(`Raw accounts found: ${accounts.length}`);

            let validPools = 0;
            for (const { pubkey, account } of accounts) {
                // Verify discriminator manually
                if (!account.data.subarray(0, 8).equals(PUMPSWAP_POOL_DISCRIMINATOR)) {
                    continue;
                }

                try {
                    const pool = await this.decodePumpSwapPool(pubkey, account.data);
                    if (pool && pool.liquiditySOL >= MIN_LIQUIDITY_SOL) {
                        this.pumpswapPools.set(pool.baseMint, pool);
                        validPools++;
                    }
                } catch (e) {
                    // Skip malformed
                }
            }

            console.log(`Valid PumpSwap pools with >${MIN_LIQUIDITY_SOL} SOL: ${validPools}`);
            return validPools;
        } catch (e) {
            console.error("Error scanning PumpSwap:", e);
            return 0;
        }
    }

    async decodePumpSwapPool(pubkey: PublicKey, data: Buffer): Promise<PoolState | null> {
        // PumpSwap Pool Layout (211 bytes):
        // 0-7: discriminator (8)
        // 8: pool_bump (1)
        // 9-10: index (2)
        // 11-42: creator (32)
        // 43-74: base_mint (32)
        // 75-106: quote_mint (32)
        // 107-138: lp_mint (32)
        // 139-170: pool_base_token_account (32)
        // 171-202: pool_quote_token_account (32)
        // 203-210: lp_supply (8)

        if (data.length < 211) return null;

        let offset = 8; // skip discriminator

        offset += 1; // pool_bump
        offset += 2; // index

        offset += 32; // creator

        const baseMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
        offset += 32;

        const quoteMint = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
        offset += 32;

        offset += 32; // lp_mint

        const baseVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
        offset += 32;

        const quoteVault = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
        offset += 32;

        // Fetch vault balances to get actual reserves
        const [baseBalance, quoteBalance] = await Promise.all([
            this.getTokenBalance(baseVault),
            this.getTokenBalance(quoteVault),
        ]);

        if (baseBalance === 0n || quoteBalance === 0n) return null;

        // Price = quote per base (SOL per token)
        const price = Number(quoteBalance) / Number(baseBalance);
        const liquiditySOL = Number(quoteBalance) / 1e9; // Assuming quote is SOL

        return {
            venue: "PumpSwap",
            poolAddress: pubkey.toBase58(),
            baseMint,
            quoteMint,
            baseVault,
            quoteVault,
            baseReserve: baseBalance,
            quoteReserve: quoteBalance,
            price,
            liquiditySOL,
        };
    }

    async checkRaydiumForTokens(): Promise<number> {
        const baseMints = Array.from(this.pumpswapPools.keys());
        console.log(`Checking Raydium V4 for ${baseMints.length} tokens...`);

        let found = 0;

        // Raydium V4 pool layout - baseMint at offset 400, quoteMint at offset 432
        // Pool size is 752 bytes

        // Batch check - for efficiency, we'll sample a subset
        const sampleSize = Math.min(baseMints.length, 100);
        const sample = baseMints.slice(0, sampleSize);

        for (const baseMint of sample) {
            try {
                const pools = await this.connection.getProgramAccounts(RAYDIUM_V4_PROGRAM, {
                    commitment: "confirmed",
                    filters: [
                        { dataSize: 752 },
                        { memcmp: { offset: 400, bytes: baseMint } },
                    ],
                });

                if (pools.length > 0 && pools[0]) {
                    found++;
                    // Decode first matching pool
                    const pool = await this.decodeRaydiumV4Pool(pools[0].pubkey, pools[0].account.data);
                    if (pool) {
                        this.raydiumPools.set(baseMint, pool);
                    }
                }
            } catch (e) {
                // Rate limited or error, continue
            }

            // Rate limit protection
            if (found % 10 === 0 && found > 0) {
                console.log(`  Found ${found} Raydium pools so far...`);
                await this.sleep(100);
            }
        }

        console.log(`Tokens with Raydium V4 liquidity: ${found}/${sampleSize} sampled`);
        return found;
    }

    async decodeRaydiumV4Pool(pubkey: PublicKey, data: Buffer): Promise<PoolState | null> {
        // Raydium V4 AMM Layout (752 bytes):
        // Key offsets:
        // 336: baseVault (32)
        // 368: quoteVault (32)
        // 400: baseMint (32)
        // 432: quoteMint (32)

        if (data.length < 752) return null;

        const baseVault = new PublicKey(data.subarray(336, 368)).toBase58();
        const quoteVault = new PublicKey(data.subarray(368, 400)).toBase58();
        const baseMint = new PublicKey(data.subarray(400, 432)).toBase58();
        const quoteMint = new PublicKey(data.subarray(432, 464)).toBase58();

        const [baseBalance, quoteBalance] = await Promise.all([
            this.getTokenBalance(baseVault),
            this.getTokenBalance(quoteVault),
        ]);

        if (baseBalance === 0n || quoteBalance === 0n) return null;

        const price = Number(quoteBalance) / Number(baseBalance);
        const liquiditySOL = Number(quoteBalance) / 1e9;

        return {
            venue: "RaydiumV4",
            poolAddress: pubkey.toBase58(),
            baseMint,
            quoteMint,
            baseVault,
            quoteVault,
            baseReserve: baseBalance,
            quoteReserve: quoteBalance,
            price,
            liquiditySOL,
        };
    }

    async getTokenBalance(vault: string): Promise<bigint> {
        try {
            const info = await this.connection.getAccountInfo(new PublicKey(vault));
            if (!info || info.data.length < 72) return 0n;
            // SPL Token account: amount at offset 64
            return info.data.readBigUInt64LE(64);
        } catch {
            return 0n;
        }
    }

    analyzeOpportunities(): ScanResult {
        const result: ScanResult = {
            pumpswapPools: this.pumpswapPools.size,
            raydiumPools: this.raydiumPools.size,
            tokensWithBothVenues: 0,
            opportunities: [],
        };

        for (const [baseMint, pumpPool] of this.pumpswapPools) {
            const rayPool = this.raydiumPools.get(baseMint);
            if (!rayPool) continue;

            result.tokensWithBothVenues++;

            const pricePump = pumpPool.price;
            const priceRay = rayPool.price;

            // Buy on cheaper, sell on expensive
            const [buyPrice, sellPrice] = pricePump < priceRay
                ? [pricePump, priceRay]
                : [priceRay, pricePump];

            const divergencePct = ((sellPrice - buyPrice) / buyPrice) * 100;

            // Fee estimate: 0.30% + 0.25% + 0.1% tip = 0.65%
            const profitableBps = (divergencePct * 100) - 65;

            result.opportunities.push({
                baseMint,
                pumpswapPrice: pricePump,
                raydiumPrice: priceRay,
                divergencePct,
                profitableBps,
            });
        }

        // Sort by profitability
        result.opportunities.sort((a, b) => b.profitableBps - a.profitableBps);

        return result;
    }

    printResults(result: ScanResult): void {
        console.log("\n" + "=".repeat(60));
        console.log("CROSS-VENUE ANALYSIS RESULTS");
        console.log("=".repeat(60));

        console.log(`\nPumpSwap pools scanned: ${result.pumpswapPools}`);
        console.log(`Raydium V4 pools found: ${result.raydiumPools}`);
        console.log(`Tokens on BOTH venues: ${result.tokensWithBothVenues}`);
        console.log(`Cross-venue rate: ${((result.tokensWithBothVenues / result.pumpswapPools) * 100).toFixed(2)}%`);

        const profitable = result.opportunities.filter(o => o.profitableBps > 0);
        console.log(`\nOpportunities with divergence: ${result.opportunities.length}`);
        console.log(`Profitable after fees: ${profitable.length}`);

        if (profitable.length > 0) {
            console.log("\nTop opportunities:");
            for (const opp of profitable.slice(0, 10)) {
                console.log(`  ${opp.baseMint.slice(0, 8)}... | Div: ${opp.divergencePct.toFixed(2)}% | Profit: ${opp.profitableBps.toFixed(0)} bps`);
            }
        }

        console.log("\n" + "=".repeat(60));
        console.log("VERDICT:");
        if (result.tokensWithBothVenues < result.pumpswapPools * 0.05) {
            console.log("❌ Cross-venue liquidity is SPARSE (<5%). Pivot to single-venue strategy.");
        } else if (profitable.length === 0) {
            console.log("⚠️  Cross-venue exists but no profitable opportunities. Margins too thin.");
        } else {
            console.log("✅ Cross-venue opportunities exist. Proceed with arbitrage implementation.");
        }
        console.log("=".repeat(60) + "\n");
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

async function main() {
    console.log("Cross-Venue Opportunity Scanner");
    console.log("================================\n");

    const scanner = new CrossVenueScanner(HELIUS_RPC);

    // Phase 1: Scan PumpSwap
    await scanner.scanPumpSwapPools();

    // Phase 2: Check Raydium for matching tokens
    await scanner.checkRaydiumForTokens();

    // Phase 3: Analyze
    const result = scanner.analyzeOpportunities();
    scanner.printResults(result);
}

main().catch(console.error);