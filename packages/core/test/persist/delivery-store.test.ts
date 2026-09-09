import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import { rawStore, type RawStore } from "./support/raw-db.js";
import { T0, deliveryId, payload, runId, tokenId } from "./support/rows.js";

/**
 * The `webhook_deliveries` table (schema v2, §24.2) — and the two methods §24.4's whole restart
 * argument rests on: `claim` is an atomic compare-and-set, and `requeueStale` leaves `attempt`
 * alone.
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

const enqueue = (raw: RawStore, n: number, o: { token?: string; nowMs?: number } = {}): void => {
  raw.deliveries.enqueue({
    deliveryId: deliveryId(n),
    runId: runId(n),
    tokenId: tokenId(o.token ?? "alice"),
    event: "run.completed",
    url: "https://hooks.example.com/x",
    payload: payload({ n }),
    nowMs: o.nowMs ?? T0 + n * 1_000,
  });
};

describe("createDeliveryStore (§24.2, §24.4)", () => {
  it("enqueues a row that is due IMMEDIATELY — rung 0 is 0s", async () => {
    await withStore((raw) => {
      enqueue(raw, 1, { nowMs: T0 });
      const [row] = raw.deliveries.due(T0, 10);
      expect(row?.deliveryId).toBe(deliveryId(1));
      expect(row?.state).toBe("pending");
      expect(row?.attempt).toBe(0);
      // The three fields the WIRE record has no room for, which the dispatcher needs.
      expect(row?.url).toBe("https://hooks.example.com/x");
      expect(row?.tokenId).toBe("alice");
      expect(row?.payload).toEqual(payload({ n: 1 }));
      // A row is not due before its own time.
      expect(raw.deliveries.due(T0 - 1, 10)).toHaveLength(0);
    });
  });

  it("orders `due` oldest rung first, so a long-waiting delivery is not starved", async () => {
    await withStore((raw) => {
      enqueue(raw, 3, { nowMs: T0 + 3_000 });
      enqueue(raw, 1, { nowMs: T0 + 1_000 });
      enqueue(raw, 2, { nowMs: T0 + 2_000 });
      expect(raw.deliveries.due(T0 + 10_000, 10).map((r) => r.deliveryId)).toEqual([
        deliveryId(1),
        deliveryId(2),
        deliveryId(3),
      ]);
      expect(raw.deliveries.due(T0 + 10_000, 2)).toHaveLength(2);
    });
  });

  describe("claim — the compare-and-set", () => {
    it("two dispatchers racing ONE row see EXACTLY ONE succeed", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        const results = [
          raw.deliveries.claim(deliveryId(1), "boot_a", T0),
          raw.deliveries.claim(deliveryId(1), "boot_b", T0),
          raw.deliveries.claim(deliveryId(1), "boot_a", T0),
        ];
        expect(results).toEqual([true, false, false]);
        // The winner's boot is stamped, and it is the only thing that later distinguishes "in
        // flight now" from "in flight when the process died".
        expect(raw.deliveries.get(deliveryId(1))?.leaseBoot).toBe("boot_a");
        expect(raw.deliveries.get(deliveryId(1))?.state).toBe("delivering");
        // ...and a claimed row is no longer due, so nobody else even looks at it.
        expect(raw.deliveries.due(T0, 10)).toHaveLength(0);
      });
    });

    it("is false for a row that does not exist", async () => {
      await withStore((raw) => {
        expect(raw.deliveries.claim(deliveryId(99), "boot_a", T0)).toBe(false);
      });
    });
  });

  describe("settle", () => {
    it("counts the attempt, whichever way it went", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_a", T0);
        raw.deliveries.settle({
          deliveryId: deliveryId(1),
          ok: false,
          status: 500,
          error: "receiver answered 500",
          responseMs: 12,
          nextAttemptMs: T0 + 30_000,
          state: "pending",
          nowMs: T0 + 12,
        });
        const row = raw.deliveries.get(deliveryId(1));
        // `attempt` counts attempts that COMPLETED, and `settle` is the only thing that moves it.
        expect(row?.attempt).toBe(1);
        expect(row?.state).toBe("pending");
        expect(row?.lastStatus).toBe(500);
        expect(row?.responseMs).toBe(12);
        expect(row?.nextAttemptAt).toBe(new Date(T0 + 30_000).toISOString());
        // The lease is released: this boot is no longer holding it.
        expect(row?.leaseBoot).toBeNull();
        expect(raw.deliveries.due(T0 + 30_000, 10)).toHaveLength(1);
      });
    });

    it("clears the next attempt on a terminal state", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_a", T0);
        raw.deliveries.settle({
          deliveryId: deliveryId(1),
          ok: true,
          status: 204,
          error: null,
          responseMs: 3,
          nextAttemptMs: null,
          state: "delivered",
          nowMs: T0 + 3,
        });
        const row = raw.deliveries.get(deliveryId(1));
        expect(row?.state).toBe("delivered");
        expect(row?.nextAttemptAt).toBeNull();
        // A row nothing will ever act on is never due again.
        expect(raw.deliveries.due(Number.MAX_SAFE_INTEGER, 10)).toHaveLength(0);
      });
    });
  });

  describe("requeueStale — §24.4 rule 3", () => {
    it("re-queues a FOREIGN boot's `delivering` row with `attempt` UNCHANGED", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_dead", T0);
        raw.deliveries.settle({
          deliveryId: deliveryId(1),
          ok: false,
          status: 500,
          error: "x",
          responseMs: 1,
          nextAttemptMs: T0 + 30_000,
          state: "pending",
          nowMs: T0 + 1,
        });
        // A second, uncompleted attempt: claimed, then the process died.
        raw.deliveries.claim(deliveryId(1), "boot_dead", T0 + 30_000);
        expect(raw.deliveries.get(deliveryId(1))?.attempt).toBe(1);

        expect(raw.deliveries.requeueStale("boot_new", T0 + 60_000)).toBe(1);
        const row = raw.deliveries.get(deliveryId(1));
        expect(row?.state).toBe("pending");
        expect(row?.leaseBoot).toBeNull();
        // UNCHANGED. Charging the attempt would silently shorten the ladder on every restart —
        // and this is the write-down of the consequence: delivery is AT LEAST ONCE, and
        // `deliveryId` is the dedupe key.
        expect(row?.attempt).toBe(1);
        // It is owed its attempt immediately, not a fresh rung.
        expect(row?.nextAttemptAt).toBe(new Date(T0 + 60_000).toISOString());
      });
    });

    it("leaves OUR OWN in-flight row alone", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        enqueue(raw, 2, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_mine", T0);
        raw.deliveries.claim(deliveryId(2), "boot_dead", T0);
        // A dispatcher that re-queued its own in-flight attempts would send every delivery twice
        // on every boot.
        expect(raw.deliveries.requeueStale("boot_mine", T0 + 1)).toBe(1);
        expect(raw.deliveries.get(deliveryId(1))?.state).toBe("delivering");
        expect(raw.deliveries.get(deliveryId(2))?.state).toBe("pending");
      });
    });

    it("survives a restart of the file itself", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_dead", T0);
        raw.reopen();
        expect(raw.deliveries.get(deliveryId(1))?.state).toBe("delivering");
        expect(raw.deliveries.requeueStale("boot_new", T0 + 5)).toBe(1);
        expect(raw.deliveries.get(deliveryId(1))?.state).toBe("pending");
        expect(raw.deliveries.get(deliveryId(1))?.payload).toEqual(payload({ n: 1 }));
      });
    });
  });

  describe("redeliver — §24.4 rule 6", () => {
    it("KEEPS the deliveryId and resets `attempt` to 0", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { nowMs: T0 });
        raw.deliveries.claim(deliveryId(1), "boot_a", T0);
        raw.deliveries.settle({
          deliveryId: deliveryId(1),
          ok: false,
          status: 500,
          error: "receiver answered 500",
          responseMs: 5,
          nextAttemptMs: null,
          state: "failed",
          nowMs: T0 + 5,
        });

        const replayed = raw.deliveries.redeliver(deliveryId(1), T0 + 10_000);
        // The SAME id, which is what makes it a dead-letter REPLAY rather than a second event: a
        // receiver that deduplicates correctly ignores it, and that is correct — it already has it.
        expect(replayed.deliveryId).toBe(deliveryId(1));
        expect(replayed.attempt).toBe(0);
        expect(replayed.state).toBe("pending");
        expect(replayed.lastStatus).toBeNull();
        expect(replayed.lastError).toBeNull();
        expect(raw.deliveries.due(T0 + 10_000, 10).map((r) => r.deliveryId)).toEqual([
          deliveryId(1),
        ]);
      });
    });

    it("is admin-or-owner: another token's delivery is `worker_not_found`, not `forbidden`", async () => {
      await withStore((raw) => {
        enqueue(raw, 1, { token: "alice", nowMs: T0 });
        // One answer for "no such delivery" and for "not yours" — the second must not confirm the
        // id is real (D13's rule, applied to a delivery).
        expect(() => raw.deliveries.redeliver(deliveryId(1), T0, tokenId("bob"))).toThrow(
          OmniError,
        );
        let code = "no-throw";
        try {
          raw.deliveries.redeliver(deliveryId(1), T0, tokenId("bob"));
        } catch (e) {
          code = e instanceof OmniError ? e.code : "?";
        }
        expect(code).toBe("worker_not_found");
        // ...and it did NOT re-queue it as a side effect.
        expect(raw.deliveries.get(deliveryId(1))?.state).toBe("pending");

        expect(raw.deliveries.redeliver(deliveryId(1), T0, tokenId("alice")).attempt).toBe(0);
        // No scope at all is admin.
        expect(raw.deliveries.redeliver(deliveryId(1), T0).attempt).toBe(0);
      });
    });

    it("throws for an id nobody enqueued", async () => {
      await withStore((raw) => {
        expect(() => raw.deliveries.redeliver(deliveryId(99), T0)).toThrow(/no delivery/);
      });
    });
  });

  describe("list", () => {
    it("filters by run, state and token, and pages newest-first", async () => {
      await withStore((raw) => {
        for (let n = 1; n <= 4; n++) enqueue(raw, n, { token: "alice", nowMs: T0 + n * 1_000 });
        enqueue(raw, 5, { token: "bob", nowMs: T0 + 5_000 });
        raw.deliveries.claim(deliveryId(2), "boot_a", T0);

        expect(raw.deliveries.list({ limit: 50 }).rows).toHaveLength(5);
        expect(
          raw.deliveries
            .list({ limit: 50, tokenId: tokenId("alice") })
            .rows.map((r) => r.deliveryId),
        ).toEqual([deliveryId(4), deliveryId(3), deliveryId(2), deliveryId(1)]);
        expect(
          raw.deliveries.list({ limit: 50, state: "delivering" }).rows.map((r) => r.deliveryId),
        ).toEqual([deliveryId(2)]);
        expect(
          raw.deliveries.list({ limit: 50, runId: runId(3) }).rows.map((r) => r.deliveryId),
        ).toEqual([deliveryId(3)]);

        const first = raw.deliveries.list({ limit: 2, tokenId: tokenId("alice") });
        expect(first.rows.map((r) => r.deliveryId)).toEqual([deliveryId(4), deliveryId(3)]);
        const second = raw.deliveries.list({
          limit: 2,
          tokenId: tokenId("alice"),
          cursor: first.cursor ?? "",
        });
        expect(second.rows.map((r) => r.deliveryId)).toEqual([deliveryId(2), deliveryId(1)]);
        expect(second.cursor).toBeNull();
      });
    });

    it("survives a restart", async () => {
      await withStore((raw) => {
        for (let n = 1; n <= 3; n++) enqueue(raw, n, { nowMs: T0 + n * 1_000 });
        raw.reopen();
        const page = raw.deliveries.list({ limit: 50 });
        expect(page.rows.map((r) => r.deliveryId)).toEqual([
          deliveryId(3),
          deliveryId(2),
          deliveryId(1),
        ]);
      });
    });
  });

  it("sweeps rows older than the cutoff", async () => {
    await withStore((raw) => {
      enqueue(raw, 1, { nowMs: T0 });
      enqueue(raw, 2, { nowMs: T0 + 100_000 });
      expect(raw.deliveries.sweep({ olderThanMs: T0 + 50_000 })).toBe(1);
      expect(raw.deliveries.get(deliveryId(1))).toBeNull();
      expect(raw.deliveries.get(deliveryId(2))).not.toBeNull();
    });
  });
});
