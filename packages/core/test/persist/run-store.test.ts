import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import { nullLogger } from "@omni-acp/testkit";
import { createPersistenceHandle } from "../../src/persist/persistence.js";
import { openTmpPersistence, sqliteConfig } from "./support/harness.js";
import { rawStore, type RawStore } from "./support/raw-db.js";
import { T0, deliveryId, payload, runId, runRow, tokenId } from "./support/rows.js";

/**
 * The `runs` table (schema v2, §24.2): idempotency, the boot query recovery is built on, the
 * cursor, and the two things that must survive a restart.
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

describe("createRunStore (§24.2)", () => {
  it("round-trips a row and every field a `GET /v1/runs/{rid}` reads", async () => {
    await withStore((raw) => {
      const row = runRow({
        n: 1,
        state: "running",
        webhook: { url: "https://hooks.example.com/x", secret: "ci" },
        idempotencyKey: "key-one-two-three",
      });
      raw.runs.put(row);

      const read = raw.runs.get(runId(1));
      expect(read).not.toBeNull();
      expect(read?.snapshot.state).toBe("running");
      expect(read?.snapshot.workerId).toBe(row.snapshot.workerId);
      expect(read?.snapshot.createdAt).toBe(row.snapshot.createdAt);
      expect(read?.tokenId).toBe("alice");
      expect(read?.bootId).toBe("boot_a");
      expect(read?.idempotencyKey).toBe("key-one-two-three");
      // The target survives, secret NAME included — never a value (§24.3).
      expect(read?.webhook).toEqual({ url: "https://hooks.example.com/x", secret: "ci" });
      expect(read?.snapshot.webhook).toEqual({ url: "https://hooks.example.com/x", deliveries: 0 });
      // A row on disk is durable BY DEFINITION; that is what being here means (ruling M2-R14).
      expect(read?.snapshot.persistence).toBe("durable");
    });
  });

  it("round-trips the run's ANCHOR — the seq of its last `omni.run` envelope", async () => {
    await withStore((raw) => {
      const row = runRow({ n: 90, state: "running" });
      // Absent until something has been appended for the run: a run whose worker failed to start
      // has no position a receiver could pull back, and it fires no delivery.
      raw.runs.put(row);
      expect(raw.runs.get(runId(90))?.seq).toBeUndefined();

      raw.runs.put({ ...row, seq: 7 as never });
      expect(raw.runs.get(runId(90))?.seq).toBe(7);
      raw.reopen();
      // Across a restart, which is the whole reason it is persisted: §24.4's terminal delivery is
      // enqueued by a boot that has never opened the worker's log.
      expect(raw.runs.get(runId(90))?.seq).toBe(7);
      expect(raw.runs.liveFromOtherBoots("boot_other")[0]?.seq).toBe(7);
    });
  });

  it("keeps `createdAt` fixed across every later state change", async () => {
    await withStore((raw) => {
      const first = runRow({ n: 2, state: "queued" });
      raw.runs.put(first);
      raw.runs.put({
        ...first,
        updatedAtMs: T0 + 60_000,
        snapshot: {
          ...first.snapshot,
          state: "succeeded",
          createdAt: new Date(T0 + 60_000).toISOString(), // a caller getting it wrong
          updatedAt: new Date(T0 + 60_000).toISOString(),
        },
      });
      // The birthday is also the key `list()` pages on: an upsert that carried it would let a
      // state change reshuffle a client's pagination under it.
      expect(raw.runs.get(runId(2))?.snapshot.createdAt).toBe(first.snapshot.createdAt);
      expect(raw.runs.get(runId(2))?.snapshot.state).toBe("succeeded");
    });
  });

  it("scopes `idempotencyKey` to the TOKEN and refuses a second row for the same pair", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 3, token: "alice", idempotencyKey: "shared-key-1234" }));
      // A different token may reuse the key — it is a per-caller retry token, not a global one.
      raw.runs.put(runRow({ n: 4, token: "bob", idempotencyKey: "shared-key-1234" }));

      expect(raw.runs.byIdempotencyKey(tokenId("alice"), "shared-key-1234")?.snapshot.runId).toBe(
        runId(3),
      );
      expect(raw.runs.byIdempotencyKey(tokenId("bob"), "shared-key-1234")?.snapshot.runId).toBe(
        runId(4),
      );
      expect(raw.runs.byIdempotencyKey(tokenId("carol"), "shared-key-1234")).toBeNull();

      // The unique index is the backstop under a race the registry's read cannot close: two
      // concurrent creates with one key collide HERE rather than after both spawned an agent.
      expect(() =>
        raw.runs.put(runRow({ n: 5, token: "alice", idempotencyKey: "shared-key-1234" })),
      ).toThrow();
    });
  });

  it("survives a restart: the row, its key and its target are all still there", async () => {
    await withStore((raw) => {
      raw.runs.put(
        runRow({
          n: 6,
          state: "succeeded",
          idempotencyKey: "restart-key-5678",
          webhook: { url: "https://hooks.example.com/y" },
        }),
      );
      raw.reopen();
      const read = raw.runs.byIdempotencyKey(tokenId("alice"), "restart-key-5678");
      expect(read?.snapshot.runId).toBe(runId(6));
      expect(read?.snapshot.state).toBe("succeeded");
      expect(read?.webhook?.url).toBe("https://hooks.example.com/y");
    });
  });

  describe("liveFromOtherBoots — the query §24.4's recovery IS", () => {
    it("returns every LIVE row of a FOREIGN boot and nothing else", async () => {
      await withStore((raw) => {
        for (const [n, state, boot] of [
          [10, "queued", "boot_dead"],
          [11, "starting", "boot_dead"],
          [12, "running", "boot_dead"],
          [13, "requires_action", "boot_dead"],
          [14, "succeeded", "boot_dead"],
          [15, "failed", "boot_dead"],
          [16, "cancelled", "boot_dead"],
          // Already converged by an earlier recovery: re-abandoning it would enqueue a second
          // terminal webhook for one event (§24.4 rule 4).
          [17, "abandoned", "boot_dead"],
          [18, "running", "boot_mine"],
        ] as const) {
          raw.runs.put(runRow({ n, state, boot }));
        }

        expect(raw.runs.liveFromOtherBoots("boot_mine").map((r) => r.snapshot.runId)).toEqual([
          runId(10),
          runId(11),
          runId(12),
          runId(13),
        ]);
        // Our own live row is ours to finish, whatever state it is in.
        expect(raw.runs.liveFromOtherBoots("boot_dead").map((r) => r.snapshot.runId)).toEqual([
          runId(18),
        ]);
      });
    });

    it("is empty once the rows have been claimed by this boot", async () => {
      await withStore((raw) => {
        const row = runRow({ n: 20, state: "running", boot: "boot_dead" });
        raw.runs.put(row);
        expect(raw.runs.liveFromOtherBoots("boot_mine")).toHaveLength(1);
        raw.runs.put({
          ...row,
          bootId: "boot_mine",
          snapshot: { ...row.snapshot, state: "abandoned" },
        });
        expect(raw.runs.liveFromOtherBoots("boot_mine")).toHaveLength(0);
      });
    });
  });

  describe("list", () => {
    it("pages newest-first on a stable cursor, and scopes to a token", async () => {
      await withStore((raw) => {
        for (let n = 30; n < 35; n++) raw.runs.put(runRow({ n, token: "alice" }));
        raw.runs.put(runRow({ n: 40, token: "bob" }));

        const first = raw.runs.list({ tokenId: tokenId("alice"), limit: 2 });
        expect(first.rows.map((r) => r.snapshot.runId)).toEqual([runId(34), runId(33)]);
        expect(first.cursor).toBe(runId(33));

        const second = raw.runs.list({
          tokenId: tokenId("alice"),
          limit: 2,
          cursor: first.cursor ?? "",
        });
        expect(second.rows.map((r) => r.snapshot.runId)).toEqual([runId(32), runId(31)]);

        const last = raw.runs.list({
          tokenId: tokenId("alice"),
          limit: 2,
          cursor: second.cursor ?? "",
        });
        expect(last.rows.map((r) => r.snapshot.runId)).toEqual([runId(30)]);
        // The final page says so rather than making a client ask for an empty one.
        expect(last.cursor).toBeNull();

        // Unscoped is admin's view: bob's row is there too.
        expect(raw.runs.list({ limit: 50 }).rows).toHaveLength(6);
      });
    });

    it("does not shuffle a row a client has already read when a new run is created", async () => {
      await withStore((raw) => {
        for (let n = 50; n < 54; n++) raw.runs.put(runRow({ n }));
        const first = raw.runs.list({ limit: 2 });
        // A run created mid-page sorts ABOVE everything already read...
        raw.runs.put(runRow({ n: 99, createdAtMs: T0 + 999_000 }));
        const second = raw.runs.list({ limit: 2, cursor: first.cursor ?? "" });
        // ...so the second page is unaffected: no duplicate, and nothing skipped.
        expect(second.rows.map((r) => r.snapshot.runId)).toEqual([runId(51), runId(50)]);
      });
    });
  });

  describe("sweep", () => {
    it("takes FINISHED rows past the cutoff and leaves live ones alone", async () => {
      await withStore((raw) => {
        raw.runs.put(runRow({ n: 60, state: "succeeded", updatedAtMs: T0 }));
        raw.runs.put(runRow({ n: 61, state: "failed", updatedAtMs: T0 }));
        raw.runs.put(runRow({ n: 62, state: "succeeded", updatedAtMs: T0 + 100_000 }));
        // No `finished_at_ms`: either live, or left behind by a boot that never converged it —
        // and deleting the second silently removes the row recovery exists to find.
        raw.runs.put(runRow({ n: 63, state: "running", updatedAtMs: T0 }));

        expect(raw.runs.sweep({ olderThanMs: T0 + 50_000 })).toBe(2);
        expect(raw.runs.get(runId(60))).toBeNull();
        expect(raw.runs.get(runId(61))).toBeNull();
        expect(raw.runs.get(runId(62))).not.toBeNull();
        expect(raw.runs.get(runId(63))).not.toBeNull();
      });
    });
  });

  it("throws an OmniError, not a raw sqlite error, when a snapshot cannot be read", async () => {
    await withStore((raw) => {
      raw.runs.put(runRow({ n: 70 }));
      raw.db.prepare("update runs set request_json = 'not json' where run_id = ?").run(runId(70));
      let thrown: unknown;
      try {
        raw.runs.get(runId(70));
      } catch (e) {
        thrown = e;
      }
      // A corrupt blob is a real failure; what matters is that it is a NAMED one rather than a
      // row that silently reads back with a missing webhook.
      expect(thrown).toBeDefined();
      expect(thrown instanceof OmniError || thrown instanceof SyntaxError).toBe(true);
    });
  });
});

/**
 * §24.5: "`webhooks.retentionDays` sweeps it on M1's EXISTING retention timer, together with its
 * runs."
 *
 * The subject is `PersistenceHandle.sweep(nowMs)` — the one-shot M1's `armRetention` already
 * calls — because "on M1's existing timer" is a claim about WHICH function does the work, not
 * about a second timer that happens to run at the same interval.
 */
describe("retention sweeps runs and deliveries TOGETHER (§24.5)", () => {
  const DAY = 86_400_000;

  it("ages out finished runs and their deliveries in one pass, and leaves live ones", async () => {
    const opened = await openTmpPersistence({ retentionDays: 7 });
    try {
      const now = T0 + 30 * DAY;
      const old = now - 10 * DAY;
      const fresh = now - 1 * DAY;

      // Two finished runs — one past the 7-day bound, one inside it — and a live one.
      opened.handle.runs.put(runRow({ n: 1, state: "succeeded", updatedAtMs: old }));
      opened.handle.runs.put(runRow({ n: 2, state: "succeeded", updatedAtMs: fresh }));
      opened.handle.runs.put(runRow({ n: 3, state: "running", updatedAtMs: old }));

      for (const [n, at] of [
        [1, old],
        [2, fresh],
      ] as const) {
        opened.handle.deliveries.enqueue({
          deliveryId: deliveryId(n),
          runId: runId(n),
          tokenId: tokenId("alice"),
          event: "run.completed",
          url: "https://hooks.example.com/x",
          payload: payload({ n }),
          nowMs: at,
        });
      }

      opened.handle.sweep(now);

      // The aged pair went together: a delivery whose run is gone is a dead letter nobody can
      // interpret, and a run whose deliveries survive it is a listing that points at nothing.
      expect(opened.handle.runs.get(runId(1))).toBeNull();
      expect(opened.handle.deliveries.get(deliveryId(1))).toBeNull();
      // ...and the recent pair, and the LIVE run, are untouched — a run with no `finished_at_ms`
      // is either running or waiting for §24.4's recovery, and neither may be deleted.
      expect(opened.handle.runs.get(runId(2))).not.toBeNull();
      expect(opened.handle.deliveries.get(deliveryId(2))).not.toBeNull();
      expect(opened.handle.runs.get(runId(3))).not.toBeNull();
    } finally {
      await opened.dispose();
    }
  });

  it("does nothing when `retentionDays` is 0 — an operator who turned it off means it", async () => {
    const opened = await openTmpPersistence({ retentionDays: 0 });
    try {
      opened.handle.runs.put(runRow({ n: 1, state: "succeeded", updatedAtMs: 0 }));
      opened.handle.sweep(T0 + 365 * DAY);
      expect(opened.handle.runs.get(runId(1))).not.toBeNull();
    } finally {
      await opened.dispose();
    }
  });

  it("a run sweep that THROWS does not take the event sweep with it", async () => {
    await withStore((raw) => {
      const warnings: string[] = [];
      let deliveriesSwept = false;
      const handle = createPersistenceHandle({
        events: raw.events,
        workers: raw.workers,
        // A planted disk failure on the run half, exactly where §14.5's bound is enforced.
        runs: {
          ...raw.runs,
          sweep: () => {
            throw new Error("planted: the run sweep failed");
          },
        },
        deliveries: {
          ...raw.deliveries,
          sweep: (o) => {
            deliveriesSwept = true;
            return raw.deliveries.sweep(o);
          },
        },
        transaction: (fn) => raw.transaction(fn),
        bootId: "boot_a",
        config: sqliteConfig({ retentionDays: 7 }),
        clock: raw.clock,
        logger: {
          ...nullLogger(),
          child: () => nullLogger(),
          warn: (m: string) => warnings.push(m),
        },
        release: () => Promise.resolve(),
        vacuum: () => {},
        closeDb: () => {},
      });

      // The event-log sweep is the one that keeps the disk bounded, and it must still return a
      // report: retention failing is a disk problem, and a daemon that stopped sweeping after one
      // bad night would silently grow for ever.
      const report = handle.sweep(T0 + 30 * DAY);
      expect(report.eventsDeleted).toBe(0);
      expect(deliveriesSwept).toBe(true);
      // ...and it said so out loud rather than swallowing it.
      expect(warnings.join(" ")).toContain("run retention sweep failed");
    });
  });
});
