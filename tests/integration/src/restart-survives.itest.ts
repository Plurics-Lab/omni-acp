import { rm } from "node:fs/promises";
import { createDaemon } from "@omni-acp/daemon";
import type { CloseResult, Daemon, DaemonConfig } from "@omni-acp/protocol";
import { OmniACP, type Server } from "@omni-acp/client";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureAgent, readEnvelopes, scaled, tempRoot, until } from "./support/harness.js";

/**
 * DESIGN §11's M1 acceptance, half one: **reconnect loses no events**, across a daemon RESTART
 * (M1-PLAN §2, WP-F 7).
 *
 * prompt -> `stop()` -> `createDaemon()` on the same `dataDir` -> `?since=<mid>` returns the
 * exact tail with the SAME `seq`. The `seq` half is the one that matters and is the one §14.4
 * calls the most dangerous line in M1: a worker whose rows retention already evicted must not
 * restart its own sequence at 1.
 *
 * The harness in `support/` builds ONE daemon and disposes it; this file needs two over one
 * `dataDir`, so it composes its own.
 *
 * Owned by M1-WP-F.
 */

interface Boot {
  readonly daemon: Daemon;
  readonly url: string;
  readonly server: Server;
}

const dirs: string[] = [];
let live: Daemon | null = null;

afterEach(async () => {
  await live?.stop({ graceful: true }).catch(() => {});
  live = null;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function fixture(o?: { maxPersisted?: number; ring?: number }): Promise<{
  boot(): Promise<Boot>;
  token: string;
  cwd: string;
}> {
  const cwd = await tempRoot();
  const dataDir = await tempRoot("omni-acp-data-");
  dirs.push(cwd, dataDir);
  const token = randomBytes(32).toString("hex");

  const config: DaemonConfig = {
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
    // The whole subject of this file. `memory` would make every assertion here vacuous.
    eventLog: {
      driver: "sqlite",
      ...(o?.ring === undefined ? {} : { maxEventsPerWorker: o.ring }),
      ...(o?.maxPersisted === undefined ? {} : { maxPersistedEventsPerWorker: o.maxPersisted }),
    },
    hibernate: { idleMs: 600_000 },
    tokens: [{ id: "local", secret: token, role: "admin", cwdRoots: [cwd], maxWorkers: 8 }],
    agents: [fixtureAgent("hybrid", "hybrid"), fixtureAgent("echo", "echo")],
  };

  return {
    token,
    cwd,
    async boot(): Promise<Boot> {
      await live?.stop({ graceful: true });
      const daemon = await createDaemon(config);
      await daemon.start();
      live = daemon;
      const url = daemon.url ?? "";
      return { daemon, url, server: await OmniACP.connect({ url, token }) };
    },
  };
}

describe("a daemon restart, over the same dataDir", () => {
  it("?since=<mid> returns the exact tail with the SAME seq after stop() + createDaemon()", async () => {
    const f = await fixture();
    const first = await f.boot();
    const worker = await first.server.createAgent("echo", { cwd: f.cwd });
    await worker.prompt("one");
    await worker.prompt("two");
    const before = await readEnvelopes(first.url, f.token, worker.id, { quietMs: scaled(200) });
    expect(before.length).toBeGreaterThan(6);
    const mid = before[Math.floor(before.length / 2)]?.seq ?? 1;

    const second = await f.boot();
    const after = await readEnvelopes(second.url, f.token, worker.id, {
      since: mid,
      quietMs: scaled(200),
    });

    const expected = before.filter((e) => e.seq > mid);
    // The SAME envelopes, at the SAME seq, from a daemon that has never seen this worker run.
    // A PREFIX, because `before` was necessarily read while the first daemon was still up: its
    // graceful shutdown then closed the worker and appended one more envelope, which the restart
    // legitimately serves. That envelope is asserted separately rather than trimmed away.
    // Deep equality, not `JSON.stringify`: the same envelope comes back from the ring on one boot
    // and from the store on the other, and the two serialisers order KEYS differently. The
    // envelope is the contract; the key order is not, and asserting on it would be asserting on
    // which side of the ring/disk boundary a read happened to come from.
    expect(after.length).toBeGreaterThanOrEqual(expected.length);
    expect(after.slice(0, expected.length)).toEqual(expected);
    for (const extra of after.slice(expected.length)) {
      expect(extra.seq).toBeGreaterThan(before[before.length - 1]?.seq ?? 0);
      expect(extra.kind).toBe("omni.worker_state");
      expect(extra.kind === "omni.worker_state" && extra.payload.reason).toBe("daemon_shutdown");
    }
  });

  it("a worker whose rows were fully evicted does NOT restart its seq at 1 (§14.4, L15)", async () => {
    // Ruling M1-R2, and the regression this file exists for: `head = max(seq)` alone resets to 0
    // after a TOTAL eviction and restarts one worker's sequence at 1 — which silently merges two
    // different envelopes under one id for every client holding a cursor.
    // The worker is HIBERNATED rather than left running, for a reason that is itself part of
    // §15.2: a graceful `stop()` closes every worker that owns a process, and a closed worker
    // cannot be prompted — so it could never demonstrate that the NEXT append continues the
    // sequence. A hibernated one survives the restart and wakes, which is the only shape in
    // which "does not restart at 1" is observable with a real append rather than a snapshot.
    const f = await fixture({ maxPersisted: 1, ring: 2 });
    const first = await f.boot();
    const worker = await first.server.createAgent("hybrid", { cwd: f.cwd, idleTimeoutMs: 0 });
    await worker.prompt("one");
    await worker.hibernate();
    const head = (await first.server.attach(worker.id)).snapshot.headSeq;
    // The ring holds 2 and the durable cap is 1, so `head` is emphatically NOT derivable from
    // what is still stored: it has to come from the persisted `head_seq` (ruling M1-R2).
    expect(head).toBeGreaterThan(6);

    const second = await f.boot();
    const reattached = await second.server.attach(worker.id);
    expect(reattached.snapshot.headSeq).toBeGreaterThanOrEqual(head);

    const result = await reattached.prompt("two");
    const after = await readEnvelopes(second.url, f.token, worker.id, {
      since: head,
      quietMs: scaled(200),
    });
    expect(after.length).toBeGreaterThan(0);
    // The regression, stated: with `head = max(seq)` alone this array starts at 1 and every
    // client holding a cursor silently merges two different envelopes under one id.
    for (const envelope of after) expect(envelope.seq).toBeGreaterThan(head);
    expect(result.stopReason).toBe("end_turn");
  });

  it("a hibernated worker is adopted with `generation` preserved", async () => {
    const f = await fixture();
    const first = await f.boot();
    const worker = await first.server.createAgent("hybrid", { cwd: f.cwd, idleTimeoutMs: 0 });
    await worker.prompt("remember this");
    await worker.hibernate();
    const before = (await first.server.attach(worker.id)).snapshot;
    expect(before.state).toBe("hibernated");
    expect(before.generation).toBe(1);

    const second = await f.boot();
    const adopted = (await second.server.attach(worker.id)).snapshot;

    // §15.7: a hibernated row owned NO process, so the new boot has nothing to orphan and
    // nothing to reconcile — it is adopted exactly as it was left.
    expect(adopted.state).toBe("hibernated");
    expect(adopted.generation).toBe(before.generation);
    expect(adopted.sessionId).toBe(before.sessionId);
    expect(adopted.hibernatedAt).toBe(before.hibernatedAt);
    expect(second.daemon.info.orphansAtStart).toEqual({ found: 0, reaped: 0, skipped: 0 });

    // And it still wakes, from a process that was started by a different boot.
    const woken = await second.server.attach(worker.id);
    await woken.prompt("what did I say");
    const snapshot = (await second.server.attach(worker.id)).snapshot;
    expect(snapshot.state).toBe("ready");
    expect(snapshot.generation).toBe(2);
    expect(snapshot.resume?.outcome).toBe("landed");
  });

  it("DELETE on a worker this process never created returns the PERSISTED CloseResult byte-for-byte, never a recomputed treeGone (§15.6)", async () => {
    const f = await fixture();
    const first = await f.boot();
    const worker = await first.server.createAgent("echo", { cwd: f.cwd });
    await worker.prompt("one");
    const original: CloseResult = await worker.close();

    const second = await f.boot();
    const reattached = await second.server.attach(worker.id);
    const replayed = await reattached.close();

    // BYTE for byte. Recomputing would report `treeGone: true` for a tree this process never saw
    // and can never have proved gone — exactly the optimism §6.6 forbids — and it is why §14.8
    // insists a rehydrated worker is the SAME class rather than a second implementation.
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(original));

    // Idempotent a third time, from the same boot.
    expect(JSON.stringify(await reattached.close())).toBe(JSON.stringify(original));
  });

  it("the restarted daemon reports its persistence honestly", async () => {
    const f = await fixture();
    const first = await f.boot();
    await first.server.createAgent("echo", { cwd: f.cwd });
    const firstBoot = first.daemon.info.bootId;

    const second = await f.boot();
    // §14.9 / H21: an operator must be able to read this BEFORE anything goes wrong, and a
    // `bootId` that did not change would make "which boot wrote this" unanswerable.
    expect(second.daemon.info.persistence.driver).toBe("sqlite");
    expect(second.daemon.info.persistence.sizeBytes).toBeGreaterThan(0);
    expect(second.daemon.info.persistence.writeFailures).toBe(0);
    expect(second.daemon.info.bootId).not.toBe(firstBoot);
    expect(second.daemon.info.canonicalPayloadVersion).toBe(2);
  });
});
