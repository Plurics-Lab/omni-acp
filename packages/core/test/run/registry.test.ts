import { afterEach, describe, expect, it } from "vitest";
import { OmniError, reduceTurn, type EventEnvelope, type RunId } from "@omni-acp/protocol";
import { fakeAuth, endTurn, idle, neverSettles } from "./support/fake-workers.js";
import { rig, runRequest, until, type Rig } from "./support/rig.js";

/**
 * M2-B-WP-R's acceptance script (docs/M2-PLAN.md §2), one `describe` per bullet.
 *
 * Bullets 1-5's store and dispatcher halves live in `test/persist/**` and `test/webhook/**`; this
 * file is the REGISTRY's half — create + prompt + settle + close, idempotency, park, the memory
 * driver, and §24.4 rule 1's one transaction.
 *
 * Owned by M2-B-WP-R.
 */

const ALICE = fakeAuth({ tokenId: "alice" });
const BOB = fakeAuth({ tokenId: "bob" });
const ADMIN = fakeAuth({ tokenId: "root", role: "admin" });

const open: Rig[] = [];
const make = async (...args: Parameters<typeof rig>): Promise<Rig> => {
  const r = await rig(...args);
  open.push(r);
  return r;
};

afterEach(async () => {
  while (open.length > 0) await open.pop()?.dispose();
});

const settled = (r: Rig, id: RunId) =>
  until(() => ["succeeded", "failed", "cancelled"].includes(r.runs.get(id, ADMIN).state));

const hook = (url = "https://hooks.example.com/x") => ({ url });

describe("bullet 10 — POST /v1/runs = create + prompt + settle + close", () => {
  it("creates a worker, prompts it, folds the TurnResult and closes the worker", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest(), ALICE);

    // `create` returns as soon as the worker exists and the prompt is on its way (H25's `202`).
    expect(snapshot.state).toBe("starting");
    expect(snapshot.workerId).toBe(r.workers.handles[0]?.id);
    expect(r.workers.handles[0]?.prompts).toHaveLength(1);

    await settled(r, snapshot.runId);
    const done = r.runs.get(snapshot.runId, ALICE);
    expect(done.state).toBe("succeeded");
    expect(done.result?.stopReason).toBe("end_turn");
    expect(done.result?.text).toBe("PONG");
    expect(done.turnId).toBe(done.result?.turnId);

    // ...and closed, because `keepWorker` defaults to false (DESIGN §9.3).
    await until(() => (r.workers.handles[0]?.closes.length ?? 0) === 1);
    expect(r.workers.handles[0]?.closes).toEqual(["client_request"]);
  });

  it("keeps the worker under `keepWorker: true`", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest({ keepWorker: true }), ALICE);
    await settled(r, snapshot.runId);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(r.workers.handles[0]?.closes).toEqual([]);
  });

  it("`…/events` proxies the RUN'S WORKER's log — the same envelopes, the same seqs", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest(), ALICE);
    await settled(r, snapshot.runId);

    const log = r.runs.logFor(snapshot.runId, ALICE);
    // Identity, not equivalence: a second stream writer is exactly how two `?since=`
    // implementations start disagreeing (Land exit criterion 6).
    expect(log).toBe(r.workers.handles[0]?.log);

    // M1's `?since=` semantics, unchanged: an EXCLUSIVE lower bound over the same log.
    const all = log.read(0);
    expect(all.length).toBeGreaterThan(3);
    expect(log.read(2).map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq));
    expect(log.read(all.length)).toEqual([]);
  });

  it("appends an `omni.run` envelope for every state change, on the WORKER's log", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest(), ALICE);
    await settled(r, snapshot.runId);

    const runEvents = r.runs
      .logFor(snapshot.runId, ADMIN)
      .read(0)
      .filter((e): e is Extract<EventEnvelope, { kind: "omni.run" }> => e.kind === "omni.run");
    expect(runEvents.map((e) => e.payload.state)).toEqual(["starting", "running", "succeeded"]);
    expect(runEvents.map((e) => e.payload.previous)).toEqual(["queued", "starting", "running"]);
    expect(runEvents.every((e) => e.payload.runId === snapshot.runId)).toBe(true);
    // Being ON the worker's log is what makes `?since=` cover them and `sse.ts` stay frozen.
    expect(runEvents[0]?.payloadVersion).toBe(2);
  });

  it("the run's TurnResult is deep-equal to a local `reduceTurn` of the same envelopes (D7)", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest({ keepWorker: true }), ALICE);
    await settled(r, snapshot.runId);

    const done = r.runs.get(snapshot.runId, ALICE);
    const local = reduceTurn(
      done.turnId ?? ("t_x" as never),
      r.runs.logFor(snapshot.runId, ALICE).read(0),
    );
    expect(done.result).toEqual(local);
  });

  it('a run whose worker parks reports `state:"requires_action"` and fires `run.requires_action`', async () => {
    const r = await make();
    r.workers.turns.push(neverSettles());
    const snapshot = await r.runs.create(
      runRequest({ webhook: hook(), onUnresolved: "park" }),
      ALICE,
    );
    await until(() => r.workers.handles[0] !== undefined);

    r.workers.handles[0]?.setState("requires_action");
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "requires_action");
    expect(r.events()).toContain("run.requires_action");
    // The worker-scoped twin is OPT-IN: a receiver that asked for neither gets neither, and one
    // event is not delivered under two names.
    expect(r.events()).not.toContain("worker.requires_action");

    // Answering resumes it, and the run goes back to `running` rather than staying parked.
    r.workers.handles[0]?.setState("running");
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "running");

    const handle = r.workers.handles[0];
    if (handle !== undefined) {
      idle(handle.log, handle.log.read(0)[0]?.turnId ?? ("t_1" as never));
      await handle.play();
    }
  });

  it("fires `worker.requires_action` when a target NAMES it, with no request content", async () => {
    const r = await make();
    r.workers.turns.push(neverSettles());
    const snapshot = await r.runs.create(
      runRequest({
        onUnresolved: "park",
        webhook: { url: "https://hooks.example.com/x", events: ["worker.requires_action"] },
      }),
      ALICE,
    );
    await until(() => r.workers.handles[0] !== undefined);
    r.workers.handles[0]?.setState("requires_action");
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "requires_action");

    expect(r.events()).toEqual(["worker.requires_action"]);
    const sent = r.dispatcher.sent[0];
    // The thin payload is the whole body, and none of it is a request (§24.3).
    expect(Object.keys(sent?.payload ?? {}).sort()).toEqual([
      "daemonId",
      "event",
      "runId",
      "seq",
      "sessionId",
      "ts",
      "workerId",
    ]);
    expect(sent?.payload.workerId).toBe(r.workers.handles[0]?.id);
  });

  it("stamps the configured `persistence` on the run it creates (M2-R14)", async () => {
    const r = await make({ persistence: "memory" });
    const snapshot = await r.runs.create(runRequest(), ALICE);
    // Refusing a run under the memory driver would break `OmniACP.local()`; saying nothing would
    // let `GET /v1/runs/{rid}` 404 mysteriously after a restart. The END-TO-END memory case — a
    // real memory store, a real subsystem — is `daemon/test/http/runs.test.ts`; here the claim is
    // narrower and exact: the registry reports what it was told rather than guessing.
    expect(snapshot.persistence).toBe("memory");
    await settled(r, snapshot.runId);
  });
});

describe("bullet 6 — idempotencyKey returns the ORIGINAL run, across a restart", () => {
  it("returns the same run for a repeat, and never starts a second agent", async () => {
    const r = await make();
    const first = await r.runs.create(runRequest({ idempotencyKey: "retry-key-0001" }), ALICE);
    const second = await r.runs.create(runRequest({ idempotencyKey: "retry-key-0001" }), ALICE);

    expect(second.runId).toBe(first.runId);
    // The whole point: a retry after a client timeout must not spawn a second process.
    expect(r.workers.handles).toHaveLength(1);
    await settled(r, first.runId);

    // ...and it keeps returning the ORIGINAL even once it has finished.
    const third = await r.runs.create(runRequest({ idempotencyKey: "retry-key-0001" }), ALICE);
    expect(third.runId).toBe(first.runId);
    expect(third.state).toBe("succeeded");
    expect(r.workers.handles).toHaveLength(1);
  });

  it("is scoped to the TOKEN — another token's key is another run", async () => {
    const r = await make();
    const mine = await r.runs.create(runRequest({ idempotencyKey: "shared-key-0001" }), ALICE);
    const theirs = await r.runs.create(runRequest({ idempotencyKey: "shared-key-0001" }), BOB);
    expect(theirs.runId).not.toBe(mine.runId);
    expect(r.workers.handles).toHaveLength(2);
  });

  it("survives a restart: a NEW registry over the same file answers with the old run", async () => {
    const first = await make();
    const original = await first.runs.create(
      runRequest({ idempotencyKey: "restart-key-0001" }),
      ALICE,
    );
    await settled(first, original.runId);

    // A second boot over the SAME store — a different registry, different workers, same file.
    const second = await make({ store: first.store, bootId: "boot_b" });
    const again = await second.runs.create(
      runRequest({ idempotencyKey: "restart-key-0001" }),
      ALICE,
    );
    expect(again.runId).toBe(original.runId);
    expect(again.state).toBe("succeeded");
    expect(second.workers.handles).toHaveLength(0);
  });
});

describe("bullet 9 — the SSRF gate runs at CREATE, where the operator can see it", () => {
  it('`mode:"allowlist"` with an empty `allow` is 403 AT CREATE, not at delivery', async () => {
    const r = await make({ webhooks: { enabled: true, mode: "allowlist", allow: [] } });
    await expect(r.runs.create(runRequest({ webhook: hook() }), ALICE)).rejects.toThrow(
      /webhooks\.allow is empty/,
    );
    // Nothing was spent: no worker, no run row, no delivery.
    expect(r.workers.handles).toHaveLength(0);
    expect(r.runs.list(ADMIN)).toHaveLength(0);
    expect(r.dispatcher.sent).toHaveLength(0);
  });

  it("a hostname resolving into `denyCidrs` is 403 — with 169.254.169.254, not loopback", async () => {
    // Review R16: the CIDR check is ABSOLUTE, so the fixture cannot use the loopback address every
    // other bullet's receiver lives on.
    const r = await make({
      webhooks: {
        enabled: true,
        mode: "allowlist",
        allow: ["https://rebind.example.com"],
        // The DEFAULT list, spelled out because the rig empties it for every other case — the
        // consequence §24.6 states rather than leaves to be discovered.
        denyCidrs: ["169.254.0.0/16"],
      },
      resolve: async () => await Promise.resolve(["169.254.169.254"]),
    });
    await expect(
      r.runs.create(runRequest({ webhook: hook("https://rebind.example.com/x") }), ALICE),
    ).rejects.toThrow(/169\.254\.169\.254/);
    expect(r.workers.handles).toHaveLength(0);
  });

  it("refuses a run whose delivery could never be SIGNED", async () => {
    const r = await make({ tokenSecrets: {} });
    // FAIL CLOSED: an unsigned delivery looks exactly like a signed one to a receiver that forgot
    // to check, so the run is refused rather than quietly downgraded.
    await expect(r.runs.create(runRequest({ webhook: hook() }), ALICE)).rejects.toThrow(
      /could not be signed/,
    );
    // A named operator secret is enough on its own — the token needs none.
    const withNamed = await make({
      tokenSecrets: {},
      webhooks: { enabled: true, mode: "any", denyCidrs: [], secrets: { ci: "a".repeat(32) } },
    });
    await expect(
      withNamed.runs.create(
        runRequest({ webhook: { url: "https://hooks.example.com/x", secret: "ci" } }),
        ALICE,
      ),
    ).resolves.toBeTruthy();
  });

  it("names an unknown secret rather than silently signing with something else", async () => {
    const r = await make();
    await expect(
      r.runs.create(
        runRequest({ webhook: { url: "https://hooks.example.com/x", secret: "nope" } }),
        ALICE,
      ),
    ).rejects.toThrow(/"nope" is not named in webhooks\.secrets/);
  });

  it("refuses a webhook run when the outbound surface is disabled at all", async () => {
    const r = await make({ webhooks: { enabled: false } });
    await expect(r.runs.create(runRequest({ webhook: hook() }), ALICE)).rejects.toThrow(
      /webhooks are not enabled/,
    );
    // ...but a run with NO webhook is unaffected: the gate is about the outbound surface.
    await expect(r.runs.create(runRequest(), ALICE)).resolves.toBeTruthy();
  });
});

describe("§24.4 rule 1 — the state change and the enqueue are ONE transaction", () => {
  it("a planted throw between them leaves NEITHER", async () => {
    // `cancel` is the path with no compensating catch behind it, so what the transaction did is
    // exactly what is left — which is the whole question. (`recoverRuns`' half of the same rule
    // is asserted in `recovery.test.ts`, against a planted throw in its own enqueue.)
    const r = await make();
    r.workers.turns.push(neverSettles());
    const snapshot = await r.runs.create(runRequest({ webhook: hook() }), ALICE);
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "running");

    const before = r.runs.get(snapshot.runId, ADMIN);
    r.dispatcher.failNext(new Error("planted: the enqueue failed"));
    await expect(r.runs.cancel(snapshot.runId, ALICE)).rejects.toThrow(/planted/);

    const after = r.runs.get(snapshot.runId, ADMIN);
    // NEITHER: the run did not reach `cancelled`, and no delivery exists. A run that reached a
    // terminal state with no delivery row is a webhook that will never be sent and never be
    // retried; the reverse — a delivery for a state the run never recorded — is worse.
    expect(after.state).toBe(before.state);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(r.dispatcher.sent).toHaveLength(0);
    expect(r.store.deliveries.list({ limit: 10 }).rows).toHaveLength(0);

    // ...and the very same call, without the planted failure, commits BOTH.
    await r.runs.cancel(snapshot.runId, ALICE);
    expect(r.runs.get(snapshot.runId, ADMIN).state).toBe("cancelled");
    expect(r.dispatcher.sent).toHaveLength(1);
  });

  it("commits both when nothing throws", async () => {
    const r = await make();
    const snapshot = await r.runs.create(runRequest({ webhook: hook() }), ALICE);
    await settled(r, snapshot.runId);

    expect(r.runs.get(snapshot.runId, ALICE).state).toBe("succeeded");
    expect(r.events()).toEqual(["run.completed"]);
    // The count on the snapshot moves with the enqueue, in the same transaction.
    expect(r.runs.get(snapshot.runId, ALICE).webhook).toEqual({
      url: "https://hooks.example.com/x",
      deliveries: 1,
    });
  });
});

describe("§24.4 rule 4 — the boot path abandons a foreign boot's live runs", () => {
  it("marks them `abandoned` and enqueues a REAL terminal delivery for each", async () => {
    // A run left `running` by a boot that is about to disappear. Its worker died with that boot,
    // so the run can never finish; leaving it `running` would make `GET /v1/runs/{rid}` lie for
    // as long as the row survives, and a caller waiting on a webhook would wait for ever.
    const first = await make({ realEnqueue: true });
    first.workers.turns.push(neverSettles());
    const stranded = await first.runs.create(runRequest({ webhook: hook() }), ALICE);
    await until(() => first.runs.get(stranded.runId, ALICE).state === "running");

    // A SECOND boot over the same file, exactly as a restart is.
    const second = await make({ store: first.store, bootId: "boot_b", realEnqueue: true });
    const before = second.store.deliveries.list({ limit: 50 }).rows.length;
    expect(second.runs.recover()).toEqual({ abandoned: 1 });

    const only = second.runs.get(stranded.runId, ADMIN);
    expect(only.state).toBe("abandoned");
    expect(only.error?.message).toMatch(/boot that owned this run is gone/);

    const rows = second.store.deliveries.list({ limit: 50 }).rows;
    expect(rows.length).toBe(before + 1);
    expect(rows[0]?.event).toBe("run.failed");
    expect(second.events()).toEqual(["run.failed"]);

    // A second recovery is a no-op: leaving the dead boot's id on the row would enqueue a second
    // terminal webhook for one event.
    expect(second.runs.recover()).toEqual({ abandoned: 0 });
    expect(second.store.deliveries.list({ limit: 50 }).rows).toHaveLength(before + 1);
  });

  it("the terminal delivery points at a seq that EXISTS on the run's worker log", async () => {
    // The thin payload's whole job is to be addressable: a receiver pulls `?since=seq-1`. A
    // delivery pointing at a position nobody can fetch teaches it to stop trusting the field.
    const first = await make({ realEnqueue: true });
    first.workers.turns.push(neverSettles());
    const snapshot = await first.runs.create(runRequest({ webhook: hook() }), ALICE);
    await until(() => first.runs.get(snapshot.runId, ALICE).state === "running");
    const log = first.runs.logFor(snapshot.runId, ADMIN);

    const second = await make({ store: first.store, bootId: "boot_b", realEnqueue: true });
    second.runs.recover();

    const [row] = second.store.deliveries.list({ limit: 1 }).rows;
    const delivered = second.store.deliveries.get(row?.deliveryId ?? ("dl_x" as never));
    expect(delivered?.payload.seq).toBeGreaterThan(0);
    // ...and it is the seq of a real envelope on that worker's log, persisted across the boot.
    const named = log.read(0).find((e) => e.seq === delivered?.payload.seq);
    expect(named?.kind).toBe("omni.run");
  });
});

describe("visibility, listing and cancel (D13)", () => {
  it("another token's run is `worker_not_found`, never `forbidden`", async () => {
    const r = await make();
    const mine = await r.runs.create(runRequest(), ALICE);
    // A 403 would confirm the id is real, which is the leak D13 forbids for workers and this
    // reuses verbatim.
    expect(() => r.runs.get(mine.runId, BOB)).toThrow(OmniError);
    let code = "no-throw";
    try {
      r.runs.get(mine.runId, BOB);
    } catch (e) {
      code = e instanceof OmniError ? e.code : "?";
    }
    expect(code).toBe("worker_not_found");
    // Admin sees everything.
    expect(r.runs.get(mine.runId, ADMIN).runId).toBe(mine.runId);
    await settled(r, mine.runId);
  });

  it("`list` is scoped to the token, and admin's is not", async () => {
    const r = await make();
    const a = await r.runs.create(runRequest(), ALICE);
    const b = await r.runs.create(runRequest(), BOB);
    expect(r.runs.list(ALICE).map((s) => s.runId)).toEqual([a.runId]);
    expect(r.runs.list(BOB).map((s) => s.runId)).toEqual([b.runId]);
    expect(r.runs.list(ADMIN)).toHaveLength(2);
    await settled(r, a.runId);
    await settled(r, b.runId);
  });

  it("`cancel` cancels the worker, marks the run and fires the terminal webhook once", async () => {
    const r = await make();
    r.workers.turns.push(neverSettles());
    const snapshot = await r.runs.create(runRequest({ webhook: hook() }), ALICE);
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "running");

    const cancelled = await r.runs.cancel(snapshot.runId, ALICE);
    expect(cancelled.state).toBe("cancelled");
    expect(r.workers.handles[0]?.cancels).toBe(1);
    expect(r.events()).toEqual(["run.failed"]);

    // Idempotent: a second cancel neither re-cancels nor fires a second terminal webhook.
    expect((await r.runs.cancel(snapshot.runId, ALICE)).state).toBe("cancelled");
    expect(r.events()).toEqual(["run.failed"]);

    // ...and a turn that settles afterwards does NOT overwrite the terminal state.
    const handle = r.workers.handles[0];
    if (handle !== undefined) {
      idle(handle.log, handle.log.read(0)[0]?.turnId ?? ("t_1" as never));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(r.runs.get(snapshot.runId, ALICE).state).toBe("cancelled");
    expect(r.events()).toEqual(["run.failed"]);
  });
});

describe("failures a run must survive", () => {
  it("a worker that cannot be created makes the run `failed` AND throws to the caller", async () => {
    const r = await make();
    r.workers.failNextCreate(new OmniError("worker_limit", "too many workers"));
    await expect(r.runs.create(runRequest(), ALICE)).rejects.toThrow(/too many workers/);

    const [only] = r.runs.list(ADMIN);
    // Both, because a run that never started is still a run somebody is waiting on — and the
    // caller got the real error rather than a `failed` they have to go and read.
    expect(only?.state).toBe("failed");
    expect(only?.error?.code).toBe("worker_limit");
    // No delivery: the thin payload is addressable BY `workerId`, and there is no worker.
    expect(r.dispatcher.sent).toHaveLength(0);
  });

  it("a turn that ends `refusal` is `succeeded` when the fold says so, `failed` when it does not", async () => {
    const r = await make();
    r.workers.turns.push({
      script: (log, turnId) => {
        idle(log, turnId, "refusal");
      },
    });
    const snapshot = await r.runs.create(runRequest(), ALICE);
    await settled(r, snapshot.runId);
    const done = r.runs.get(snapshot.runId, ALICE);
    // The RUN's verdict is the TURN's verdict — one fold, not two opinions (D7).
    expect(done.state).toBe(done.result?.verdict === "failed" ? "failed" : "succeeded");
    expect(done.result?.stopReason).toBe("refusal");
  });

  it("`run.maxDurationMs` is a hard ceiling that ends the run and cancels the worker", async () => {
    const r = await make({ run: { maxDurationMs: 60_000 } });
    r.workers.turns.push(neverSettles());
    const snapshot = await r.runs.create(runRequest({ webhook: hook() }), ALICE);
    await until(() => r.runs.get(snapshot.runId, ALICE).state === "running");

    r.clock.advance(60_000);
    const done = r.runs.get(snapshot.runId, ALICE);
    expect(done.state).toBe("failed");
    expect(done.error?.code).toBe("agent_timeout");
    expect(r.events()).toEqual(["run.failed"]);
    await until(() => (r.workers.handles[0]?.cancels ?? 0) === 1);
  });

  it("`maxConcurrent` refuses the run over the cap rather than queueing it silently", async () => {
    const r = await make({ run: { maxConcurrent: 1 } });
    r.workers.turns.push(neverSettles());
    const first = await r.runs.create(runRequest(), ALICE);
    await expect(r.runs.create(runRequest(), ALICE)).rejects.toThrow(/maxConcurrent/);

    // The slot comes back when the first run settles.
    const handle = r.workers.handles[0];
    if (handle !== undefined) {
      idle(
        handle.log,
        handle.log.read(0).find((e) => e.turnId !== null)?.turnId ?? ("t_1" as never),
      );
    }
    await settled(r, first.runId);
    r.workers.turns.push(endTurn());
    await expect(r.runs.create(runRequest(), ALICE)).resolves.toBeTruthy();
  });

  it("`logFor` on a run with no worker is `worker_not_found`, not an empty stream", async () => {
    const r = await make();
    r.workers.failNextCreate(new OmniError("agent_error", "spawn failed"));
    await expect(r.runs.create(runRequest(), ALICE)).rejects.toThrow();
    const [only] = r.runs.list(ADMIN);
    // An empty stream would tell a client the run produced nothing, which is a different claim.
    expect(() => r.runs.logFor(only?.runId ?? ("r_x" as RunId), ADMIN)).toThrow(/no worker yet/);
  });
});
