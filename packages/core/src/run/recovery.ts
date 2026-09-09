import type { RunState } from "@omni-acp/protocol";
import type { RunRowV2, RunStoreV2 } from "../persist/run-store.js";

/** What `recoverRuns` needs beyond the store, and what each piece is for. */
export interface RunRecoveryOptions {
  /**
   * Enqueue this run's terminal `run.failed` delivery. Called INSIDE `transaction`, so §24.4
   * rule 1 holds for the recovery path too — a run that reached `abandoned` with no delivery row
   * is a webhook that will never be sent and never be retried.
   *
   * Absent ⇒ the run has no webhook, or webhooks are not enabled at all.
   */
  readonly enqueue?: (row: RunRowV2) => void;
  /**
   * Runs `fn` atomically. Absent ⇒ the driver has no transaction (the memory driver), and the
   * two writes happen in order — which is the strongest guarantee that driver can give, and it
   * is stated here rather than assumed.
   */
  readonly transaction?: <T>(fn: () => T) => T;
  readonly iso?: (ms: number) => string;
}

const ABANDONED_REASON =
  "the boot that owned this run is gone; its worker died with it (§24.4 rule 4)";

/**
 * §24.4. Every run whose `bootId` is not ours and whose state is LIVE becomes `abandoned`, with a
 * terminal `run.failed` delivery enqueued.
 *
 * Its worker died with that boot, so the run can never finish; leaving it `running` would make a
 * receiver wait forever for a completion nobody will ever send. The state change and the enqueue
 * are ONE transaction — a planted throw between them must leave NEITHER, or a restart produces a
 * run that says it failed and a webhook that never fires (or the reverse, which is worse).
 *
 * ONE transaction PER RUN rather than one for the whole sweep: a single bad row must not roll
 * back the recovery of every other run, and a boot that dies halfway through leaves a prefix of
 * converged runs plus a suffix the NEXT boot will find in exactly the same state this one did.
 * The pass is therefore idempotent, which is the property a recovery path actually needs.
 *
 * Owned by M2-B-WP-R.
 */
export function recoverRuns(
  store: RunStoreV2,
  bootId: string,
  nowMs: number,
  o: RunRecoveryOptions = {},
): { abandoned: number } {
  const iso = o.iso ?? ((ms: number) => new Date(ms).toISOString());
  const atomically = o.transaction ?? (<T>(fn: () => T): T => fn());

  let abandoned = 0;
  for (const row of store.liveFromOtherBoots(bootId)) {
    const next: RunRowV2 = {
      ...row,
      // `bootId` becomes OURS: the row has been converged by this boot, and leaving the dead
      // boot's id on it would make the next restart abandon an already-abandoned run and enqueue
      // a second terminal webhook for one event.
      bootId,
      updatedAtMs: nowMs,
      snapshot: {
        ...row.snapshot,
        state: "abandoned" satisfies RunState,
        updatedAt: iso(nowMs),
        error: {
          code: "internal",
          message: ABANDONED_REASON,
        },
      },
    };
    atomically(() => {
      store.put(next);
      if (next.webhook !== null) o.enqueue?.(next);
    });
    abandoned += 1;
  }
  return { abandoned };
}
