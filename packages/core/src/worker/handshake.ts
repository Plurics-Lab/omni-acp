import {
  ACP_V1_VERSION,
  OmniError,
  type AgentCapabilitiesSnapshot,
  type Clock,
  type PromptCapabilities,
  type ResumeMethod,
  type RuntimeDescriptor,
  type SessionId,
  type TimerHandle,
} from "@omni-acp/protocol";
import { DEFAULT_V1_PROFILE } from "../runtime/known.js";
import type { AcpLink } from "../acp/link.js";

export interface HandshakeResult {
  readonly capabilities: AgentCapabilitiesSnapshot;
  readonly sessionId: SessionId;
}

/**
 * The one thing a handshake needs from a transport.
 *
 * `AcpLink` (a `Promise<void>` `closed`, an async `notify`) and `AcpLinkLike` (a boolean
 * `closed`, a sync `notify`) are NOT assignable to one another, and both must be able to run
 * this file: `worker.ts` calls `runHandshake` with the former on M0's path, and
 * `createSessionStrategy` calls the shared body with the latter. `request` is identical in both,
 * and it is the only member either path uses — so it is what the shared body takes.
 */
export type RequestFn = <R = unknown>(method: string, params: unknown) => Promise<R>;

export function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * An OBJECT capability: present and non-null means yes, `{}` included.
 *
 * `=== true` would read every agent that advertises `sessionCapabilities: { close: {} }` — which
 * is claude-acp's actual shape (corpus `07`) — as advertising nothing.
 */
function advertises(caps: Record<string, unknown> | null, key: string): boolean {
  return caps !== null && caps[key] !== undefined && caps[key] !== null;
}

/**
 * One budget for the WHOLE handshake, not one per request.
 *
 * `initialize` and `session/new` are two round trips against the same cold process; charging
 * each of them the full `timeoutMs` would make the worst case twice the number an operator
 * configured, and `POST /v1/workers` holds an HTTP request open for exactly this window (D17).
 *
 * The wake path reuses it for `initialize` + the resume spelling, which is why it is exported:
 * §15.3 gives the whole wake ONE `hibernate.wakeTimeoutMs`, not one per round trip.
 */
export interface Budget {
  race<T>(p: Promise<T>): Promise<T>;
  dispose(): void;
}

export function handshakeBudget(o: {
  timeoutMs: number;
  clock: Clock;
  signal?: AbortSignal;
}): Budget {
  let timer: TimerHandle | null = null;
  let onAbort: (() => void) | null = null;
  let settled = false;

  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (e: OmniError): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };

    if (o.signal?.aborted === true) {
      fail(new OmniError("agent_timeout", "handshake aborted before it started"));
      return;
    }

    timer = o.clock.setTimer(o.timeoutMs, () => {
      fail(
        new OmniError("agent_timeout", `handshake exceeded ${String(o.timeoutMs)}ms`, {
          detail: { timeoutMs: o.timeoutMs },
        }),
      );
    });

    if (o.signal !== undefined) {
      onAbort = (): void => {
        fail(new OmniError("agent_timeout", "handshake aborted"));
      };
      o.signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  // The loser of every race is this promise, and an unobserved rejection is a process-level
  // warning (and a crash under --unhandled-rejections=strict). One permanent sink, here.
  failure.catch(() => {});

  return {
    race<T>(p: Promise<T>): Promise<T> {
      return Promise.race([p, failure]);
    },
    dispose(): void {
      settled = true;
      timer?.cancel();
      timer = null;
      if (onAbort !== null && o.signal !== undefined) {
        o.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    },
  };
}

/** The two spellings M1 knows how to SEND. A descriptor may list others; we drop them. */
const KNOWN_RESUME_METHODS: ReadonlySet<string> = new Set<ResumeMethod>([
  "session/resume",
  "session/load",
]);

function isResumeMethod(m: string): m is ResumeMethod {
  return KNOWN_RESUME_METHODS.has(m);
}

/**
 * The descriptor's preference order over resume spellings, filtered by what THIS agent's
 * `initialize` actually advertised — F18's finding made executable.
 *
 * F18: one claude-acp process implements BOTH `session/resume` (the v2 name) and `session/load`,
 * which is precisely why the descriptor expresses preference order over several spellings rather
 * than one name per capability. The order is the descriptor's; the veto is the agent's.
 *
 * A spelling the descriptor names but M1 cannot send is DROPPED rather than sent blind
 * (`runtime.ts`'s note on `prefer.resume.spellings`): a method we have no params shape for is
 * not a resume, it is a guess.
 */
export function resumeSpellings(
  descriptor: RuntimeDescriptor,
  raw: Readonly<Record<string, unknown>>,
): readonly ResumeMethod[] {
  const sessionCaps = record(raw["sessionCapabilities"]);
  const out: ResumeMethod[] = [];
  for (const spelling of descriptor.prefer["resume"]?.spellings ?? []) {
    if (!isResumeMethod(spelling)) continue;
    if (out.includes(spelling)) continue;
    // v1's own flag for `session/load`, and v2's object capability for `session/resume`. An
    // agent that advertises neither has told us it cannot resume, and §15.2/ruling M1-R15 make
    // that the state in which a worker REFUSES to hibernate rather than one that hibernates and
    // can never wake.
    const advertised =
      spelling === "session/load" ? raw["loadSession"] === true : advertises(sessionCaps, "resume");
    if (advertised) out.push(spelling);
  }
  return out;
}

/** The FIRST spelling both sides agree on, or null. Resolved ONCE at handshake (F18). */
export function resolveResumeMethod(
  descriptor: RuntimeDescriptor,
  raw: Readonly<Record<string, unknown>>,
): ResumeMethod | null {
  return resumeSpellings(descriptor, raw)[0] ?? null;
}

/**
 * `initialize`'s answer, turned into the record `WorkerSnapshot.capabilities` publishes.
 *
 * `raw` is kept VERBATIM and never reshaped: the M1 quirk table and the compat suite both read
 * the real thing, and a rebuilt object would have silently dropped whatever they need.
 */
export function capabilitiesFromInitialize(
  init: Record<string, unknown>,
  descriptor: RuntimeDescriptor,
): AgentCapabilitiesSnapshot {
  const raw = record(init["agentCapabilities"]) ?? {};
  const sessionCaps = record(raw["sessionCapabilities"]);
  const negotiated = init["protocolVersion"];
  const resumeMethod = resolveResumeMethod(descriptor, raw);
  const resumeCap = record(sessionCaps?.["resume"]);
  return {
    protocolVersion: negotiated === 2 ? 2 : 1,
    // Resolved ONCE, from the descriptor's preference order ∩ what this agent advertised (F18).
    resume: {
      method: resumeMethod,
      // Only claimed when the agent's own `sessionCapabilities.resume` says the parameter means
      // something. F18 records claude-acp ACCEPTING `replayFrom` and IGNORING it, which is not a
      // capability — so the honest default is false and we do not send what is ignored.
      replayFrom: resumeCap !== null && resumeCap["replayFrom"] !== undefined,
      // A quirk of the RUNTIME, not of this process: the agent has no field for it, and F15's
      // whole point is that we learn about it from a failure, not from `initialize`.
      requiresSameCwd: descriptor.quirks.resumeRequiresSameCwd,
    },
    supportsSessionList: advertises(sessionCaps, "list"),
    // Filled from `session/new` — or from a resume body, which returns the same shape contrary
    // to the v1 schema (F18, corpus README finding 9).
    configOptions: null,
    modes: null,
    // "Method names the probe or the registry PROVED live". A handshake has proved none: it sent
    // two methods and neither of them is an extension.
    extensions: [],
    raw,
    loadSession: raw["loadSession"] === true,
    promptCapabilities: (record(raw["promptCapabilities"]) as PromptCapabilities | null) ?? null,
    // `SessionCapabilities.close` is an OBJECT capability: present-and-non-null means yes,
    // `{}` included. `=== true` would read every advertising agent as not advertising.
    supportsSessionClose: advertises(sessionCaps, "close"),
  };
}

/**
 * `{sessionId, modes, configOptions}` — the body `session/new` returns, and the body
 * `session/load` / `session/resume` ALSO return, contrary to the v1 schema (F18, corpus README
 * finding 9). One function reads it for all three, which is what "captures modes/configOptions
 * from `session/new` AND from a resume body" means in one place instead of two.
 */
export function withSessionBody(
  capabilities: AgentCapabilitiesSnapshot,
  body: Record<string, unknown> | null,
): AgentCapabilitiesSnapshot {
  if (body === null) return capabilities;
  const configOptions = Array.isArray(body["configOptions"])
    ? (body["configOptions"] as readonly unknown[])
    : null;
  const modes = record(body["modes"]);
  // An ABSENT field leaves what we already knew alone; only a present one overwrites. A resume
  // that answers `{sessionId}` alone must not erase the catalogue `session/new` gave us, because
  // `current_mode_update -> config_option_update` cannot be built without it.
  return {
    ...capabilities,
    configOptions: configOptions ?? capabilities.configOptions,
    modes: modes ?? capabilities.modes,
  };
}

function requireSessionId(body: Record<string, unknown> | null, method: string): SessionId {
  const sessionId = body === null ? undefined : body["sessionId"];
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new OmniError("agent_error", `${method} returned no sessionId`);
  }
  return sessionId as SessionId;
}

export interface HandshakeOptions {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly signal?: AbortSignal;
  /**
   * The RESOLVED quirk table. Absent ⇒ `DEFAULT_V1_PROFILE`, which is the documented fallback
   * (§17.2) and is byte-for-byte M0's behaviour: a v1 profile with zero quirks whose resume
   * preference order is `["session/resume", "session/load"]`.
   */
  readonly descriptor?: RuntimeDescriptor;
  /** Always `[]` in M1 (DESIGN §8 — MCP presets are M2). */
  readonly mcpServers?: readonly unknown[];
}

/**
 * `initialize{protocolVersion: 1, clientCapabilities: {}}` then
 * `session/new{cwd, mcpServers: []}` — always the empty array in M1; MCP presets are M2
 * (DESIGN §8).
 *
 * `clientCapabilities: {}` is D3, and it is a decision rather than an omission: the spec makes
 * an agent responsible for not calling `fs/*` or `terminal/*` it was not offered, every runtime
 * surveyed works under `{}`, and a headless daemon has no editor buffer for those methods to
 * expose in the first place.
 *
 * The tree reclamation on every failure edge belongs to `createWorker`, which is the only caller
 * of the `AcpLink` wrapper below.
 */
export async function performHandshake(
  request: RequestFn,
  o: HandshakeOptions,
): Promise<HandshakeResult> {
  const descriptor = o.descriptor ?? DEFAULT_V1_PROFILE;
  const window = handshakeBudget(o);
  try {
    const initRaw = await window.race(
      request<unknown>("initialize", {
        protocolVersion: ACP_V1_VERSION,
        clientCapabilities: {},
      }),
    );

    const init = record(initRaw);
    if (init === null) {
      throw new OmniError("agent_error", "initialize returned a non-object response");
    }

    assertNegotiated(init["protocolVersion"], descriptor);

    const capabilities = capabilitiesFromInitialize(init, descriptor);

    const created = record(
      await window.race(
        request<unknown>("session/new", {
          cwd: o.cwd,
          mcpServers: o.mcpServers === undefined ? [] : [...o.mcpServers],
        }),
      ),
    );

    return {
      // `session/new` carries `modes` and `configOptions` on claude-acp (corpus `07`), and the
      // v1 schema does not model them — so they are read off the body here rather than guessed.
      capabilities: withSessionBody(capabilities, created),
      sessionId: requireSessionId(created, "session/new"),
    };
  } catch (e) {
    // `agent_error` is the fallback rather than `internal`: everything reachable here came back
    // from — or died with — the agent process, and §2.1 H5 maps that to 502. `OmniError.from`
    // still routes an `acp.RequestError` to `agent_error` WITH its `acp` body, and an
    // abort/timeout to `agent_timeout` (504), which is the 502/504 split H5 asks for.
    throw OmniError.from(e, "agent_error");
  } finally {
    window.dispose();
  }
}

/**
 * The version check, now descriptor-driven (M1-PLAN WP-C acceptance 10).
 *
 * M0 hard-coded `negotiated !== 1`. The rule it was expressing is "an agent that has not agreed
 * to speak the dialect the Normalizer is written against must not put un-mappable frames into
 * the canonical log" — and WHICH dialect that is, is the descriptor's to say. For
 * `DEFAULT_V1_PROFILE` (`protocolVersion: 1`) this is byte-for-byte M0's behaviour, message
 * included; a v2 profile accepts 2 without a code change, which is the point of a descriptor.
 */
export function assertNegotiated(negotiated: unknown, descriptor: RuntimeDescriptor): void {
  if (negotiated === descriptor.protocolVersion) return;
  throw new OmniError(
    "agent_error",
    `agent negotiated ACP protocol version ${String(negotiated)}; ` +
      `runtime ${descriptor.id} speaks ${String(descriptor.protocolVersion)}`,
    { detail: { negotiated, expected: descriptor.protocolVersion, runtime: descriptor.id } },
  );
}

/**
 * M0's entry point, kept exactly as `worker.ts` (frozen) calls it.
 *
 * It is a two-line adapter onto `performHandshake` because `AcpLink` and `AcpLinkLike` differ in
 * `notify` and `closed` and agree only on `request` — see `RequestFn`.
 */
export function runHandshake(
  link: AcpLink,
  o: { cwd: string; timeoutMs: number; clock: Clock; signal?: AbortSignal },
): Promise<HandshakeResult> {
  return performHandshake((method, params) => link.request(method, params), o);
}
