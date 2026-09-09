import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createDaemon } from "@omni-acp/daemon";
import type { Daemon, DaemonConfig, PolicyDecisionPayload } from "@omni-acp/protocol";
import { OmniACP, type Server } from "@omni-acp/client";
import { afterEach, describe, expect, it } from "vitest";
import { readEnvelopes, scaled, tempRoot } from "./support/harness.js";
import { fixtureAgentPath } from "@omni-acp/testkit";

/**
 * Review findings V2 / V8: a worker WOKEN after a daemon restart must enforce the policy it was
 * created with, and must refuse to wake at all when it cannot.
 *
 * The rehydrate path built its `InteractionStrategy` with `onUnresolved`, the park budgets and
 * `toSubject` — and no `decide`. So an adopted worker ran on `verdictFor`'s
 * `DEFAULT_VERDICT[onUnresolved]` fallback: no rules, no §20.5 layer-2 ceiling clamp, and a
 * snapshot that went on advertising `{sources, default, ruleCount, ceiling}` for an engine that
 * did not exist. Nothing in the suite covered policy across a restart.
 *
 * Underneath it sat a second bug the recheck found: NOT ONE of `WorkerRow`'s M2 fields was ever
 * written to disk (`worker-store.ts` had no column for them), so `onUnresolved: "park"` came back
 * as `"deny"` on the first wake and `decorate()` then wrote the degraded value back — the second
 * boot overwrote the correct value still in `snapshot_json`. Both halves are asserted here,
 * because the first fix is meaningless without the second.
 *
 * TIER 3: two real daemons over ONE `dataDir`, a real agent process, real loopback HTTP. The
 * agent is `hybrid` under `HYBRID_ASK=1` — the only fixture that implements a real resume, which
 * is what makes "what does the WOKEN worker decide" answerable at all.
 *
 * Owned by M2-B (review round 2).
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

/** A fixture whose SECOND boot may use a different config — which is the whole subject here. */
async function fixture(): Promise<{
  boot(over?: Partial<DaemonConfig>): Promise<Boot>;
  token: string;
  cwd: string;
}> {
  const cwd = await tempRoot();
  const dataDir = await tempRoot("omni-acp-data-");
  const sessionDir = await tempRoot("omni-acp-sessions-");
  dirs.push(cwd, dataDir, sessionDir);
  const token = randomBytes(32).toString("hex");

  const base: DaemonConfig = {
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
    eventLog: { driver: "sqlite" },
    hibernate: { idleMs: 600_000 },
    tokens: [{ id: "local", secret: token, role: "admin", cwdRoots: [cwd], maxWorkers: 8 }],
    policy: {
      presets: {
        // The operator's own preset. Boot 2 can drop it, which is §23.1's "a preset that vanished
        // from config between hibernate and wake".
        "notes-only": { default: "allow" },
      },
    },
    agents: [
      {
        id: "hybrid",
        command: process.execPath,
        args: [fixtureAgentPath("hybrid")],
        env: { HYBRID_ASK: "1", HYBRID_SESSION_DIR: sessionDir },
      },
    ],
  };

  return {
    token,
    cwd,
    async boot(over?: Partial<DaemonConfig>): Promise<Boot> {
      await live?.stop({ graceful: true });
      const daemon = await createDaemon({ ...base, ...over });
      await daemon.start();
      live = daemon;
      const url = daemon.url ?? "";
      return { daemon, url, server: await OmniACP.connect({ url, token }) };
    },
  };
}

/** Every `omni.policy_decision` this worker has recorded, oldest first. */
async function decisions(
  boot: Boot,
  token: string,
  workerId: string,
): Promise<PolicyDecisionPayload[]> {
  const envelopes = await readEnvelopes(boot.url, token, workerId, { quietMs: scaled(250) });
  return envelopes
    .filter((e) => e.kind === "omni.policy_decision")
    .map((e) => e.payload as PolicyDecisionPayload);
}

describe("a worker WOKEN after a restart still enforces its policy (review V2/V8)", () => {
  it("decides by the ENGINE, not by DEFAULT_VERDICT[onUnresolved]", async () => {
    const f = await fixture();
    const first = await f.boot();
    // `default: "allow"` with `onUnresolved: "deny"` makes the two answers VISIBLY different:
    // the engine allows, the fallback denies. Before the fix the woken worker denied — a policy
    // written to permit an action stopped permitting it, silently, on a restart.
    const worker = await first.server.createAgent("hybrid", {
      cwd: f.cwd,
      idleTimeoutMs: 0,
      policy: { presets: ["notes-only"] },
      onUnresolved: "deny",
    });
    await worker.prompt("before");
    const before = await decisions(first, f.token, worker.id);
    expect(before).toHaveLength(1);
    expect(before[0]?.decision).toBe("allow");
    expect(before[0]?.by).toBe("policy");
    expect(before[0]?.rule).not.toBe("m2:onUnresolved");
    await worker.hibernate();

    const second = await f.boot();
    const woken = await second.server.attach(worker.id);
    await woken.prompt("after");

    const after = await decisions(second, f.token, worker.id);
    expect(after.length).toBeGreaterThanOrEqual(2);
    const last = after[after.length - 1];
    // The REGRESSION, stated: before the fix this row read
    // `{"decision":"deny","rule":"m2:onUnresolved","ruleSource":"default"}` — DEFAULT_VERDICT's
    // fallback, with no rules and no `clampVerdict` anywhere behind it.
    expect(last?.decision).toBe("allow");
    expect(last?.by).toBe("policy");
    expect(last?.rule).not.toBe("m2:onUnresolved");
    expect(last?.rule).toBe(before[0]?.rule);

    // …and the SNAPSHOT is honest about the engine it now actually has.
    const snapshot = (await second.server.attach(worker.id)).snapshot;
    expect(snapshot.policy?.sources).toContain("notes-only");
    expect(snapshot.policy?.default).toBe("allow");
  });

  it("keeps every M2 row of the persisted worker across the restart", async () => {
    const f = await fixture();
    const first = await f.boot();
    const worker = await first.server.createAgent("hybrid", {
      cwd: f.cwd,
      idleTimeoutMs: 0,
      onUnresolved: "park",
      parkTimeoutMs: 60_000,
      parkTimeoutAction: "fail",
      patch: "off",
    });
    expect(worker.snapshot.onUnresolved).toBe("park");
    await worker.hibernate();

    const second = await f.boot();
    const adopted = (await second.server.attach(worker.id)).snapshot;
    // NONE of these survived before the fix: `worker-store.ts` wrote no column for them, so the
    // wake read `M1_VIEW` and F28's "the park never happens again" happened on the first restart.
    expect(adopted.onUnresolved).toBe("park");
    expect(adopted.parkTimeoutMs).toBe(60_000);
    expect(adopted.parkTimeoutAction).toBe("fail");
    expect(adopted.patchMode).toBe("off");

    // …and a THIRD boot still reads them, which is the half `decorate()` used to destroy: the
    // degraded value was written back into `snapshot_json` and overwrote the correct one.
    const third = await f.boot();
    expect((await third.server.attach(worker.id)).snapshot.onUnresolved).toBe("park");
  });

  it("refuses the wake with acl_revoked when the worker's preset has vanished (§23.1)", async () => {
    const f = await fixture();
    const first = await f.boot();
    const worker = await first.server.createAgent("hybrid", {
      cwd: f.cwd,
      idleTimeoutMs: 0,
      policy: { presets: ["notes-only"] },
      onUnresolved: "deny",
    });
    await worker.prompt("before");
    await worker.hibernate();

    // The operator removed the preset between boots. Waking unenforced is the one answer §23.1
    // forbids, so the wake is refused and the worker is closed rather than degraded.
    const second = await f.boot({ policy: { presets: {} } });
    const adopted = await second.server.attach(worker.id);
    await expect(adopted.prompt("after")).rejects.toMatchObject({ code: "forbidden" });

    const snapshot = (await second.server.attach(worker.id)).snapshot;
    expect(snapshot.state).toBe("closed");
    expect(snapshot.closeReason).toBe("acl_revoked");
  });
});
