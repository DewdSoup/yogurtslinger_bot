// src/state/accountStore.ts
import { Buffer } from "buffer";

export type PubkeyStr = string;

export interface AccountVersion {
    slot: number;
    writeVersion: bigint;
}

export interface AccountMeta extends AccountVersion {
    owner: PubkeyStr;
    lamports: bigint;
    executable: boolean;
    rentEpoch: bigint;
}

export interface AccountUpdate {
    pubkey: PubkeyStr;
    data: Buffer;

    // Meta (Yellowstone/Geyser provides these)
    slot: number;
    writeVersion: bigint;
    owner: PubkeyStr;
    lamports: bigint;
    executable: boolean;
    rentEpoch: bigint;
}

export interface AccountView {
    pubkey: PubkeyStr;
    data: Buffer;
    meta: AccountMeta;
    deleted: boolean;
}

/**
 * Minimal store: raw bytes + ordering correctness.
 * Any decoding/simulation should operate on a Snapshot (read-only view).
 */
export interface AccountStore {
    apply(update: AccountUpdate): boolean;
    get(pubkey: PubkeyStr): AccountView | undefined;

    /**
     * Capture a stable view of the requested accounts for simulation.
     * This snapshots meta primitives and Buffer references (no Buffer copy).
     */
    snapshot(pubkeys: Iterable<PubkeyStr>): AccountSnapshot;

    /**
     * Optional interest-tracking: if enabled, store only tracked keys.
     * Useful if your gRPC stream is broad but your consumer cares about a subset.
     */
    track(pubkey: PubkeyStr): void;
    untrack(pubkey: PubkeyStr): void;
    isTracked(pubkey: PubkeyStr): boolean;

    size(): number;
}

export interface AccountSnapshot {
    readonly maxSlot: number;
    get(pubkey: PubkeyStr): AccountView | undefined;
}

function isNewer(
    slotA: number,
    writeA: bigint,
    slotB: number,
    writeB: bigint
): boolean {
    return slotA > slotB || (slotA === slotB && writeA > writeB);
}

type InternalRecord = {
    // mutable in-store record for perf
    data: Buffer;

    slot: number;
    writeVersion: bigint;
    owner: PubkeyStr;
    lamports: bigint;
    executable: boolean;
    rentEpoch: bigint;

    deleted: boolean;
};

export class InMemoryAccountStore implements AccountStore {
    private readonly records = new Map<PubkeyStr, InternalRecord>();

    // If null => store everything. If Set => store only tracked keys.
    private tracked: Set<PubkeyStr> | null;

    constructor(opts?: { interestOnly?: boolean }) {
        this.tracked = opts?.interestOnly ? new Set() : null;
    }

    apply(update: AccountUpdate): boolean {
        if (this.tracked && !this.tracked.has(update.pubkey)) return false;

        const prev = this.records.get(update.pubkey);
        if (prev) {
            if (!isNewer(update.slot, update.writeVersion, prev.slot, prev.writeVersion)) {
                return false;
            }

            // Update in place (lower allocation rate).
            prev.data = update.data;
            prev.slot = update.slot;
            prev.writeVersion = update.writeVersion;
            prev.owner = update.owner;
            prev.lamports = update.lamports;
            prev.executable = update.executable;
            prev.rentEpoch = update.rentEpoch;

            // Treat lamports=0 or empty data as a closure signal (tombstone semantics).
            prev.deleted = update.lamports === 0n || update.data.length === 0;
            return true;
        }

        this.records.set(update.pubkey, {
            data: update.data,
            slot: update.slot,
            writeVersion: update.writeVersion,
            owner: update.owner,
            lamports: update.lamports,
            executable: update.executable,
            rentEpoch: update.rentEpoch,
            deleted: update.lamports === 0n || update.data.length === 0,
        });

        return true;
    }

    get(pubkey: PubkeyStr): AccountView | undefined {
        const rec = this.records.get(pubkey);
        if (!rec) return undefined;
        return {
            pubkey,
            data: rec.data,
            meta: {
                slot: rec.slot,
                writeVersion: rec.writeVersion,
                owner: rec.owner,
                lamports: rec.lamports,
                executable: rec.executable,
                rentEpoch: rec.rentEpoch,
            },
            deleted: rec.deleted,
        };
    }

    /**
     * Zero-allocation hot-path helper: returns the raw data Buffer reference.
     * Avoids allocating AccountView/meta objects when you only need bytes.
     */
    getData(pubkey: PubkeyStr): Buffer | undefined {
        return this.records.get(pubkey)?.data;
    }

    snapshot(pubkeys: Iterable<PubkeyStr>): AccountSnapshot {
        const snap = new Map<PubkeyStr, AccountView>();
        let maxSlot = 0;

        for (const pk of pubkeys) {
            const rec = this.records.get(pk);
            if (!rec) continue;

            if (rec.slot > maxSlot) maxSlot = rec.slot;

            // Copy meta primitives; keep Buffer reference (no copy).
            snap.set(pk, {
                pubkey: pk,
                data: rec.data,
                meta: {
                    slot: rec.slot,
                    writeVersion: rec.writeVersion,
                    owner: rec.owner,
                    lamports: rec.lamports,
                    executable: rec.executable,
                    rentEpoch: rec.rentEpoch,
                },
                deleted: rec.deleted,
            });
        }

        return {
            maxSlot,
            get: (pk: PubkeyStr) => snap.get(pk),
        };
    }

    track(pubkey: PubkeyStr): void {
        if (!this.tracked) this.tracked = new Set();
        this.tracked.add(pubkey);
    }

    untrack(pubkey: PubkeyStr): void {
        if (!this.tracked) return;
        this.tracked.delete(pubkey);
        // Optional: you can also delete from records to bound memory
        // this.records.delete(pubkey);
    }

    isTracked(pubkey: PubkeyStr): boolean {
        return this.tracked ? this.tracked.has(pubkey) : true;
    }

    size(): number {
        return this.records.size;
    }
}
