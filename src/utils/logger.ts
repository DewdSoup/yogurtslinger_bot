// src/utils/logger.ts
// Logger utility for yogurtslinger bot

export interface OpportunityLog {
    type: string;
    pool?: string;
    token?: string;
    venue?: string;
    profit?: number;
    spread?: number;
    action?: string;
    reason?: string;
    estimatedProfitSol?: number;
    netProfitBps?: number;
    [key: string]: unknown;
}

export function logOpportunity(log: OpportunityLog): void {
    const parts: string[] = [`[${log.type}]`];

    if (log.action) parts.push(log.action);
    if (log.pool) parts.push(`pool=${log.pool.slice(0, 8)}...`);
    if (log.token) parts.push(`token=${log.token.slice(0, 8)}...`);
    if (log.venue) parts.push(`venue=${log.venue}`);
    if (log.profit !== undefined) parts.push(`profit=${log.profit.toFixed(6)}`);
    if (log.estimatedProfitSol !== undefined) parts.push(`est=${log.estimatedProfitSol.toFixed(6)} SOL`);
    if (log.spread !== undefined) parts.push(`spread=${log.spread}bps`);
    if (log.netProfitBps !== undefined) parts.push(`net=${log.netProfitBps}bps`);
    if (log.reason) parts.push(`reason=${log.reason}`);

    console.log(parts.join(" | "));
}

export const logger = {
    info: (...args: unknown[]) => console.log("[INFO]", ...args),
    warn: (...args: unknown[]) => console.warn("[WARN]", ...args),
    error: (...args: unknown[]) => console.error("[ERROR]", ...args),
    debug: (...args: unknown[]) => {
        if (process.env.DEBUG === "1") {
            console.log("[DEBUG]", ...args);
        }
    },
};

export default logger;