import { realpath } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type AuthContext,
  type ClientId,
  type PolicySubject,
  type ResolvedDaemonConfig,
  type TokenId,
  type WorkerRow,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { fakeClock, fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createTokenStore } from "../src/auth.js";
import { createCatalog } from "../src/catalog.js";
import { resolvePolicyForRequest } from "../src/policy/resolve.js";
import { createWorkerRegistry } from "../src/registry.js";
import { coreScript, someWorkerId } from "./fake-core.js";
import { fakePersistence } from "./fake-persistence.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

/**
 * What the WAKE path builds, read off the deps `createRehydratedWorker` was actually handed.
 *
 * Review findings V2/V8 and V3 all live in one block of `registry.ts` and NONE of them is visible
 * from the handle: the strategy was built with no `decide`, the session was reopened with no
 * `mcpServers`, and the containment gate was bound to the RAW `cwdRoots` off the config rather
 * than to the resolved `AuthContext` list the create path uses. So this file asserts against the
 * arguments rather than against an outcome, which is also what makes each assertion point at the
 * one line that produces it.
 *
 * `restart-policy.itest.ts` is the same three findings end to end, over two real daemons.
 *
 * Owned by M2-B (review round 2).
 */

const DAEMON_ID = `d_${"0".repeat(25)}1`;
const CURRENT_BOOT = "boot_fake_current";
const clock = fakeClock();

let root: string;
let inside: string;

beforeEach(async () => {
  coreScript.reset();
  root = await realpath(await mkdtemp(join(tmpdir(), "omni-wake-")));
  inside = join(root, "inside.txt");
  await writeFile(inside, "INSIDE\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

/**
 * A config whose token declares NO `cwdRoots`.
 *
 * That is the common case and the one review finding V3 is about: `[]` means `homedir()`, and
 * only `auth.ts` knows it. The raw config array and the resolved `AuthContext` list are different
 * values, which is what makes "which one did the wake path bind the gate to" an observable
 * question rather than a stylistic one.
 */
function config(over?: Record<string, unknown>): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [{ id: "t", secretSha256: "a".repeat(64), policyPresets: "*", mcpPresets: ["notes"] }],
    agents: [{ id: "claude", command: process.execPath, args: ["-e", "0"] }],
    policy: { presets: { "notes-only": { default: "allow", alertOnUnpoliced: ["execute"] } } },
    mcpServers: { notes: { command: process.execPath, args: ["-e", "0"] } },
    ...over,
  } as Parameters<typeof DaemonConfig.parse>[0]) as ResolvedDaemonConfig;
}

function row(o?: Partial<WorkerRow>): WorkerRow {
  const workerId = someWorkerId(50);
  const snapshot = {
    workerId,
    daemonId: DAEMON_ID,
    ref: `${DAEMON_ID}:${workerId}`,
    sessionId: "sess-persisted",
    agentId: "claude",
    state: "hibernated",
    cwd: root,
    label: null,
    ownerTokenId: "t",
    createdAt: "2026-09-03T22:00:00.000Z",
    updatedAt: "2026-09-03T23:00:00.000Z",
    headSeq: 12,
    currentTurnId: null,
    capabilities: null,
    process: null,
    closeReason: null,
    lease: { workerId, holder: null, epoch: 1, expiresAt: null, acquiredAt: null, pinned: false },
    hibernatedAt: "2026-09-03T23:00:00.000Z",
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "claude@abcdef012345",
    persistence: "durable",
  } as unknown as WorkerSnapshot;
  return {
    snapshot,
    agentId: "claude",
    bootId: CURRENT_BOOT,
    closeResult: null,
    lastActiveMs: 1_000,
    closedAtMs: null,
    hibernateIdleMs: 1_800_000,
    // The M2 rows a boot writes and a wake has to reproduce (§5.8.8).
    onUnresolved: "deny",
    parkTimeoutMs: null,
    parkTimeoutAction: "deny",
    mcpNames: [],
    policyRef: null,
    policy: null,
    env: null,
    patchMode: "on_write",
    ...o,
  };
}

interface Rig {
  readonly interactionDeps: { current: Record<string, unknown> | null };
  /** Seeds the row and rehydrates it, exactly as `GET /v1/workers/{wid}` does. */
  wake(r: WorkerRow): void;
  /** `POST …/wake`, so §23.1's refusal is reachable. */
  resume(r: WorkerRow): Promise<unknown>;
}

function rig(resolved: ResolvedDaemonConfig = config()): Rig {
  const tokens = createTokenStore(resolved);
  const interactionDeps: { current: Record<string, unknown> | null } = { current: null };
  const store = fakePersistence({ bootId: CURRENT_BOOT });
  const workers = createWorkerRegistry({
    daemonId: DAEMON_ID as never,
    config: resolved,
    catalog: createCatalog(resolved),
    supervisor: fakeSupervisor(),
    responder: { decide: () => ({ response: null, record: {} as never }) },
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    persistence: store,
    tokens,
    policyFor: (sel, ctx, onUnresolved) =>
      resolvePolicyForRequest(resolved, ctx, sel, { onUnresolved }),
    interactions: (d) => {
      interactionDeps.current = d as unknown as Record<string, unknown>;
      return {
        clientCapabilities: {},
        permission: () => Promise.reject(new Error("unused")),
        elicitation: () => Promise.reject(new Error("unused")),
        answer: () => {
          throw new Error("unused");
        },
        get: () => null,
        pending: [],
        settleAll: () => Promise.resolve(),
        close: () => {},
      };
    },
  });
  return {
    interactionDeps,
    wake(r: WorkerRow): void {
      store.seed(r);
      workers.get(r.snapshot.workerId, adminAuth(tokens));
    },
    resume(r: WorkerRow): Promise<unknown> {
      return workers.wake(r.snapshot.workerId, adminAuth(tokens));
    },
  };
}

function adminAuth(tokens: ReturnType<typeof createTokenStore>): AuthContext {
  const base = tokens.contextFor("t" as TokenId, null as ClientId | null);
  // D13's visibility only; everything else is the REAL context, because the roots it resolves are
  // the whole subject below.
  return { ...base, role: "admin", canSee: () => true } as AuthContext;
}

const link = (path: string) => ({
  type: "resource_link",
  uri: pathToFileURL(path).href,
  name: "n",
});

const lastDeps = (): Record<string, unknown> => {
  const entry = coreScript.rehydrated.at(-1);
  if (entry === undefined) throw new Error("nothing was rehydrated");
  return entry.deps as unknown as Record<string, unknown>;
};

describe("the WAKE path reproduces create()'s environment (review findings V2/V8, V3)", () => {
  it("rebuilds the POLICY ENGINE from the persisted selection and threads `decide` in", () => {
    const r = rig();
    r.wake(row({ policy: { presets: ["notes-only"] }, policyRef: "notes-only" }));
    // The one missing line: without it the strategy falls to `DEFAULT_VERDICT[onUnresolved]`,
    // which has no rules and no `clampVerdict` at all.
    const decide = r.interactionDeps.current?.["decide"];
    expect(typeof decide).toBe("function");
    const verdict = (decide as (s: PolicySubject) => { action: string; rule: string })({
      method: "session/request_permission",
      type: "tool_call",
      kind: "edit",
      paths: [inside],
      cwd: root,
      agentId: "claude",
    } as unknown as PolicySubject);
    expect(verdict.action).toBe("allow");
    expect(verdict.rule).not.toBe("m2:onUnresolved");
  });

  it("re-resolves the worker's MCP presets, so a woken session is not reopened with []", () => {
    const r = rig();
    r.wake(row({ mcpNames: ["notes"] }));
    expect(lastDeps()["mcpServers"]).toHaveLength(1);
  });

  it("threads §20.6's watch list through, so `unpoliced_tool_call` survives a restart", () => {
    const r = rig();
    r.wake(row({ policy: { presets: ["notes-only"] } }));
    expect(lastDeps()["alertOnUnpoliced"]).toEqual(["execute"]);
  });

  it("wires the containment gate at all, and it ACCEPTS an in-root link — the control", async () => {
    // With the roots spelled out, the raw config array and the resolved list are the same value,
    // so this passes either way. It is here so the two assertions below are read as being about
    // WHICH list the gate got, and not about whether there is a gate.
    const resolved = config({
      tokens: [{ id: "t", secretSha256: "a".repeat(64), cwdRoots: [root], mcpPresets: ["notes"] }],
    });
    const r = rig(resolved);
    r.wake(row());
    const validate = lastDeps()["validateContent"] as (c: readonly unknown[]) => Promise<void>;
    await expect(validate([link(inside)])).resolves.toBeUndefined();
  });

  it("binds it to the RESOLVED cwdRoots, so `cwdRoots: []` is homedir() and not nothing", async () => {
    // Review finding V3, and the discriminator is the MESSAGE. `TokenConfig.cwdRoots` is
    // `z.array(z.string()).default([])` and `[]` MEANS `homedir()` — a fact that lives in
    // `auth.ts` and nowhere else. Reading the raw config array gave the wake path `[]`, and
    // `assertPromptContent` refused with "no cwdRoots": `500 internal` on every path-bearing
    // prompt block, after a restart and only then, for a worker whose create path was fine.
    //
    // Both spellings fail CLOSED for a cwd outside homedir(), which is why the message is what
    // separates them: "no cwdRoots" is a MIS-BOUND gate, "cwd is outside cwdRoots" is a gate that
    // is correctly bound to a root this worker is not under.
    const r = rig();
    // Windows tmpdir is INSIDE homedir; its parent is outside on every supported runner.
    const persisted = row({ snapshot: { ...row().snapshot, cwd: resolve(homedir(), "..") } });
    r.wake(persisted);
    const validate = lastDeps()["validateContent"] as (c: readonly unknown[]) => Promise<void>;
    const thrown = await validate([link(inside)]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).message).toBe(
      "prompt containment is mis-bound: cwd is outside cwdRoots",
    );
  });

  it("…and the two spellings really do differ: `cwdRoots: []` resolves to the home directory", () => {
    // The premise of the test above, pinned separately so it cannot rot into a tautology. If
    // `[]` ever stopped meaning `homedir()`, the finding would change shape and this says so.
    const tokens = createTokenStore(config());
    expect(config().tokens[0]?.cwdRoots).toEqual([]);
    expect(tokens.contextFor("t" as TokenId, null).cwdRoots).not.toEqual([]);
  });

  it("REFUSES the wake when the worker's preset has vanished, rather than waking it unenforced", async () => {
    const r = rig(config({ policy: { presets: {} } }));
    const persisted = row({ policy: { presets: ["notes-only"] } });
    r.wake(persisted);
    // No engine, so no `decide` — and §23.1 says that has to be a refusal and not a degradation:
    // "a preset that vanished from config between hibernate and wake ⇒ acl_revoked".
    expect(r.interactionDeps.current?.["decide"]).toBeUndefined();
    const thrown = await r.resume(persisted).then(
      () => null,
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("forbidden");
  });
});
