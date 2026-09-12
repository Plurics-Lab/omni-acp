import {
  OmniError,
  assertWorkerId,
  type AgentCatalogEntry,
  type AgentListResponse,
  type CreateWorkerRequest,
  type DaemonId,
  type DaemonInfo,
  type ProbeRequestBody,
  type ProbeResponse,
  type WhoAmIResponse,
  type WorkerListResponse,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createCredentialsChannel, type CredentialsChannel } from "./credentials.js";
import { createRunsChannel, type RunsChannel } from "./runs.js";
import { createTransport, type Transport, type TransportOptions } from "./transport.js";
import { createWorkerHandle, disposeWorker, type Worker } from "./worker.js";

export interface CreateAgentOptions {
  readonly cwd: string;
  readonly label?: string;
  readonly timeoutMs?: number;
  /**
   * MCP preset NAMES, resolved against `DaemonConfig.mcpServers` (§23.1).
   *
   * `string[]` at the type level is DESIGN §8's 🔴 row enforced by the TYPE rather than by a
   * validator somebody could move: a client can never put a `command` on this wire at all, and
   * `client-never-sends-a-command` guards it. An unknown name is a `400` naming it; a name outside
   * the token's `mcpPresets` is a `403`. Never a silent drop.
   */
  readonly mcp?: readonly string[];
  /**
   * D4's policy for this worker: a preset name, a list of them, or an inline document.
   *
   * Merged preset ⊕ inline, then checked against the token's `policyCeiling` — exceeding it is
   * `403 policy_exceeds_ceiling` at CREATE, before a process exists (§20.5).
   *
   * Typed off `CreateWorkerRequest`, which is the `z.input` shape (§5.8.7): a CLIENT WRITES this,
   * and on the output type every `match` field the schema defaults would read as required — so a
   * caller would have to spell `subject` and `method` on a rule that only cares about `kind`.
   */
  readonly policy?: CreateWorkerRequest["policy"];
  /** Per-worker environment. A blacklisted key is REJECTED by name, never dropped (§23.3). */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-worker override of the daemon-wide idle watchdog, field by field (§21). */
  readonly watchdog?: {
    readonly silentMs?: number;
    readonly toolMs?: number;
    readonly cancelTimeoutMs?: number;
    readonly enabled?: boolean;
  };
  /** Per-worker `diff.mode` (D8). `"off"` opts this worker out of the patch entirely. */
  readonly patch?: "off" | "on_write" | "always";
  /** How long a parked interaction may wait for a human. `0` ⇒ it never expires (§19.1). */
  readonly parkTimeoutMs?: number;
  /** What an EXPIRED park does. `"allow"` is deliberately not a value (ruling M2-R7). */
  readonly parkTimeoutAction?: "deny" | "fail";
  /**
   * D10's three dispositions, widened from M0's `"deny"`-only literal.
   *
   * The WIRE has accepted all three since the M2 Land step (`CreateWorkerRequest.onUnresolved`,
   * `z.enum(["park","deny","fail"])`) and L25 makes `park` the headline of the interaction
   * lifecycle — it is what makes the daemon declare `elicitation.form` at all (F28, §19.2). The
   * `"deny"`-only literal in §5.8's snapshot is M0's, alongside the `mcp?: readonly []` beside it
   * that says of itself "MCP presets are M2".
   */
  readonly onUnresolved?: "park" | "deny" | "fail";
  /**
   * Per-worker override of `hibernate.idleMs`. `0` disables hibernation for THIS worker
   * (`CreateWorkerRequest.idleTimeoutMs`, §15.2).
   */
  readonly idleTimeoutMs?: number;
  /**
   * `"take"` (the default) ⇒ the creator holds the lease; `"observe"` ⇒ the worker is created
   * lease-free, which is how a supervisor starts a worker somebody else will drive (D5).
   */
  readonly lease?: "take" | "observe";
  // ── M3-WP1 (docs/M3-WP1-CREDENTIALS.md) ────────────────────────────────────
  /**
   * WHICH stored credential this worker runs on, BY NAME — a client never puts a secret on this
   * wire, which is the same rule `mcp` follows for a command.
   *
   * Omitted ⇒ this token's `default` for this agent, and the inherited environment when it has
   * none (M2's behaviour). `"none"` ⇒ an EMPTY home, which is how you prove a worker is
   * unauthenticated rather than quietly borrowing the daemon's own login. `"inherit"` is the
   * explicit spelling of the fallback.
   */
  readonly credential?: string;
  /**
   * `"isolated"` (the default) ⇒ this worker gets `<dataDir>/homes/<workerId>` with the credential
   * LINKED into it, so two workers of one agent never share a session directory. `"shared"` ⇒ no
   * per-worker home and the daemon's own environment, which is M2.
   */
  readonly home?: "isolated" | "shared";
}

/**
 * The client deadline for `POST /v1/agents/{id}/probe`.
 *
 * `probe.timeoutMs` defaults to 90 s daemon-side (spawn + `initialize` + `session/new` + §17.4's
 * battery, on an agent whose cold start alone is ~7 s), and the client's default request deadline
 * is 30 s. A client that gave up first would leave the daemon finishing a probe whose answer
 * nobody reads — and would report `agent_timeout` for a probe that worked.
 */
const PROBE_REQUEST_TIMEOUT_MS = 120_000;

export interface Server {
  readonly url: string;
  readonly daemonId: DaemonId;
  /** From connect()'s single GET /v1/whoami. */
  readonly me: WhoAmIResponse;
  info(): Promise<DaemonInfo>;
  agents(): Promise<readonly AgentCatalogEntry[]>;
  createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker>;
  /**
   * H16. Spawns ONE throwaway process, runs §17.4's battery, reclaims the tree, and caches the
   * answer under `<dataDir>/probes/<id>.json` — so the second call is `cached: true` and costs
   * nothing (ruling M1-R16).
   *
   * It is what turns the compat suite's `capability` skips into evidence: a case an agent cannot
   * satisfy is reported as a sourced skip rather than as a failure, and the probe is the source.
   */
  probe(agentId: string, o?: ProbeRequestBody): Promise<ProbeResponse>;
  /** Snapshots, not live handles — a listing must not open N SSE streams (D31). */
  workers(): Promise<readonly WorkerSnapshot[]>;
  attach(workerId: string): Promise<Worker>;
  /**
   * DESIGN §9.3's fire-and-forget half: create + prompt + settle + close, with an optional
   * webhook. `runs.events(id)` is the SAME resumable tail `worker.events()` is, pointed at the
   * run's own route, so a dropped connection is recovered by `?since=` rather than by a second
   * implementation of the same idea.
   */
  readonly runs: RunsChannel;
  /**
   * M3-WP1's credential store, as five calls (§线上协议).
   *
   * `put` is the only one that carries a secret, and it only ever goes UP: `get` and `list`
   * answer summaries whose strongest identifier is a 12-hex-character fingerprint. The daemon
   * refuses a `put` over a connection that is neither TLS nor loopback (`403
   * insecure_transport`), which is why `OmniACP.localCredential` reads the machine's own login on
   * THIS side of the wire and hands you a body rather than a path.
   */
  readonly credentials: CredentialsChannel;
  /** Closes local streams. For local(), also stops the embedded daemon. Remote workers survive. */
  close(): Promise<void>;
}

/**
 * The one code path both `OmniACP.connect()` and `OmniACP.local()` take.
 *
 * It issues EXACTLY ONE request, `GET /v1/whoami` (DESIGN §8): a client that has to probe
 * several endpoints to learn what it may do is a client whose permissions can drift between
 * probes. `local()` differs only in supplying an `onClose` that also stops the embedded daemon,
 * which is what keeps D14 and D15 on one path rather than two.
 */
export async function connectServer(
  options: TransportOptions,
  onClose?: () => Promise<void>,
): Promise<Server> {
  const transport = createTransport(options);
  const me = await transport.request<WhoAmIResponse>("GET", "/v1/whoami");
  return createServer(transport, me, options.url, onClose);
}

export function createServer(
  transport: Transport,
  me: WhoAmIResponse,
  url: string,
  onClose?: () => Promise<void>,
): Server {
  // Handles this Server minted. `close()` stops their local streams — it does NOT close the
  // remote workers, which outlive the client by design (that is what `attach()` is for).
  const handles = new Set<Worker>();
  const runs = createRunsChannel(transport);
  const credentials = createCredentialsChannel(transport);
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new OmniError("bad_request", "this Server is closed");
  };

  const track = (snapshot: WorkerSnapshot): Worker => {
    const worker = createWorkerHandle(transport, snapshot);
    handles.add(worker);
    return worker;
  };

  return {
    url,
    daemonId: me.daemonId,
    me,
    runs,
    credentials,

    async info(): Promise<DaemonInfo> {
      assertOpen();
      return transport.request<DaemonInfo>("GET", "/v1/info");
    },

    async agents(): Promise<readonly AgentCatalogEntry[]> {
      assertOpen();
      const body = await transport.request<AgentListResponse>("GET", "/v1/agents");
      return body.agents;
    },

    async createAgent(agentId: string, opts: CreateAgentOptions): Promise<Worker> {
      assertOpen();
      if (agentId === "") throw new OmniError("bad_request", "createAgent() needs an agent id");
      if (opts.cwd === "") throw new OmniError("bad_request", "createAgent() needs a cwd");

      // Built key by key rather than by spreading `opts`: `CreateWorkerRequest` is a
      // `strictObject`, so a field this milestone does not accept has to fail here with a
      // sentence, not on the wire with a zod path.
      const body: CreateWorkerRequest = {
        agent: agentId,
        cwd: opts.cwd,
        ...(opts.label === undefined ? {} : { label: opts.label }),
        ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        ...(opts.mcp === undefined ? {} : { mcp: [...opts.mcp] }),
        ...(opts.onUnresolved === undefined ? {} : { onUnresolved: opts.onUnresolved }),
        ...(opts.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: opts.idleTimeoutMs }),
        ...(opts.lease === undefined ? {} : { lease: opts.lease }),
        // ── M2 (§5.8.7) ────────────────────────────────────────────────────
        ...(opts.policy === undefined ? {} : { policy: opts.policy }),
        ...(opts.env === undefined ? {} : { env: { ...opts.env } }),
        ...(opts.watchdog === undefined ? {} : { watchdog: { ...opts.watchdog } }),
        ...(opts.patch === undefined ? {} : { patch: opts.patch }),
        ...(opts.parkTimeoutMs === undefined ? {} : { parkTimeoutMs: opts.parkTimeoutMs }),
        ...(opts.parkTimeoutAction === undefined
          ? {}
          : { parkTimeoutAction: opts.parkTimeoutAction }),
        // ── M3-WP1 ──────────────────────────────────────────────────────────
        ...(opts.credential === undefined ? {} : { credential: opts.credential }),
        ...(opts.home === undefined ? {} : { home: opts.home }),
      };

      // H5 is synchronously ready: the 201 already carries `state:"ready"` and the real
      // handshake capabilities, so there is nothing to poll for.
      const snapshot = await transport.request<WorkerSnapshot>("POST", "/v1/workers", body);
      return track(snapshot);
    },

    async probe(agentId: string, o?: ProbeRequestBody): Promise<ProbeResponse> {
      assertOpen();
      if (agentId === "") throw new OmniError("bad_request", "probe() needs an agent id");
      // The id is a path segment and the daemon owns its validation: an unknown agent is a
      // `bad_request` naming it, and one this token may not use is a `403` raised BEFORE any
      // process exists (H16). Neither decision belongs on this side of the wire.
      return transport.request<ProbeResponse>(
        "POST",
        `/v1/agents/${encodeURIComponent(agentId)}/probe`,
        o ?? {},
        // A cold probe spawns a process and runs a method battery; `probe.timeoutMs` defaults to
        // 90 s on the daemon, which is three times the client's default request deadline.
        { timeoutMs: PROBE_REQUEST_TIMEOUT_MS },
      );
    },

    async workers(): Promise<readonly WorkerSnapshot[]> {
      assertOpen();
      const body = await transport.request<WorkerListResponse>("GET", "/v1/workers");
      return body.workers;
    },

    async attach(workerId: string): Promise<Worker> {
      assertOpen();
      const snapshot = await transport.request<WorkerSnapshot>(
        "GET",
        `/v1/workers/${assertWorkerId(workerId)}`,
      );
      return track(snapshot);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const worker of handles) disposeWorker(worker);
      handles.clear();
      await onClose?.();
    },
  };
}
