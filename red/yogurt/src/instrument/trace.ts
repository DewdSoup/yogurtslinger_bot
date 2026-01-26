/**
 * Structured Trace Logging
 * 
 * Captures events for replay and debugging.
 * Writes to captures/ directory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TraceEvent {
    timestamp: bigint;
    type: string;
    data: unknown;
}

export class TraceWriter {
    private stream: fs.WriteStream | null = null;
    private eventCount = 0;
    private filePath: string;

    constructor(captureDir: string, prefix: string = 'trace') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = path.join(captureDir, `${prefix}-${timestamp}.jsonl`);
    }

    /**
     * Open trace file
     */
    open(): void {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    }

    /**
     * Write trace event
     */
    write(type: string, data: unknown): void {
        if (!this.stream) return;

        const event: TraceEvent = {
            timestamp: process.hrtime.bigint(),
            type,
            data,
        };

        // Serialize bigints
        const json = JSON.stringify(event, (_, v) =>
            typeof v === 'bigint' ? v.toString() : v
        );

        this.stream.write(json + '\n');
        this.eventCount++;
    }

    /**
     * Write account update event
     */
    writeAccountUpdate(pubkey: Uint8Array, slot: number, owner: Uint8Array): void {
        this.write('account_update', {
            pubkey: Buffer.from(pubkey).toString('hex'),
            slot,
            owner: Buffer.from(owner).toString('hex'),
        });
    }

    /**
     * Write pending tx event
     */
    writePendingTx(signature: Uint8Array, slot: number): void {
        this.write('pending_tx', {
            signature: Buffer.from(signature).toString('hex'),
            slot,
        });
    }

    /**
     * Write sim event
     */
    writeSim(
        pool: Uint8Array,
        inputAmount: bigint,
        outputAmount: bigint,
        success: boolean,
        latencyUs: number
    ): void {
        this.write('sim', {
            pool: Buffer.from(pool).toString('hex'),
            inputAmount: inputAmount.toString(),
            outputAmount: outputAmount.toString(),
            success,
            latencyUs,
        });
    }

    /**
     * Write opportunity event
     */
    writeOpportunity(
        pool: Uint8Array,
        expectedProfit: bigint,
        submitted: boolean
    ): void {
        this.write('opportunity', {
            pool: Buffer.from(pool).toString('hex'),
            expectedProfit: expectedProfit.toString(),
            submitted,
        });
    }

    /**
     * Close trace file
     */
    close(): Promise<void> {
        return new Promise((resolve) => {
            if (this.stream) {
                this.stream.end(() => resolve());
                this.stream = null;
            } else {
                resolve();
            }
        });
    }

    /**
     * Get trace file path
     */
    getFilePath(): string {
        return this.filePath;
    }

    /**
     * Get event count
     */
    getEventCount(): number {
        return this.eventCount;
    }
}

/**
 * Trace reader for replay
 */
export class TraceReader {
    private filePath: string;

    constructor(filePath: string) {
        this.filePath = filePath;
    }

    /**
     * Read all events
     */
    *read(): Generator<TraceEvent> {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim());

        for (const line of lines) {
            const event = JSON.parse(line) as TraceEvent;
            // Convert timestamp back to bigint
            event.timestamp = BigInt(event.timestamp);
            yield event;
        }
    }

    /**
     * Read events of specific type
     */
    *readType(type: string): Generator<TraceEvent> {
        for (const event of this.read()) {
            if (event.type === type) {
                yield event;
            }
        }
    }
}

/**
 * Create trace writer
 */
export function createTraceWriter(captureDir: string): TraceWriter {
    const writer = new TraceWriter(captureDir);
    writer.open();
    return writer;
}