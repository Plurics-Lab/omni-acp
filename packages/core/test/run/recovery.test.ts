import { describe, expect, it } from "vitest";
import type { RunRow } from "@omni-acp/protocol";
import { recoverRuns } from "../../src/run/recovery.js";
import { rawStore, type RawStore } from "../persist/support/raw-db.js";
import { T0, runId, runRow } from "../persist/support/rows.js";

/**
 * §24.4 rule 4 and rule 1, on the boot path: every live run of a foreign boot becomes
 * `abandoned` with a terminal `run.failed` delivery enqueued, and the two are ONE transaction.
 *
 * Owned by M2-B-WP-R.
 */

const withStore = async (fn: (raw: RawStore) => Promise<void> | void): Promise<void> => {
  const raw = await rawStore();
  try {
    await fn(raw);
  } finally {
    await raw.dispose();
  }
};

const hook = { url: "https://hooks.example.com/x" };

describe("recoverRuns (§24.4 rule 4)", () => {
  it("abandons every live run of a FOREIGN boot and enqueues one terminal delivery each", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 1, state: "running", boot: "boot_dead", webhook: hook }));
      raw.runs.put(runRow({ n: 2, state: "requires_action", boot: "boot_dead", webhook: hook }));
      // No webhook: abandoned all the same, with nothing to enqueue.
      raw.runs.put(runRow({ n: 3, state: "starting", boot: "boot_dead" }));
      // Already terminal, and OUR OWN live run — neither is ours to abandon.
      raw.runs.put(runRow({ n: 4, state: "succeeded", boot: "boot_dead" }));
      raw.runs.put(runRow({ n: 5, state: "running", boot: "boot_mine" }));

      const enqueued: RunRow[] = [];
      const result = recoverRuns(raw.runs, "boot_mine", T0 + 1_000, {
        enqueue: (row) => enqueued.push(row),
        transaction: (fn) => raw.transaction(fn),
      });

      expect(result.abandoned).toBe(3);
      for (const n of [1, 2, 3]) {
        const row = raw.runs.get(runId(n));
        expect(row?.snapshot.state).toBe("abandoned");
        // Its worker died with that boot, and leaving the run `running` would make
        // `GET /v1/runs/{rid}` lie for as long as the row survives.
        expect(row?.snapshot.error?.message).toMatch(/boot that owned this run is gone/);
        expect(row?.snapshot.updatedAt).toBe(new Date(T0 + 1_000).toISOString());
      }
      expect(raw.runs.get(runId(4))?.snapshot.state).toBe("succeeded");
      expect(raw.runs.get(runId(5))?.snapshot.state).toBe("running");

      // A terminal delivery only where there is a target to deliver to.
      expect(enqueued.map((r) => r.snapshot.runId)).toEqual([runId(1), runId(2)]);
      expect(enqueued.every((r) => r.snapshot.state === "abandoned")).toBe(true);
    });
  });

  it("claims the rows for THIS boot, so a second recovery is a no-op", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 1, state: "running", boot: "boot_dead", webhook: hook }));

      const first: RunRow[] = [];
      expect(
        recoverRuns(raw.runs, "boot_mine", T0, { enqueue: (r) => first.push(r) }).abandoned,
      ).toBe(1);

      const second: RunRow[] = [];
      // Leaving the dead boot's id on the row would make the NEXT restart abandon an
      // already-abandoned run and enqueue a second terminal webhook for one event.
      expect(
        recoverRuns(raw.runs, "boot_mine", T0, { enqueue: (r) => second.push(r) }).abandoned,
      ).toBe(0);
      expect(second).toHaveLength(0);
      expect(raw.runs.get(runId(1))?.bootId).toBe("boot_mine");
    });
  });

  it("a planted throw between the state change and the enqueue leaves NEITHER", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 1, state: "running", boot: "boot_dead", webhook: hook }));
      raw.runs.put(runRow({ n: 2, state: "running", boot: "boot_dead", webhook: hook }));

      expect(() =>
        recoverRuns(raw.runs, "boot_mine", T0, {
          transaction: (fn) => raw.transaction(fn),
          enqueue: (row) => {
            if (row.snapshot.runId === runId(2)) throw new Error("planted: the enqueue failed");
          },
        }),
      ).toThrow(/planted/);

      // Run 1 converged and committed. Run 2 rolled BACK — no abandoned state, no delivery.
      // A run that says it failed with a webhook that never fires (or the reverse, which is
      // worse) is exactly what the single transaction exists to make impossible.
      expect(raw.runs.get(runId(1))?.snapshot.state).toBe("abandoned");
      expect(raw.runs.get(runId(2))?.snapshot.state).toBe("running");
      expect(raw.runs.get(runId(2))?.bootId).toBe("boot_dead");
    });
  });

  it("is ONE transaction PER RUN, so a bad row does not roll back the good ones", async () => {
    await withStore((raw) => {
      for (const n of [1, 2, 3]) {
        raw.runs.put(runRow({ n, state: "running", boot: "boot_dead", webhook: hook }));
      }
      expect(() =>
        recoverRuns(raw.runs, "boot_mine", T0, {
          transaction: (fn) => raw.transaction(fn),
          enqueue: (row) => {
            if (row.snapshot.runId === runId(3)) throw new Error("planted");
          },
        }),
      ).toThrow();

      // A prefix converged; the suffix is exactly what the NEXT boot will find, in the state this
      // one found it — which is what makes the pass idempotent rather than all-or-nothing.
      expect(raw.runs.get(runId(1))?.snapshot.state).toBe("abandoned");
      expect(raw.runs.get(runId(2))?.snapshot.state).toBe("abandoned");
      expect(raw.runs.get(runId(3))?.snapshot.state).toBe("running");
      expect(raw.runs.liveFromOtherBoots("boot_mine").map((r) => r.snapshot.runId)).toEqual([
        runId(3),
      ]);
    });
  });

  it("works with NO transaction at all — the memory driver's honest guarantee", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 1, state: "running", boot: "boot_dead", webhook: hook }));
      const enqueued: RunRow[] = [];
      // Absent ⇒ the two writes happen IN ORDER, which is the strongest guarantee that driver
      // can give and is stated rather than assumed.
      expect(recoverRuns(raw.runs, "boot_mine", T0, { enqueue: (r) => enqueued.push(r) })).toEqual({
        abandoned: 1,
      });
      expect(enqueued).toHaveLength(1);
      expect(raw.runs.get(runId(1))?.snapshot.state).toBe("abandoned");
    });
  });

  it("is a no-op on an empty store", async () => {
    await withStore((raw) => {
      expect(recoverRuns(raw.runs, "boot_mine", T0)).toEqual({ abandoned: 0 });
    });
  });
});
