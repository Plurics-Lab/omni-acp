import { OmniError, type PersistenceHandle } from "@omni-acp/protocol";

/**
 * M1's persistence harness: a real sqlite file under `mkdtemp`, reopenable, self-cleaning
 * (CONTRACTS.md §5.7).
 *
 * `reopen()` is the whole point — SAME file, NEW handle. That is the restart test, and it is
 * what proves `?since=N` returns the same envelopes with the same `seq` after a `stop()` /
 * `createDaemon()` cycle, including for a worker whose rows retention already evicted (§14.4).
 *
 * Owned by M1-WP-A.
 */
export interface TmpPersistence {
  handle: PersistenceHandle;
  dir: string;
  reopen(): Promise<PersistenceHandle>;
  dispose(): Promise<void>;
}

export function tmpPersistence(): Promise<TmpPersistence> {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
