import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_V1_PROFILE,
  alwaysGrantedLease,
  assertPromptContent,
  createBaselineResponder,
  createMemoryEventLog,
  createNormalizer,
  createSessionStrategy,
  createSupervisor,
  createWorker,
  type CreateWorkerDeps,
} from "@omni-acp/core";
import { nullLogger, seqIds } from "@omni-acp/testkit";
import {
  AgentDescriptor,
  DaemonConfig,
  OmniError,
  type ClientRef,
  type Clock,
  type DaemonId,
  type TokenId,
  type WorkerHandle,
  type WorkerId,
} from "@omni-acp/protocol";

/**
 * Prompt containment, against transcript `17`'s recorded shape: a `resource_link` inside cwd and
 * one outside it.
 *
 * The acceptance is not the 400 — it is that in every rejected case the fixture agent recorded
 * ZERO `session/prompt` calls (F37, F38). Once a path reaches the agent, D3 says the agent reads
 * the disk itself, and the question is already answered the wrong way.
 *
 * TIER 3: a real process, real ndJSON over real pipes, a real `realpath` over real symlinks. The
 * agent is `packages/testkit/fixtures/mcp/wire-recorder.mjs`, which writes down every request it
 * received — the only side of the pipe from which "the prompt was never sent" is observable.
 *
 * The worker is built with `createWorker` directly rather than through `POST /v1/workers`,
 * because the daemon's worker-creation path does not yet inject `deps.validateContent`:
 * `packages/daemon/src/registry.ts` is M2-WP-J's file, and M2-B-WP-S reports the three-line hunk
 * rather than editing it. Everything below the injection point — `Worker.prompt`'s hunk 9, the
 * admission rollback, the `400` coming FROM `prompt()`, the agent's own record — is exercised
 * exactly as it will be once that hunk lands.
 *
 * Owned by M2-B-WP-S.
 */

const RECORDER = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "testkit",
  "fixtures",
  "mcp",
  "wire-recorder.mjs",
);

const DAEMON_ID = "d_00000000000000000000000001" as DaemonId;
const OWNER: ClientRef = { tokenId: "tok_it" as TokenId, clientId: "cli_it" };

const clock: Clock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  setTimer: (delayMs, fn) => {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  },
};

const config = DaemonConfig.parse({
  tokens: [{ id: "t", secret: "it-secret-it-secret-it-secret" }],
});

let root: string;
let other: string;
let logFile: string;
let inside: string;
let outside: string;
let escapingLink: string;
let workers = 0;
const live: WorkerHandle[] = [];

/** Every `{method, params}` the agent process has recorded so far. */
async function recorded(): Promise<{ method: string; params: unknown }[]> {
  const text = await readFile(logFile, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { method: string; params: unknown });
}

const promptCalls = async (): Promise<number> =>
  (await recorded()).filter((r) => r.method === "session/prompt").length;

/**
 * Waits until the AGENT has written down `n` prompts.
 *
 * `Worker.prompt` answers `202 PromptAccepted` the instant the turn is admitted and the running
 * marker is appended — §7.1 is explicit that the marker precedes the bytes reaching stdin — so
 * counting the recorder's lines the microsecond `prompt()` resolves is a race the fixture wins
 * about half the time. Every POSITIVE count therefore waits; every ZERO count is asserted
 * immediately AND re-asserted after a subsequent prompt has provably landed, which is a stronger
 * claim than any sleep: the rejected prompt did not merely fail to arrive in time, it never
 * arrived at all.
 */
async function awaitPromptCalls(n: number, budgetMs = 15_000): Promise<number> {
  const deadline = Date.now() + budgetMs;
  let seen = await promptCalls();
  while (seen < n && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    seen = await promptCalls();
  }
  return seen;
}

async function startWorker(o?: { validate?: boolean }): Promise<WorkerHandle> {
  workers += 1;
  const workerId = `w_0000000000000000000000000${String(workers)}` as WorkerId;
  // Through `AgentDescriptor.parse`, so `runtime` / `probe` carry the same zod defaults a
  // configured agent gets rather than a hand-written approximation of them.
  const descriptor: AgentDescriptor = AgentDescriptor.parse({
    id: "wire-recorder",
    command: process.execPath,
    args: [RECORDER],
    env: { RECORDER_LOG: logFile, RECORDER_PROMPT_CAPS: JSON.stringify({ image: true }) },
    protocolVersion: 1,
    shutdown: { signal: "SIGTERM", graceMs: 2_000 },
  });

  const deps: CreateWorkerDeps = {
    workerId,
    daemonId: DAEMON_ID,
    descriptor,
    cwd: root,
    label: null,
    owner: OWNER,
    supervisor: createSupervisor({ config: config.supervisor, clock, logger: nullLogger() }),
    log: createMemoryEventLog({
      workerId,
      daemonId: DAEMON_ID,
      clock,
      maxEvents: 1_000,
      subscriberQueueSize: 64,
    }),
    normalizer: createNormalizer({ quietMs: 200, hardMs: 10_000, cwd: root }),
    responder: createBaselineResponder("deny", clock),
    lease: alwaysGrantedLease(OWNER, workerId),
    session: createSessionStrategy({ descriptor: DEFAULT_V1_PROFILE, clock, logger: nullLogger() }),
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    limits: {
      handshakeTimeoutMs: 30_000,
      cancelGraceMs: 5_000,
      exitGraceMs: 1_000,
      gracefulMs: 2_000,
    },
    // THE ONE CALL SITE (§26.2), bound the way the daemon's creation path must bind it: to the
    // TOKEN's `cwdRoots` and to THIS worker's `promptCapabilities`. `handle` is read lazily
    // because the capabilities only exist after the handshake, which is after this object.
    ...(o?.validate === false
      ? {}
      : {
          validateContent: async (content: readonly unknown[]): Promise<void> => {
            await assertPromptContent({
              content,
              cwd: root,
              cwdRoots: [root],
              promptCapabilities: handle?.snapshot().capabilities?.promptCapabilities ?? null,
              realpath,
            });
          },
        }),
  };

  const handle: WorkerHandle = await createWorker(deps);
  live.push(handle);
  return handle;
}

/**
 * Waits for the turn to settle.
 *
 * `prompt()` on a `running` worker is `409 worker_busy` (H8), and that check sits BEFORE hunk 9's
 * containment gate — so a test that prompted twice without waiting would assert the gate's status
 * and receive the admission's.
 */
async function untilReady(worker: WorkerHandle, budgetMs = 15_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  while (worker.snapshot().state !== "ready" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return worker.snapshot().state;
}

async function rejected(p: Promise<unknown>): Promise<OmniError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "omni-pc-it-root-")));
  other = await realpath(await mkdtemp(join(tmpdir(), "omni-pc-it-other-")));
  logFile = join(await realpath(await mkdtemp(join(tmpdir(), "omni-pc-it-log-"))), "wire.jsonl");
  inside = join(root, "inside.txt");
  outside = join(other, "outside.txt");
  await writeFile(inside, "INSIDE-OK\n");
  await writeFile(outside, "OUTSIDE-SECRET-BETA\n");
  escapingLink = join(root, "escape.txt");
  await symlink(outside, escapingLink);
});

afterAll(async () => {
  for (const handle of live) await handle.close("client_request").catch(() => {});
  for (const dir of [root, other, dirname(logFile)]) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const link = (path: string) => ({
  type: "resource_link",
  uri: pathToFileURL(path).href,
  name: "n",
});

describe("prompt containment (M2-B, §26)", () => {
  it("a resource_link outside cwdRoots is 400 and the agent recorded ZERO session/prompt calls", async () => {
    const worker = await startWorker();
    expect(worker.snapshot().state).toBe("ready");
    // The handshake happened, so the recorder is alive and writing: "zero prompts" below is the
    // absence of a line in a file that already has lines in it.
    const before = await recorded();
    expect(before.map((r) => r.method)).toEqual(["initialize", "session/new"]);
    expect(await promptCalls()).toBe(0);

    const e = await rejected(
      worker.prompt([{ type: "text", text: "read this" }, link(outside)], OWNER),
    );
    expect(e.code).toBe("bad_request");
    expect(e.status).toBe(400);

    // THE ACCEPTANCE. Not the status — the silence on the wire.
    expect(await promptCalls()).toBe(0);
    expect((await recorded()).map((r) => r.method)).toEqual(["initialize", "session/new"]);

    // …and the worker is still usable, because the admission was rolled back rather than left
    // half-taken (hunk 9's `#state = "ready"` on rejection).
    expect(worker.snapshot().state).toBe("ready");
    const accepted = await worker.prompt([{ type: "text", text: "hello" }], OWNER);
    expect(accepted.turnId).toMatch(/^t_/);
    expect(await awaitPromptCalls(1)).toBe(1);
  }, 45_000);

  it("a symlink inside cwd that realpaths outside it is rejected — realpath first, contain second", async () => {
    const worker = await startWorker();
    const before = await promptCalls();

    // A prefix check would accept this: the link's own path is literally inside the root.
    expect(escapingLink.startsWith(root)).toBe(true);
    expect((await rejected(worker.prompt([link(escapingLink)], OWNER))).code).toBe("bad_request");
    expect(await promptCalls()).toBe(before);

    // The file it points at is real and readable — the refusal is about WHERE it lands.
    expect(await readFile(outside, "utf8")).toContain("OUTSIDE-SECRET-BETA");

    // …and the inside file, reached directly, goes through.
    await worker.prompt([link(inside)], OWNER);
    expect(await awaitPromptCalls(before + 1)).toBe(before + 1);
  }, 45_000);

  it("the error message ELIDES the path", async () => {
    const worker = await startWorker();
    for (const block of [link(outside), link(escapingLink)]) {
      const e = await rejected(worker.prompt([block], OWNER));
      const seen = `${e.message} ${JSON.stringify(e.detail ?? {})}`;
      expect(seen).not.toContain(outside);
      expect(seen).not.toContain(other);
      expect(seen).not.toContain("outside.txt");
    }
  }, 45_000);

  it("refuses a relative uri, a non-file scheme, and a block type the agent did not advertise", async () => {
    const worker = await startWorker();
    const before = await promptCalls();
    const blocks: unknown[] = [
      { type: "resource_link", uri: "notes.txt", name: "n" },
      { type: "resource_link", uri: "https://example.invalid/x", name: "n" },
      { type: "resource", resource: { uri: pathToFileURL(outside).href, text: "…" } },
      // The recorder advertises `{image: true}` and says nothing about audio.
      { type: "audio", data: "", mimeType: "audio/wav" },
      { type: "terminal" },
    ];
    for (const block of blocks) {
      expect((await rejected(worker.prompt([block], OWNER))).code, JSON.stringify(block)).toBe(
        "bad_request",
      );
    }
    expect(await promptCalls()).toBe(before);

    // …and the ADVERTISED one is accepted, so the gate is reading the real handshake rather than
    // refusing every non-text block. Once THAT prompt has landed, the count proves the five
    // rejected ones never did.
    await worker.prompt([{ type: "image", data: "", mimeType: "image/png" }], OWNER);
    expect(await awaitPromptCalls(before + 1)).toBe(before + 1);
  }, 45_000);

  it("the M0 text-only path is unchanged when nothing is injected (acceptance 9)", async () => {
    const worker = await startWorker({ validate: false });
    const before = await promptCalls();
    await worker.prompt([{ type: "text", text: "plain" }], OWNER);
    expect(await awaitPromptCalls(before + 1)).toBe(before + 1);
    expect(await untilReady(worker)).toBe("ready");
    // With no gate injected the fallback is M0's whitelist, which refuses EVERY non-text block —
    // including the inside-cwd link the injected gate accepts. That difference is the whole
    // reason §5.8.6's refine was deleted rather than widened.
    expect((await rejected(worker.prompt([link(inside)], OWNER))).code).toBe("bad_request");
    await worker.prompt([{ type: "text", text: "again" }], OWNER);
    expect(await awaitPromptCalls(before + 2)).toBe(before + 2);
  }, 45_000);
});
