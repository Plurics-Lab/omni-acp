import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniACP, type Server } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";
import { OmniError, type Daemon, type DaemonConfig } from "@omni-acp/protocol";
import { fixtureAgentPath, sdkExampleAgentPath, type FixtureAgentName } from "@omni-acp/testkit";
import type { CompatAgentConfig } from "./config.js";

/**
 * §4's setup, once per agent: a temp workspace, a temp `dataDir`, a daemon on `127.0.0.1:0` with
 * TWO tokens on the same `cwdRoot`, and TWO SDK clients with distinct ULID client ids.
 *
 * Two clients is not a detail — it is the only way step 4 (the lease) is expressible at all, and
 * `Omni-Client-Id` per `connect()` is what makes them two controllers rather than one (§16.1
 * rule L4).
 *
 * Owned by M1-WP-F.
 */

/** What a YAML entry becomes on THIS machine. Resolved once, per §18.2's substitution rules. */
export interface ResolvedLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const require_ = createRequire(import.meta.url);

/**
 * `${execPath}` and `${npxResolved:<spec>}` — the two substitutions §18.2 names.
 *
 * They exist because `command: npx` is unrunnable on Windows: §6.3 REFUSES a `.cmd` shim, and
 * since CVE-2024-27980 `spawn()` throws EINVAL for one without `shell: true`. So an npx-launched
 * runtime needs a direct-module form there, and it has to be DATA — a branch in this file would
 * make "adding an agent is a YAML edit" false for every npx-launched runtime (review R15).
 *
 * An unresolvable `${npxResolved:…}` throws rather than silently leaving the literal in the argv:
 * a spawn of a path called "${npxResolved:x}" fails with ENOENT thirty seconds later, in a place
 * that says nothing about why.
 */
function substitute(value: string): string {
  if (value === "${execPath}") return process.execPath;
  const npx = /^\$\{npxResolved:(.+)\}$/.exec(value);
  if (npx === null) return value;
  const spec = npx[1] ?? "";
  // `<name>@<version>` -> the package name; the version is npm's business, not the resolver's.
  const name = spec.startsWith("@")
    ? spec.split("@").slice(0, 2).join("@")
    : (spec.split("@")[0] ?? spec);
  try {
    return require_.resolve(name);
  } catch (e) {
    throw new OmniError(
      "bad_request",
      `cannot resolve "${name}" for \${npxResolved:${spec}}: install it, or give this agent an ` +
        "explicit windows.command in the YAML",
      { cause: e },
    );
  }
}

export function resolveLaunch(agent: CompatAgentConfig): ResolvedLaunch {
  const env = agent.env ?? {};

  if (agent.source === "sdk-example") {
    // Never `npx`, always `process.execPath <module>` — one fewer process in the tree, which is
    // exactly the layer that makes a Windows tree kill unreliable (§6.3, F8).
    return { command: process.execPath, args: [sdkExampleAgentPath()], env };
  }
  if (agent.source === "fixture") {
    return {
      command: process.execPath,
      args: [fixtureAgentPath((agent.fixture ?? "echo") as FixtureAgentName)],
      env,
    };
  }

  const windows = process.platform === "win32" ? agent.windows : undefined;
  const command = windows?.command ?? agent.command ?? "";
  const args = windows?.args ?? agent.args ?? [];
  return { command: substitute(command), args: args.map(substitute), env };
}

export interface CompatHarness {
  readonly daemon: Daemon;
  readonly url: string;
  /** The holder's token, and the observer's — the same ACL, two identities (§4 setup). */
  readonly tokenA: string;
  readonly tokenB: string;
  readonly A: Server;
  readonly B: Server;
  /** The token's only `cwdRoot`, realpath'd. */
  readonly workspace: string;
  readonly dataDir: string;
  readonly agentId: string;
  /** Stops the daemon and removes every temp directory. Idempotent. */
  dispose(): Promise<void>;
  /** Re-opens a daemon on the SAME `dataDir` — §4 step 5's restart. */
  restart(): Promise<void>;
}

/** A temp directory safe to compare against a daemon-canonicalised `cwd` (Windows 8.3 names). */
export async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

export interface HarnessOptions {
  /** `hibernate.idleMs`. §4 step 3 re-creates a worker with a small one; the default is generous. */
  readonly idleMs?: number;
  readonly workspace?: string;
}

export async function startCompatHarness(
  agent: CompatAgentConfig,
  o: HarnessOptions = {},
): Promise<CompatHarness> {
  const workspace = o.workspace ?? (await tempDir("omni-compat-ws-"));
  const dataDir = await tempDir("omni-compat-data-");
  const tokenA = randomBytes(32).toString("hex");
  const tokenB = randomBytes(32).toString("hex");
  const launch = resolveLaunch(agent);

  const config = (): DaemonConfig => ({
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
    // §4: the acceptance script runs against the DURABLE driver, because step 5 restarts the
    // daemon and asks for the same `seq` back. `memory` would make step 5 vacuous.
    eventLog: { driver: "sqlite" },
    hibernate: { idleMs: o.idleMs ?? 600_000 },
    tokens: [
      { id: "a", secret: tokenA, role: "admin", cwdRoots: [workspace], maxWorkers: 8 },
      // The SECOND user, on the SAME cwdRoot: D5's contention is between two clients of one
      // worker, and a token that could not see the worker would produce a 404 rather than a 423.
      { id: "b", secret: tokenB, role: "user", cwdRoots: [workspace], maxWorkers: 8 },
    ],
    agents: [
      {
        id: agent.id,
        command: launch.command,
        args: [...launch.args],
        ...(Object.keys(launch.env).length === 0 ? {} : { env: { ...launch.env } }),
        // The operator's quirk overlay, forwarded verbatim (§17.2's config layer).
        ...(agent.runtime === undefined ? {} : { runtime: agent.runtime }),
      },
    ],
  });

  let daemon = await createDaemon(config());
  await daemon.start();

  const connect = async (token: string): Promise<Server> => {
    const url = daemon.url;
    if (url === null) throw new OmniError("internal", "the compat daemon bound no socket");
    // No explicit `clientId`: the SDK mints a ULID per `connect()`, which is precisely the
    // property step 4 depends on (§16.1 rule L4).
    return OmniACP.connect({ url, token });
  };

  let A = await connect(tokenA);
  /**
   * B is a second CLIENT of the SAME token, not a second token.
   *
   * §4's setup configures two tokens and connects A and B with `token` — the same one — and
   * M1-PLAN §2 (WP-F 9) spells the reason out: "two SDK clients, ONE token, distinct client ids".
   * D13 makes a second token's view of A's worker a `404`, not a `423`: invisibility and
   * lease-contention are different rules, and pointing B at the other token would test the first
   * while claiming to test the second. The distinct client ids come from the SDK, which mints a
   * ULID per `connect()` (§16.1 rule L4) — which is the property the lease case is really about.
   */
  let B = await connect(tokenA);
  let disposed = false;

  const harness: CompatHarness = {
    get daemon(): Daemon {
      return daemon;
    },
    get url(): string {
      return daemon.url ?? "";
    },
    tokenA,
    tokenB,
    get A(): Server {
      return A;
    },
    get B(): Server {
      return B;
    },
    workspace,
    dataDir,
    agentId: agent.id,
    async restart(): Promise<void> {
      await A.close().catch(() => {});
      await B.close().catch(() => {});
      await daemon.stop({ graceful: true });
      daemon = await createDaemon(config());
      await daemon.start();
      A = await connect(tokenA);
      B = await connect(tokenA);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await A.close().catch(() => {});
      await B.close().catch(() => {});
      await daemon.stop({ graceful: true }).catch(() => {});
      for (const dir of [workspace, dataDir]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
  return harness;
}

// ── SSE, at the frame level ──────────────────────────────────────────────────

export interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}

/**
 * `sse.ts`'s own frame grammar, read back: blank-line-separated blocks, `field: value` lines, one
 * optional leading space stripped, `data:` lines joined with "\n", comment lines ignored.
 *
 * Deliberately NOT `@omni-acp/testkit`'s `collectSse`, which parses envelopes: §18.4's
 * `stream-resume` compares FRAMES — the `id:`/`event:`/`data:` triples — because that is the
 * level at which "reconnect loses no events" is a claim about the wire rather than about our own
 * decoder (review R12).
 */
export function parseFrames(text: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (id === undefined && event === undefined && data.length === 0) continue;
    frames.push({
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      data: data.join("\n"),
    });
  }
  return frames;
}

/** The control frames §18.4 excludes from the comparison and asserts separately. */
export const CONTROL_EVENTS = new Set([
  "omni.stream_truncated",
  "omni.stream_overflow",
  "omni.stream_end",
]);

export function envelopeFrames(frames: readonly SseFrame[]): SseFrame[] {
  return frames.filter((f) => f.event !== undefined && !CONTROL_EVENTS.has(f.event));
}

export interface SseReader {
  /** Everything received so far, as raw text. */
  text(): string;
  /** Resolves when `predicate` is true of the accumulated text, or rejects at `timeoutMs`. */
  until(predicate: (text: string) => boolean, timeoutMs: number): Promise<void>;
  close(): void;
  readonly done: Promise<void>;
}

/**
 * A raw SSE reader — `fetch` plus a byte accumulator, no SDK in the loop.
 *
 * The SDK's `events()` hides exactly what `stream-resume` is measuring: it reconnects on its own,
 * discards duplicates, and hands back envelopes rather than frames. To assert that the UNION of
 * two connections equals one uninterrupted stream, the test has to own the cut.
 */
export function openSse(url: string, token: string, workerId: string, since: number): SseReader {
  const controller = new AbortController();
  let accumulated = "";
  const waiters: {
    ok: () => void;
    fail: (e: unknown) => void;
    predicate: (t: string) => boolean;
  }[] = [];

  const pump = async (): Promise<void> => {
    const response = await fetch(`${url}/v1/workers/${workerId}/events?since=${String(since)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || response.body === null) {
      throw new OmniError("internal", `SSE open failed: HTTP ${String(response.status)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        accumulated += decoder.decode(value, { stream: true });
        for (const waiter of waiters.splice(0).reverse()) {
          if (waiter.predicate(accumulated)) waiter.ok();
          else waiters.push(waiter);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  };

  const done = pump().catch((e: unknown) => {
    // An aborted read is the CALLER cutting the stream, which is the whole point of this reader.
    if (controller.signal.aborted) return;
    // Anything else — a `404` because the token cannot see this worker, a refused connection —
    // has to reach whoever is WAITING, or an `until()` sits on its deadline reporting a timeout
    // for a stream that failed to open in the first millisecond. That mis-diagnosis costs a
    // minute per call and points at the wrong file.
    for (const waiter of waiters.splice(0)) waiter.fail(e);
    throw e;
  });

  return {
    text: () => accumulated,
    until: (predicate, timeoutMs) =>
      new Promise<void>((resolve, reject) => {
        if (predicate(accumulated)) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          reject(new OmniError("agent_timeout", `SSE wait timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        waiters.push({
          predicate,
          ok: () => {
            clearTimeout(timer);
            resolve();
          },
          fail: (e: unknown) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new OmniError("internal", String(e)));
          },
        });
      }),
    close: () => controller.abort(),
    done,
  };
}

// ── a throwaway ACP conversation, by hand ────────────────────────────────────

/**
 * Spawns the agent, speaks ndJSON at it directly, and brings back the raw answers.
 *
 * This is §4 step 3's "probe layer": a SECOND throwaway process that sends the descriptor's
 * resume spelling with a deliberately foreign cwd, which is exactly how the corpus recorder
 * produced transcripts `07`/`08`. It cannot be driven through `Worker.wake()` — a worker's cwd is
 * fixed at creation and there is no API to resume a pointer under a different one (review R17) —
 * and it must not go through `@omni-acp/core`, which `tests/compat` deliberately does not depend
 * on. Hand-rolled ndJSON is thirty lines and keeps the dependency edge honest.
 *
 * Notifications are ignored by construction: only a frame carrying our `id` is an answer.
 */
export async function acpConversation(
  launch: ResolvedLaunch,
  calls: readonly { method: string; params: unknown }[],
  o: { cwd: string; timeoutMs: number },
): Promise<
  readonly { result?: unknown; error?: { code: number; message: string; data?: unknown } }[]
> {
  const { spawn } = await import("node:child_process");
  const child = spawn(launch.command, [...launch.args], {
    cwd: o.cwd,
    stdio: ["pipe", "pipe", "ignore"],
    shell: false,
    env: { ...process.env, ...launch.env },
  });

  const answers = new Map<
    number,
    { result?: unknown; error?: { code: number; message: string; data?: unknown } }
  >();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at === -1) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() === "") continue;
      try {
        const frame = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
        if (typeof frame.id === "number") {
          answers.set(frame.id, {
            ...(frame.result === undefined ? {} : { result: frame.result }),
            ...(frame.error === undefined
              ? {}
              : { error: frame.error as { code: number; message: string; data?: unknown } }),
          });
        }
      } catch {
        // A non-JSON line is an agent's startup banner. The frame reader in `core` handles those
        // properly; here we are reading four answers and a banner is not one of them.
      }
    }
  });

  const deadline = Date.now() + o.timeoutMs;
  const out: { result?: unknown; error?: { code: number; message: string; data?: unknown } }[] = [];
  try {
    for (const [index, call] of calls.entries()) {
      const id = index + 1;
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params: call.params })}\n`,
      );
      const ok = await until(() => answers.has(id), Math.max(0, deadline - Date.now()), 20);
      if (!ok) throw new OmniError("agent_timeout", `no answer to ${call.method} within budget`);
      out.push(answers.get(id) ?? {});
    }
    return out;
  } finally {
    child.kill("SIGKILL");
  }
}

/** Polls a condition. Returns false on timeout rather than throwing, so callers can report. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}
