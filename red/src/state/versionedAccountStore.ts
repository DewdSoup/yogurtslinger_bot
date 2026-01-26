// src/state/versionedAccountStore.ts
// Maintains (current, previous) per account, and records per-txn pre/post pairs
// using txnSignature from LaserStream account updates.
//
// This is specifically for capture/replay reliability, not hot-path simulation.

export interface StoredAccount {
    pubkey: string;
    owner: string;
    lamports: bigint;
    executable: boolean;
    rentEpoch: bigint;
    data: Buffer;
    slot?: number | undefined;
    writeVersion?: bigint | undefined;
}

export interface TxnAccountPrePost {
    pre?: StoredAccount | undefined;
    post: StoredAccount;
}

export interface AccountUpdateWithTxn {
    pubkey: string;
    account: {
        owner: string;
        lamports: bigint;
        executable: boolean;
        rentEpoch: bigint;
        data: Buffer;
    };
    slot?: number;
    writeVersion?: bigint;
    txnSignature?: string;
}

export class VersionedAccountStore {
    private current = new Map<string, StoredAccount>();
    private previous = new Map<string, StoredAccount>();
    private perTxn = new Map<string, Map<string, TxnAccountPrePost>>();
    private perTxnLastSeenSlot = new Map<string, number>();

    getCurrent(pubkey: string): StoredAccount | undefined {
        return this.current.get(pubkey);
    }

    getPreForTxn(signature: string, pubkey: string): StoredAccount | undefined {
        const m = this.perTxn.get(signature);
        return m?.get(pubkey)?.pre;
    }

    getPostForTxn(signature: string, pubkey: string): StoredAccount | undefined {
        const m = this.perTxn.get(signature);
        return m?.get(pubkey)?.post;
    }

    drainTxn(signature: string): Map<string, TxnAccountPrePost> | undefined {
        const m = this.perTxn.get(signature);
        this.perTxn.delete(signature);
        this.perTxnLastSeenSlot.delete(signature);
        return m;
    }

    // Keep this conservative; capture scripts should also prune.
    pruneTxnsOlderThanSlot(minSlot: number) {
        for (const [sig, slot] of this.perTxnLastSeenSlot.entries()) {
            if (slot < minSlot) {
                this.perTxn.delete(sig);
                this.perTxnLastSeenSlot.delete(sig);
            }
        }
    }

    upsert(pubkey: string, next: StoredAccount) {
        const cur = this.current.get(pubkey);
        if (cur) this.previous.set(pubkey, cur);
        this.current.set(pubkey, next);
    }

    applyUpdate(update: AccountUpdateWithTxn) {
        const cur = this.current.get(update.pubkey);
        const pre = cur ? { ...cur, data: Buffer.from(cur.data) } : undefined;

        const post: StoredAccount = {
            pubkey: update.pubkey,
            owner: update.account.owner,
            lamports: update.account.lamports,
            executable: update.account.executable,
            rentEpoch: update.account.rentEpoch,
            data: update.account.data,
            slot: update.slot,
            writeVersion: update.writeVersion,
        };

        // Update store
        if (cur) this.previous.set(update.pubkey, cur);
        this.current.set(update.pubkey, post);

        // Record per-txn (if available)
        if (update.txnSignature) {
            const sig = update.txnSignature;
            let m = this.perTxn.get(sig);
            if (!m) {
                m = new Map();
                this.perTxn.set(sig, m);
            }

            // Preserve the earliest pre we saw for this txn/account.
            const existing = m.get(update.pubkey);
            if (existing) {
                m.set(update.pubkey, { pre: existing.pre ?? pre, post });
            } else {
                m.set(update.pubkey, { pre, post });
            }

            if (typeof update.slot === "number") {
                this.perTxnLastSeenSlot.set(sig, update.slot);
            }
        }
    }
}
