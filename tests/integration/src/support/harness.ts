import { randomBytes } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniACP, type Server } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";
import type { Daemon, DaemonConfig } from "@omni-acp/protocol";
import { fixtureAgentPath, sdkExampleAgentPath, type FixtureAgentName } from "@omni-acp/testkit";

/**
 * The Tier-3 harness: real processes, real ndJSON, real loopback HTTP.
 *
 * Everything here is a cross-platform hygiene rule from CONTRACTS.md §10.3 in code form, so that
 * no individual suite has to remember it:
 *
 *  - `mkdtemp` under `os.tmpdir()`, and `realpath`'d — on Windows the daemon canonicalises `cwd`
 *    while `os.tmpdir()` hands back the 8.3 short name `C:\Users\RUNNER~1`, and a raw comparison
 *    flakes for a reason nobody can reproduce locally;
 *  - `port: 0` everywhere, never a fixed port;
 *  - `dataDir` inside the temp tree, so a test never writes to a developer's `~/.omni-acp`;
 *  - agents launched as `process.execPath <module>` — never `npx`, which is a `.cmd` shim on
 *    Windows and since CVE-2024-27980 throws EINVAL without `shell: true` (§6.3).
 */

export interface Harness {
  readonly daemon: Daemon;
  readonly token: string;
  /** Two realpath'd temp directories, both inside the token's `cwdRoots`. */
  readonly roots: readonly string[];
  connect(): Promise<Server>;
  /** Stops the daemon and removes every temp directory. Idempotent. */
  dispose(): Promise<void>;
}

export interface HarnessOptions {
  /** How many `cwdRoots` to create. Default 2 — the acceptance script wants two. */
  readonly roots?: number;
  /** `null` binds no socket at all (D15 constraint 1). Default: `127.0.0.1:0`. */
  readonly listen?: { host: string; port: number } | null;
  /** Extra agents beyond `example` (the SDK's own example agent). */
  readonly agents?: readonly {
    id: string;
    command: string;
    args: string[];
    env?: Record<string, string>;
  }[];
  readonly handshakeTimeoutMs?: number;
  readonly config?: Partial<DaemonConfig>;
}

/** A temp directory that is safe to compare against a daemon-canonicalised `cwd`. */
export async function tempRoot(prefix = "omni-acp-it-"): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** `process.execPath <fixture>` — the shim-free launch form (§6.3, F8). */
export function fixtureAgent(id: string, name: FixtureAgentName, env?: Record<string, string>) {
  return { id, command: process.execPath, args: [fixtureAgentPath(name)], ...(env ? { env } : {}) };
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const rootCount = options.roots ?? 2;
  const roots: string[] = [];
  for (let i = 0; i < rootCount; i++) roots.push(await tempRoot());
  const dataDir = await tempRoot("omni-acp-data-");

  const token = randomBytes(32).toString("hex");
  const config: DaemonConfig = {
    ...options.config,
    dataDir,
    listen: options.listen === undefined ? { host: "127.0.0.1", port: 0 } : options.listen,
    tokens: [{ id: "local", secret: token, role: "admin", cwdRoots: roots, maxWorkers: 16 }],
    agents: [
      // Tier 3: the SDK's own UNMODIFIED example agent, resolved from the SDK's main entry (F8).
      { id: "example", command: process.execPath, args: [sdkExampleAgentPath()] },
      ...(options.agents ?? []),
    ],
    ...(options.handshakeTimeoutMs === undefined
      ? {}
      : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
  };

  const daemon = await createDaemon(config);
  await daemon.start();

  let disposed = false;
  return {
    daemon,
    token,
    roots,
    async connect(): Promise<Server> {
      const url = daemon.url;
      if (url === null) throw new Error("this harness bound no socket; use the in-process path");
      return OmniACP.connect({ url, token });
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await daemon.stop({ graceful: true }).catch(() => {});
      for (const dir of [...roots, dataDir]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

/**
 * `Daemon.fetch` is `(Request) => Promise<Response>`; `ConnectOptions.fetch` is
 * `typeof globalThis.fetch` (CONTRACTS.md §5.5). Runtime-identical for every call the SDK makes
 * — it only ever builds a `Request` and calls `fetch(request)` — but the narrower type is not
 * assignable to the wider one under `strictFunctionTypes`, so this adapts rather than casts.
 */
export function fetchOf(daemon: Daemon): typeof globalThis.fetch {
  return (input, init) =>
    daemon.fetch(input instanceof Request && init === undefined ? input : new Request(input, init));
}

/** A raw `fetch` against a listening daemon — no SDK in the loop (`curl-shapes.itest.ts`). */
export function curl(
  base: string,
  token: string | null,
): (path: string, init?: RequestInit) => Promise<Response> {
  return (path, init) =>
    fetch(`${base}${path}`, {
      ...init,
      headers: {
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
}

/** Polls a condition. Returns false on timeout rather than throwing, so callers can report. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs));
  }
}

/** macOS runners are slow enough to need a multiplier (CONTRACTS.md §10.3). */
export const SLOW = Number(
  process.env["OMNI_TEST_SLOW_FACTOR"] ?? (process.platform === "darwin" ? "2" : "1"),
);

export function scaled(ms: number): number {
  return Math.round(ms * SLOW);
}
