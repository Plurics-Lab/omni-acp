import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type CreateWorkerRequest,
  type EventEnvelope,
  type ResolvedDaemonConfig,
  type TurnId,
  type WorkerId,
} from "@omni-acp/protocol";
import {
  fakeClock,
  fakeSupervisor,
  nullLogger,
  seqIds,
  type FakeSupervisor,
} from "@omni-acp/testkit";
import { createTokenStore } from "../src/auth.js";
import { createCatalog } from "../src/catalog.js";
import { createWorkerRegistry } from "../src/registry.js";
import type { AuthContext, WorkerRegistry } from "../src/types.js";
import { coreScript, normalizerOptions, someWorkerId } from "./fake-core.js";
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

/** ~800 leaked `/tmp` directories per full run without this; see `support/temp-dirs.ts`. */
afterEach(async () => {
  await removeTempRoots();
});

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const DAEMON_ID = `d_${"0".repeat(25)}1` as const;
const USER_SECRET = "user-secret-0123456789abc";
const OTHER_SECRET = "other-secret-0123456789abc";
const ADMIN_SECRET = "admin-secret-0123456789abc";

let root: string;

interface Harness {
  readonly registry: WorkerRegistry;
  readonly supervisor: FakeSupervisor;
  readonly config: ResolvedDaemonConfig;
  readonly user: AuthContext;
  readonly other: AuthContext;
  readonly admin: AuthContext;
  readonly envelopes: { workerId: string; envelope: EventEnvelope }[];
}

async function harness(over?: {
  maxWorkers?: number;
  tokenMaxWorkers?: number;
  agents?: unknown[];
}): Promise<Harness> {
  root = await tempRoot("omni-reg-");
  const config = DaemonConfig.parse({
    dataDir: root,
    maxWorkers: over?.maxWorkers ?? 64,
    tokens: [
      {
        id: "user",
        secret: USER_SECRET,
        cwdRoots: [root],
        maxWorkers: over?.tokenMaxWorkers ?? 16,
      },
      { id: "other", secret: OTHER_SECRET, cwdRoots: [root] },
      { id: "admin", secret: ADMIN_SECRET, role: "admin", cwdRoots: [root] },
    ],
    agents: over?.agents ?? [
      { id: "example", command: process.execPath, args: ["agent.js"], env: { A: "1" } },
      { id: "second", command: process.execPath },
    ],
  } as Parameters<typeof DaemonConfig.parse>[0]);

  const tokens = createTokenStore(config);
  const supervisor = fakeSupervisor();
  const envelopes: { workerId: string; envelope: EventEnvelope }[] = [];

  const catalog = createCatalog(config);
  const registry = createWorkerRegistry({
    daemonId: DAEMON_ID,
    config,
    catalog,
    supervisor,
    responder: { decide: () => ({ response: null, record: {} as never }) },
    clock: fakeClock(),
    ids: seqIds(),
    logger: nullLogger(),
    onEnvelope: (workerId, envelope) => {
      envelopes.push({ workerId, envelope: envelope as EventEnvelope });
    },
  });

  return {
    registry,
    supervisor,
    catalog,
    config,
    user: tokens.contextFor("user", "cli"),
    other: tokens.contextFor("other"),
    admin: tokens.contextFor("admin"),
    envelopes,
  };
}

const request = (over?: Partial<CreateWorkerRequest>): CreateWorkerRequest => ({
  agent: "example",
  cwd: root,
  ...over,
});

beforeEach(() => {
  coreScript.reset();
});

describe("WorkerRegistry.create (H5, H14)", () => {
  it("spawns through the injected Supervisor with the catalog's complete env", async () => {
    const h = await harness();
    const handle = await h.registry.create(request({ label: "one" }), h.user);

    expect(h.supervisor.spawnCalls).toHaveLength(1);
    const spec = h.supervisor.spawnCalls[0];
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.cwd).toBe(root);
    expect(spec?.env["A"]).toBe("1");
    expect(spec?.env["PATH"]).toBe(process.env["PATH"]);

    const snapshot = handle.snapshot();
    expect(snapshot.state).toBe("ready");
    expect(snapshot.ownerTokenId).toBe("user");
    expect(snapshot.label).toBe("one");
    expect(snapshot.daemonId).toBe(DAEMON_ID);
    expect(h.registry.size).toBe(1);
  });

  it("passes the REALPATH'd cwd to the worker, not the string the client sent", async () => {
    const h = await harness();
    const handle = await h.registry.create(request({ cwd: join(root, ".", "") }), h.user);
    expect(handle.snapshot().cwd).toBe(root);
  });

  it("builds the Normalizer with the descriptor, the cwd and a LAZY modes thunk (§12.3 row 11)", async () => {
    normalizerOptions.length = 0;
    const h = await harness();
    const handle = await h.registry.create(request({ cwd: join(root, ".", "") }), h.user);

    expect(normalizerOptions).toHaveLength(1);
    const o = normalizerOptions[0]!;
    // The RESOLVED quirk table (§17.2). Without it the map runs against `DEFAULT_V1_PROFILE`,
    // reads no vendor extension, and every agent looks like a generic v1 one.
    expect(o["descriptor"]).toEqual(h.catalog.descriptor("example"));
    // §12.5: the realpath'd cwd, so a reconstructed vendor patch names paths `git apply` takes.
    expect(o["cwd"]).toBe(root);

    // LAZY, and that is the whole point: the catalogue only exists after `session/new`, which is
    // after this options object was built. A thunk that had captured a value would be null here
    // forever, and row 11 would emit `options: []` for the life of every worker.
    const modes = o["modes"] as () => Record<string, unknown> | null;
    expect(typeof modes).toBe("function");
    expect(modes()).toEqual(handle.snapshot().capabilities?.modes);
    expect(modes()).not.toBeNull();
    expect((modes() as { availableModes?: unknown[] }).availableModes).toHaveLength(2);
  });

  it("rejects an unknown agent with 400 and a bad cwd with 403 — and spawns nothing", async () => {
    const h = await harness();
    await expect(h.registry.create(request({ agent: "nope" }), h.user)).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
    await expect(h.registry.create(request({ cwd: tmpdir() }), h.user)).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    expect(h.supervisor.spawnCalls).toHaveLength(0);
    expect(h.registry.size).toBe(0);
  });

  it("checks the agent ALLOWLIST before the catalog, so a token learns nothing about unknown agents", async () => {
    const h = await harness();
    const config = h.config;
    config.tokens = config.tokens.map((t) => (t.id === "user" ? { ...t, agents: ["second"] } : t));
    const scoped = createTokenStore(config).contextFor("user");
    await expect(h.registry.create(request({ agent: "ghost" }), scoped)).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rejects a malformed request body the same way for an in-process caller (D15)", async () => {
    const h = await harness();
    // M2 OPENS `mcp`, `onUnresolved` and `env` (§5.8.6), so what is still refused here is what a
    // client may never express AT ALL: a missing `cwd`, an unknown key, a value outside an enum,
    // and — the load-bearing one — an MCP entry that is anything but a preset NAME (DESIGN §8's
    // 🔴, enforced by the TYPE rather than by a validator somebody could move).
    const bad: unknown[] = [
      { agent: "example" },
      { agent: "example", cwd: root, mcp: [{ command: "npx", args: ["-y", "server"] }] },
      { agent: "example", cwd: root, onUnresolved: "allow" },
      { agent: "example", cwd: root, parkTimeoutAction: "allow" },
      { agent: "example", cwd: root, nope: 1 },
      { agent: "example", cwd: root, timeoutMs: 10 },
    ];
    for (const body of bad) {
      await expect(h.registry.create(body as CreateWorkerRequest, h.user)).rejects.toMatchObject({
        code: "bad_request",
        status: 400,
      });
    }
  });

  it("propagates a handshake JSON-RPC failure as 502 and reclaims the tree (H5)", async () => {
    const h = await harness();
    coreScript.handshake = "jsonrpc_error";
    await expect(h.registry.create(request(), h.user)).rejects.toMatchObject({
      code: "agent_error",
      status: 502,
    });
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
    expect(h.supervisor.live.size).toBe(0);
    // The failed worker holds no slot and is not addressable.
    expect(h.registry.size).toBe(0);
    expect(h.registry.list(h.admin)).toEqual([]);
  });

  it("propagates a handshake timeout as 504 and reclaims the tree (H5)", async () => {
    const h = await harness();
    coreScript.handshake = "timeout";
    await expect(h.registry.create(request(), h.user)).rejects.toMatchObject({
      code: "agent_timeout",
      status: 504,
    });
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
    expect(h.registry.size).toBe(0);
  });

  it("maps an unclassified spawn failure to agent_error, never to internal", async () => {
    const h = await harness();
    h.supervisor.enqueue({ failWith: new Error("spawn ENOENT") });
    await expect(h.registry.create(request(), h.user)).rejects.toMatchObject({
      code: "agent_error",
      status: 502,
    });
  });

  it("feeds every appended envelope to the daemon's listener, from seq 1", async () => {
    const h = await harness();
    await h.registry.create(request(), h.user);
    expect(h.envelopes.map((e) => e.envelope.seq)).toEqual([1, 2]);
    expect(h.envelopes[0]?.envelope.kind).toBe("omni.worker_state");
    expect(h.envelopes[0]?.envelope.payload).toMatchObject({ state: "starting" });
    // Even for a worker that never becomes ready — a failed handshake is exactly when an
    // operator needs the events.
    coreScript.handshake = "jsonrpc_error";
    await expect(h.registry.create(request(), h.user)).rejects.toThrow();
    expect(h.envelopes.some((e) => e.envelope.kind === "omni.error")).toBe(true);
  });
});

describe("WorkerRegistry limits (H14, acceptance 7)", () => {
  it("enforces the PER-TOKEN limit with 429", async () => {
    const h = await harness({ tokenMaxWorkers: 2 });
    await h.registry.create(request(), h.user);
    await h.registry.create(request(), h.user);
    await expect(h.registry.create(request(), h.user)).rejects.toMatchObject({
      code: "worker_limit",
      status: 429,
    });
    // Another token is unaffected by the first one's quota.
    await expect(h.registry.create(request(), h.other)).resolves.toBeDefined();
  });

  it("enforces the GLOBAL limit with 429", async () => {
    const h = await harness({ maxWorkers: 2 });
    await h.registry.create(request(), h.user);
    await h.registry.create(request(), h.other);
    await expect(h.registry.create(request(), h.admin)).rejects.toMatchObject({
      code: "worker_limit",
    });
  });

  it("is a SYNCHRONOUS check-and-set: 20 concurrent creates cannot overshoot", async () => {
    const h = await harness({ maxWorkers: 3, tokenMaxWorkers: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => h.registry.create(request(), h.user)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(h.supervisor.spawnCalls).toHaveLength(3);
    expect(h.registry.size).toBe(3);
  });

  it("gives the slot back on a normal close AND on a crash-close", async () => {
    const h = await harness({ tokenMaxWorkers: 1 });
    const first = await h.registry.create(request(), h.user);
    await expect(h.registry.create(request(), h.user)).rejects.toMatchObject({
      code: "worker_limit",
    });

    await h.registry.delete(first.id, h.user);
    expect(h.registry.size).toBe(0);

    const second = await h.registry.create(request(), h.user);
    expect(second.id).not.toBe(first.id);

    // A crash the registry never asked for must return the slot too.
    await coreScript.workers.at(-1)?.crash();
    await Promise.resolve();
    expect(h.registry.size).toBe(0);
    await expect(h.registry.create(request(), h.user)).resolves.toBeDefined();
  });
});

describe("WorkerRegistry visibility (D13, acceptance 6)", () => {
  it("hides another token's worker behind worker_not_found — never forbidden", async () => {
    const h = await harness();
    const mine = await h.registry.create(request(), h.user);

    for (const call of [
      () => h.registry.get(mine.id, h.other),
      () => h.registry.snapshot(mine.id, h.other),
      () => h.registry.turn(mine.id, h.other, `t_${"0".repeat(25)}1` as TurnId),
      () => h.registry.logFor(mine.id, h.other),
    ]) {
      try {
        call();
        expect.unreachable();
      } catch (e) {
        expect(OmniError.is(e, "worker_not_found")).toBe(true);
        expect((e as OmniError).status).toBe(404);
      }
    }
    await expect(h.registry.delete(mine.id, h.other)).rejects.toMatchObject({
      code: "worker_not_found",
    });
    await expect(
      h.registry.prompt(mine.id, h.other, { content: [{ type: "text", text: "x" }] }),
    ).rejects.toMatchObject({ code: "worker_not_found" });
    await expect(h.registry.cancel(mine.id, h.other)).rejects.toMatchObject({
      code: "worker_not_found",
    });
  });

  it("lists only the caller's own workers, and everything for an admin", async () => {
    const h = await harness();
    await h.registry.create(request(), h.user);
    await h.registry.create(request(), h.other);

    expect(h.registry.list(h.user).map((w) => w.ownerTokenId)).toEqual(["user"]);
    expect(h.registry.list(h.other).map((w) => w.ownerTokenId)).toEqual(["other"]);
    expect(
      h.registry
        .list(h.admin)
        .map((w) => w.ownerTokenId)
        .sort(),
    ).toEqual(["other", "user"]);
  });

  it("lets an admin reach another token's worker by id", async () => {
    const h = await harness();
    const mine = await h.registry.create(request(), h.user);
    expect(h.registry.snapshot(mine.id, h.admin).workerId).toBe(mine.id);
  });

  it("reports an id that never existed as worker_not_found", async () => {
    const h = await harness();
    expect(() => h.registry.get(someWorkerId(99) as WorkerId, h.admin)).toThrow(
      /worker .* not found/,
    );
  });
});

describe("WorkerRegistry façade (review R11)", () => {
  it("prompt returns PromptAccepted whose seq is the state_update{running}", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    const accepted = await h.registry.prompt(handle.id, h.user, {
      content: [{ type: "text", text: "hello" }],
    });
    const running = handle.log.read(accepted.seq - 1, 1)[0];
    expect(running?.seq).toBe(accepted.seq);
    expect(running?.turnId).toBe(accepted.turnId);
    expect(running?.payload).toMatchObject({ sessionUpdate: "state_update", state: "running" });
  });

  /**
   * H28 (§5.8.6). The block-TYPE decision moved OUT of `PromptRequestBody` and into the worker's
   * `assertPromptContent`, because zod holds no worker: it can enforce neither this agent's
   * `promptCapabilities` nor this token's `cwdRoots`, and DESIGN §5.1 requires both.
   *
   * What the registry still owns is the SHAPE — an empty array, an over-long one, an unknown key
   * — and this test asserts exactly that boundary. The type gate has its own coverage against a
   * real `Worker` in `core/test/worker/prompt.test.ts`; this suite runs a fake one, so asserting
   * it here would only be asserting the fake.
   */
  it("rejects a malformed prompt body, and leaves block TYPES to the worker (H28)", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    await expect(
      h.registry.prompt(handle.id, h.user, { content: [] } as never),
    ).rejects.toMatchObject({ code: "bad_request", status: 400 });
    await expect(
      h.registry.prompt(handle.id, h.user, { content: [{ text: "no type" }] } as never),
    ).rejects.toMatchObject({ code: "bad_request", status: 400 });
    await expect(
      h.registry.prompt(handle.id, h.user, {
        content: [{ type: "text", text: "hi" }],
        stream: true,
      } as never),
    ).rejects.toMatchObject({ code: "bad_request", status: 400 });
  });

  it("surfaces worker_busy and worker_closed from the handle without re-deciding them", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    const content = [{ type: "text", text: "hi" }];
    await h.registry.prompt(handle.id, h.user, { content });
    await expect(h.registry.prompt(handle.id, h.user, { content })).rejects.toMatchObject({
      code: "worker_busy",
      status: 409,
    });

    coreScript.workers.at(-1)?.finishTurn();
    await h.registry.delete(handle.id, h.user);
    await expect(h.registry.prompt(handle.id, h.user, { content })).rejects.toMatchObject({
      code: "worker_closed",
      status: 410,
    });
  });

  it("turn() folds the log, and an unknown turn is `unknown`, not a 404 (D29)", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    const accepted = await h.registry.prompt(handle.id, h.user, {
      content: [{ type: "text", text: "hi" }],
    });
    const worker = coreScript.workers.at(-1);
    worker?.chunk("hello ");
    worker?.chunk("world");
    worker?.finishTurn("end_turn");

    const status = h.registry.turn(handle.id, h.user, accepted.turnId);
    expect(status.state).toBe("completed");
    expect(status.stopReason).toBe("end_turn");
    expect(status.result?.text).toBe("hello world");

    const unknown = h.registry.turn(handle.id, h.user, `t_${"0".repeat(25)}9` as TurnId);
    expect(unknown).toMatchObject({ state: "unknown", result: null });
  });

  it("logFor returns the worker's own log", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    expect(h.registry.logFor(handle.id, h.user)).toBe(handle.log);
  });

  it("cancel is a no-op on an idle worker and leaves it usable", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    await expect(h.registry.cancel(handle.id, h.user)).resolves.toBeUndefined();
    await expect(
      h.registry.prompt(handle.id, h.user, { content: [{ type: "text", text: "again" }] }),
    ).resolves.toMatchObject({ turnId: expect.stringMatching(/^t_/) as unknown as string });
  });
});

describe("WorkerRegistry.delete (H12) and closeAll", () => {
  it("is idempotent: a second DELETE returns the SAME body", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    const first = await h.registry.delete(handle.id, h.user);
    const second = await h.registry.delete(handle.id, h.user);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ workerId: handle.id, state: "closed", reason: "client_request" });
    // §6.6: the ownership honesty fields ride on the body.
    expect(first.leaderExited).toBe(true);
    expect(first.treeGone).toBe(h.supervisor.platform.ownership.confirmsTreeGone);
    expect(h.supervisor.live.size).toBe(0);
  });

  it("keeps a closed worker addressable so operations answer 410 rather than 404", async () => {
    const h = await harness();
    const handle = await h.registry.create(request(), h.user);
    await h.registry.delete(handle.id, h.user);
    expect(h.registry.snapshot(handle.id, h.user).state).toBe("closed");
  });

  it("closeAll closes every worker, then every log — leaving no subscription behind", async () => {
    const h = await harness();
    const a = await h.registry.create(request(), h.user);
    const b = await h.registry.create(request(), h.other);
    const sseLike = a.log.subscribe(0, () => {});
    expect(a.log.subscriberCount).toBeGreaterThan(0);

    await h.registry.closeAll("daemon_shutdown");

    expect(a.snapshot().state).toBe("closed");
    expect(b.snapshot().state).toBe("closed");
    expect(a.snapshot().closeReason).toBe("daemon_shutdown");
    // The subscriber saw the close before its subscription ended (§8.4), and nothing leaked.
    expect(sseLike.closed).toBe(true);
    expect(a.log.subscriberCount).toBe(0);
    expect(b.log.subscriberCount).toBe(0);
    expect(h.registry.size).toBe(0);
    expect(h.supervisor.allTreesReclaimed()).toBe(true);
  });

  it("closeAll is safe with no workers at all", async () => {
    const h = await harness();
    await expect(h.registry.closeAll("daemon_shutdown")).resolves.toBeUndefined();
  });
});
