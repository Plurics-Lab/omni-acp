import {
  DaemonConfig,
  HEADER,
  OmniError,
  hashSecret,
  type AgentDescriptor,
  type AuthContext,
  type Catalog,
  type CredentialStore,
  type ClientRef,
  type Daemon,
  type DaemonInfo,
  type SpawnSpec,
  type WhoAmIResponse,
  type WorkerRegistry,
} from "@omni-acp/protocol";
import { fakeRuntime } from "./fake-runtime.js";
import { fakeSupervisor } from "./fake-supervisor.js";
import { seqIds } from "./seq-ids.js";

interface Call {
  method: string;
  args: unknown[];
}

/** Everything a route needs and nothing a route decides. */
function stubAuthContext(tokenId: string, clientId: string | null): AuthContext {
  return {
    tokenId,
    role: "admin",
    clientId,
    // No headers here, so no fence (§16.1 L7). A test that wants one builds its own `ClientRef`.
    leaseEpoch: null,
    agents: "*",
    cwdRoots: [],
    maxWorkers: 16,
    assertAgent: () => {},
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: () => true,
    asClientRef: (): ClientRef => ({ tokenId, clientId }),
    // ── M2-B (§5.8.8) ────────────────────────────────────────────────────────
    //
    // Same discipline as `catalog.probe` below: a route test that reaches one of these without
    // overriding it must fail LOUDLY rather than pass against a default that quietly admits an
    // env map or an MCP preset nobody checked. The two ABSENT-request cases answer honestly,
    // because "the request asked for none" is not a policy question.
    policyCeiling: null,
    assertPolicy: () => {
      throw new OmniError("internal", "stubDaemon: override `assertPolicy` to use it");
    },
    assertEnv: (env) => {
      if (env === undefined || Object.keys(env).length === 0) {
        return { env: {}, keys: [], persist: true };
      }
      throw new OmniError("internal", "stubDaemon: override `assertEnv` to use it");
    },
    assertMcp: (names) => {
      if (names === undefined || names.length === 0) return [];
      throw new OmniError("internal", "stubDaemon: override `assertMcp` to use it");
    },
  };
}

/**
 * Every property name worth mirroring onto the recording facade: own enumerable keys PLUS
 * every property declared up the prototype chain, stopping at `Object.prototype`.
 *
 * The prototype walk is the point. A test that hands `stubDaemon` a class instance —
 * `workers: new FakeRegistry()` — has NO own function properties at all: `Object.keys` returns
 * the fields and nothing else, so every method would be dropped from the facade and every call
 * would go unrecorded. `calls` is load-bearing (WP-5 acceptance 2 asks "did this route call
 * exactly one registry method?"), and a recorder that silently records nothing is worse than no
 * recorder.
 */
function mirroredKeys(target: object): string[] {
  const keys = new Set<string>(Object.keys(target));
  for (
    let proto: object | null = Object.getPrototypeOf(target) as object | null;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key !== "constructor") keys.add(key);
    }
  }
  return [...keys];
}

/**
 * Copies one property of `source` onto `out`, wrapping functions so that calling them is
 * recorded. Accessors are re-exposed as getters that delegate to `source`, so a class-based
 * override whose `size` is a `get` accessor keeps reading live rather than freezing at merge
 * time — and is never INVOKED here, since evaluating a getter for its own sake is a side effect
 * this helper has no right to cause.
 */
function mirrorProperty(
  out: Record<string, unknown>,
  source: object,
  key: string,
  prefix: string,
  calls: Call[] | null,
): void {
  let descriptor: PropertyDescriptor | undefined;
  for (
    let o: object | null = source;
    o !== null && descriptor === undefined;
    o = Object.getPrototypeOf(o) as object | null
  ) {
    descriptor = Object.getOwnPropertyDescriptor(o, key);
  }
  if (descriptor === undefined) return;

  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    Object.defineProperty(out, key, {
      enumerable: true,
      configurable: true,
      get: () => (source as Record<string, unknown>)[key],
    });
    return;
  }

  const value = descriptor.value as unknown;
  if (typeof value !== "function") {
    out[key] = value;
    return;
  }
  const fn = value as (...a: unknown[]) => unknown;
  // `apply(source, …)` — NOT `apply(out, …)`: a prototype method reaches its own fields
  // through `this`, and the facade has none of them.
  out[key] =
    calls === null
      ? (...args: unknown[]) => fn.apply(source, args)
      : (...args: unknown[]) => {
          calls.push({ method: `${prefix}${key}`, args });
          return fn.apply(source, args);
        };
}

/**
 * Wraps every method of `target` — own or inherited — so that calling it is recorded. Overrides
 * are applied BEFORE wrapping, so a caller's own implementation is recorded too, which is what
 * makes `calls` usable as "did this route call exactly one registry method?" (WP-5 acceptance 2).
 */
function recording<T extends object>(target: T, prefix: string, calls: Call[]): T {
  const out: Record<string, unknown> = {};
  for (const key of mirroredKeys(target)) mirrorProperty(out, target, key, prefix, calls);
  return out as T;
}

/**
 * Spread (`{...base, ...overrides}`) would drop a class instance's prototype methods on the
 * floor before `recording` ever saw them, so overrides are flattened the same descriptor-aware
 * way — with methods still bound to the override object.
 */
function flatten<T extends object>(source: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of mirroredKeys(source)) mirrorProperty(out, source, key, "", null);
  return out as Partial<T>;
}

/**
 * A Daemon whose methods are recorded stubs — for pure HTTP routing tests.
 *
 * This is why `Daemon` lives in `@omni-acp/protocol/contracts` rather than in
 * `@omni-acp/daemon`: testkit must be able to produce one without importing the package
 * whose tests consume testkit (CONTRACTS.md §4).
 *
 * The default is a daemon that knows no workers: every id-addressed registry method throws
 * `worker_not_found`, which is the honest answer and the one that keeps route tests to their
 * subject. Override what a test is actually about.
 */
export function stubDaemon(
  overrides?: Partial<Daemon>,
): Daemon & { readonly calls: readonly { method: string; args: unknown[] }[] } {
  const calls: Call[] = [];
  const ids = seqIds();
  const daemonId = ids.daemon();
  const startedAt = new Date(0).toISOString();
  const supervisor = fakeSupervisor();

  const notFound = (id: string): never => {
    throw new OmniError("worker_not_found", `no worker ${id}`);
  };

  const workers: WorkerRegistry = {
    size: 0,
    create: () => {
      throw new OmniError("internal", "stubDaemon: override `workers.create` to use it");
    },
    get: (id) => notFound(id),
    list: () => [],
    delete: (id) => Promise.resolve(notFound(id)),
    closeAll: () => Promise.resolve(),
    // A stub holds no worker, so there is no parked interaction to settle. It is a SHUTDOWN path
    // and must be total: "nothing to settle" is the truth here, not a refusal (review V11).
    settleAllInteractions: () => Promise.resolve(),
    snapshot: (id) => notFound(id),
    prompt: (id) => Promise.resolve(notFound(id)),
    cancel: (id) => Promise.resolve(notFound(id)),
    turn: (id) => notFound(id),
    logFor: (id) => notFound(id),

    // ── M1 façade rows (H17-H19) ────────────────────────────────────────────
    //
    // Same discipline as the M0 rows above: a stub route test must fail LOUDLY if it reaches a
    // registry method the test never overrode, rather than pass against a default that quietly
    // invents a lease or a snapshot.
    hibernatedSize: 0,
    lease: (id) => notFound(id),
    hibernate: (id) => Promise.resolve(notFound(id)),
    wake: (id) => Promise.resolve(notFound(id)),
    adopt: () => Promise.resolve({ hibernated: 0, closed: 0, orphans: [] }),

    // ── M2 façade rows (H22-H24) ────────────────────────────────────────────
    //
    // Same discipline again, and the same `notFound` default: with no worker in this stub there
    // is nothing to answer, list or configure, and a route test that forgot to override says so.
    answer: (id) => notFound(id),
    interactions: (id) => notFound(id),
    setConfig: (id) => Promise.resolve(notFound(id)),

    // ── M3-WP1 façade rows ──────────────────────────────────────────────────
    //
    // Same discipline, same `notFound` default: a stub holds no worker, so there is no credential
    // to swap and no process to replace, and a route test that forgot to override says so loudly
    // instead of passing against an invented `CredentialApplied`.
    setCredential: (id) => Promise.resolve(notFound(id)),
    restart: (id) => Promise.resolve(notFound(id)),
  };

  const catalog: Catalog = {
    list: () => [],
    get: (id) => {
      throw new OmniError("bad_request", `unknown agent "${id}"`);
    },
    toSpawnSpec: (
      d: AgentDescriptor,
      o: { cwd: string; home?: string | null; credentialEnv?: Readonly<Record<string, string>> },
    ): SpawnSpec => ({
      command: d.command,
      args: d.args,
      cwd: o.cwd,
      // M3-WP1: `credentialEnv` is honoured because a test that asserts the composition must be
      // able to see it. `home` is NOT: the real catalog needs the descriptor's `credentials.homeEnv`
      // to know which variable to set, and a stub that guessed one would assert a variable no real
      // runtime reads.
      env: { ...d.env, ...(o.credentialEnv ?? {}) },
      label: d.id,
    }),
    // `Catalog.descriptor` NEVER throws (CONTRACTS.md §5.4): it falls back to the generic v1
    // profile, so a route that asks which quirk table governs an unknown agent gets an answer
    // instead of a 500. The stub honours that, with the id the caller asked about.
    descriptor: (id: string) => fakeRuntime({ id }),
    probe: (id: string) => {
      throw new OmniError("internal", `stubDaemon: override \`catalog.probe\` to use it (${id})`);
    },
  };

  const info: DaemonInfo = {
    daemonId,
    version: "0.0.0-stub",
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    protocolVersions: [1],
    startedAt,
    ownership: supervisor.platform.ownership,
    canonicalPayloadVersion: 2,
    // The honest answers for a daemon with no persistence at all (§14.9, H21): nothing here
    // survives a restart, nothing has failed to be written, and no previous boot left anything.
    persistence: {
      driver: "memory",
      file: null,
      schemaVersion: 0,
      sizeBytes: 0,
      writeFailures: 0,
      retentionDays: 0,
      lastSweep: null,
    },
    bootId: "boot_stub",
    orphansAtStart: { found: 0, reaped: 0, skipped: 0 },
  };

  /**
   * M3-WP1's store. Every verb refuses OUT LOUD — the registry rows' rule, and the shape
   * `create-daemon.ts` installs when nothing is wired — except `loginFor`, which is contracted
   * never to reject because `GET /v1/agents` serves it for every configured agent.
   */
  const credentials: CredentialStore = {
    list: () => Promise.resolve({ credentials: [] }),
    get: (_auth, agentId, name) =>
      Promise.reject(
        new OmniError("credential_required", `stubDaemon: no credential ${name} for ${agentId}`),
      ),
    put: () =>
      Promise.reject(new OmniError("bad_request", "stubDaemon: override `credentials.put`")),
    remove: () =>
      Promise.reject(new OmniError("bad_request", "stubDaemon: override `credentials.remove`")),
    check: () =>
      Promise.reject(new OmniError("bad_request", "stubDaemon: override `credentials.check`")),
    loginFor: () =>
      Promise.resolve({ state: "unknown", checkedAt: startedAt, deep: false } as const),
  };

  const base: Daemon = {
    id: daemonId,
    config: DaemonConfig.parse({
      tokens: [{ id: "stub", secretSha256: hashSecret("stub-daemon-secret") }],
    }),
    info,
    url: null,
    workers,
    catalog,
    // M3-WP1. Placeholder: the real one is installed on `merged` below, where the OVERRIDDEN
    // catalog and credential store are in scope. See the note there.
    agents: () => Promise.resolve({ agents: [] }),
    credentials,
    supervisor,
    // M2-B (D9). Present, and every verb refuses out loud — the same rule the registry rows
    // above follow, and the same shape `create-daemon.ts` installs when nothing is wired.
    runs: {
      create: () =>
        Promise.reject(new OmniError("bad_request", "stubDaemon: runs are not enabled")),
      get: (id) => {
        throw new OmniError("bad_request", `stubDaemon: runs are not enabled (${id})`);
      },
      list: () => [],
      cancel: () =>
        Promise.reject(new OmniError("bad_request", "stubDaemon: runs are not enabled")),
      logFor: (id) => {
        throw new OmniError("bad_request", `stubDaemon: runs are not enabled (${id})`);
      },
      recover: () => ({ abandoned: 0 }),
    },
    /**
     * M2-B (D9). Present and refusing, exactly like `runs` and `deliveries` above — and it is
     * the object `POST …/redeliver` calls, because the DISPATCHER is the only replay path that
     * re-runs the SSRF gate (review finding V1).
     */
    dispatcher: {
      start: () => {},
      dispatch: () => {
        throw new OmniError("bad_request", "stubDaemon: webhooks are not enabled");
      },
      redeliver: (id) =>
        Promise.reject(
          new OmniError("bad_request", `stubDaemon: webhooks are not enabled (${id})`),
        ),
      drain: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    },
    deliveries: {
      enqueue: () => {
        throw new OmniError("bad_request", "stubDaemon: webhooks are not enabled");
      },
      due: () => [],
      claim: () => false,
      settle: () => {
        throw new OmniError("bad_request", "stubDaemon: webhooks are not enabled");
      },
      requeueStale: () => 0,
      list: () => ({ rows: [], cursor: null }),
      redeliver: (id) => {
        throw new OmniError("bad_request", `stubDaemon: webhooks are not enabled (${id})`);
      },
    },
    mcp: {
      assertMutation: () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
      listPresets: async () => ({ presets: [] }),
      getPreset: async () => {
        throw new OmniError("bad_request", "stubDaemon: no MCP preset");
      },
      registerPreset: async () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
      removePreset: async () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
      listInstallations: async () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
      getInstallation: async () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
      install: async () => {
        throw new OmniError("forbidden", "stubDaemon: MCP management disabled");
      },
    },
    authContextFor: (tokenId, clientId) => stubAuthContext(tokenId, clientId ?? null),
    authenticate: (headers: Headers) => {
      const header = headers.get(HEADER.auth);
      const secret = header?.startsWith("Bearer ") === true ? header.slice(7) : "";
      if (secret === "") throw new OmniError("unauthorized", "missing bearer token");
      return stubAuthContext("stub", headers.get(HEADER.clientId));
    },
    whoami: (auth): WhoAmIResponse => ({
      tokenId: auth.tokenId,
      role: auth.role,
      daemonId,
      agents: auth.agents,
      cwdRoots: auth.cwdRoots,
      maxWorkers: auth.maxWorkers,
      policyCeiling: auth.policyCeiling,
      policyPresets: [],
      // FAIL CLOSED, and the stub says so too: `[]` rather than `"*"` (DESIGN §8's 🔴).
      mcpPresets: [],
      webhooks: false,
    }),
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ code: "internal", message: "stubDaemon: override `fetch` to use it" }),
          { status: 500, headers: { "content-type": "application/json" } },
        ),
      ),
    on: () => () => {},
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };

  const merged: Daemon = { ...base, ...(overrides === undefined ? {} : flatten(overrides)) };
  /**
   * M3-WP1's `GET /v1/agents`, composed AFTER the overrides are merged.
   *
   * It has to be here rather than beside the other rows: `daemon.agents(auth)` is the catalogue
   * plus each entry's per-token `login`, and a version defined over the BASE catalog would keep
   * answering `[]` for every test that overrode `catalog.list` — which is most of them, and which
   * is exactly the silent wrong answer a stub must never give. `merged` is where both halves are
   * final, and a test that overrides `agents` itself still wins because the override is applied
   * below rather than above.
   *
   * It is still ONE call from the route's point of view, which is what `m1-status-codes` asserts.
   */
  const composedAgents: Daemon["agents"] = async (auth) => ({
    agents: await Promise.all(
      merged.catalog.list().map(async (entry) => ({
        ...entry,
        login: await merged.credentials.loginFor(auth, entry.id),
      })),
    ),
  });
  const daemon = recording(
    {
      ...merged,
      // The composed one, unless the caller overrode `agents` explicitly — in which case theirs is
      // already in `merged` and wins, which is why this reads `merged.agents` rather than
      // assigning unconditionally.
      agents: overrides !== undefined && "agents" in overrides ? merged.agents : composedAgents,
      workers: recording(merged.workers, "workers.", calls),
      catalog: recording(merged.catalog, "catalog.", calls),
    },
    "",
    calls,
  );

  return Object.assign(daemon, { calls }) as Daemon & { readonly calls: readonly Call[] };
}
