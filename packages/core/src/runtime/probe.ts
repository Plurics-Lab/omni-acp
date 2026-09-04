import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACP_V1_VERSION,
  AcpRequestError,
  OmniError,
  type AgentProcess,
  type Clock,
  type Logger,
  type MethodVerdict,
  type ProbeSummary,
  type ResolvedProbeConfig,
  type ResumeMethod,
  type RuntimeDescriptor,
  type SpawnSpec,
  type Supervisor,
  type TimerHandle,
} from "@omni-acp/protocol";
import { openAcpLink, type AcpLink } from "../acp/link.js";
import { classifyProbe, verdictImpliesSupport } from "./classify.js";

export interface ProbeOptions {
  readonly agentId: string;
  readonly spec: SpawnSpec;
  readonly descriptor: RuntimeDescriptor;
  readonly config: ResolvedProbeConfig;
  /**
   * The ONE spawn site a probe may use (F10): `Supervisor.spawn`, never `node:child_process`.
   * The `no-direct-spawn` guard is extended to this file by M1-WP-C.
   */
  readonly supervisor: Supervisor;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly signal?: AbortSignal;
  /**
   * The fingerprint this summary is a claim ABOUT (§17.2). Supplied rather than computed here:
   * it is a hash over the `AgentDescriptor` — command ⊕ args ⊕ version — which the Agent Catalog
   * owns and this function never sees. Absent ⇒ the `unresolved` sentinel, never a fabrication.
   */
  readonly fingerprint?: string;
}

/**
 * One battery entry: a method, the params to send, and why sending THOSE params is safe.
 *
 * The rule §17.4 states is "side-effect-free", and the way this battery keeps it is that every
 * VALUE-BEARING parameter is either omitted or a sentinel that cannot name a real thing. The
 * agent's own error is what teaches us the method exists — corpus 08 id 7 is the whole design:
 * `session/set_config_option` with the WRONG param name answers `-32602` with
 * `data.configId._errors`, which proves the method exists AND names the parameter, and changes
 * nothing on the other side.
 */
interface BatteryEntry {
  readonly method: string;
  readonly params: (sessionId: string) => Record<string, unknown>;
}

/** A value no agent can have: it is the probe's own namespace and it is not a real id. */
const SENTINEL = "omni-probe-nonexistent";

/**
 * The control method. Corpus 08 id 13 sent exactly this shape and got the uniform
 * `-32601 + data.method`, which is what lets a probe assert "this agent's unknown-method answer
 * is the one the descriptor claims" rather than assuming it.
 */
const CONTROL_METHOD = "omni/definitely_unknown_method";

const BATTERY: readonly BatteryEntry[] = [
  // `-32601` on 0.73.0 (corpus 08, ids 3 and 4). A sentinel modelId cannot select a real model,
  // so an adapter that DOES implement it answers "no such model" rather than switching one.
  { method: "session/set_model", params: (sessionId) => ({ sessionId, modelId: SENTINEL }) },
  // `-32601` on 0.73.0 (corpus 08, id 5). An EMPTY options object sets nothing.
  { method: "session/set_options", params: (sessionId) => ({ sessionId, options: {} }) },
  // Implemented on 0.73.0 and it CHANGES THE MODE when given one, so the probe omits `modeId`:
  // the `-32602` that comes back proves existence and names the parameter, and the session's
  // mode is untouched. Corpus 08 id 6 sent a real modeId; a probe must not.
  { method: "session/set_mode", params: (sessionId) => ({ sessionId }) },
  // THE row §17.4 exists for (F17, corpus 08 id 7): the deliberately WRONG param name learns
  // `configId` from `-32602 data.configId._errors` while setting nothing.
  //
  // `value` is sent, and sending it is load-bearing. Corpus 08 id 7 sent `{optionId, value}` and
  // got back ONE flagged field, `configId`. Omitting `value` makes the live 0.73.0 agent flag
  // `value` and `type` as well — verified against the real agent on 2026-09-04 — and
  // `learnedParams` would then record the first of three fields instead of the one that answers
  // "what is this parameter called". The probe supplies everything it CAN so that the only gap
  // in the request is the gap it is asking about; `configId` is still absent, so nothing is set.
  {
    method: "session/set_config_option",
    params: (sessionId) => ({ sessionId, optionId: SENTINEL, value: SENTINEL }),
  },
  // Read-only (corpus 08, id 10). The result is counted, never recorded: `session/list` returns
  // other sessions' cwds and titles, and a `ProbeSummary` served by `GET /v1/agents` is readable
  // by every bearer token on the daemon.
  { method: "session/list", params: () => ({}) },
  // Resume spellings. `cwd` is omitted ON PURPOSE: with it, this RESUMES the session and makes
  // the agent replay its whole history at us for nothing. Without it the answer is `-32602`,
  // which proves existence just as well and costs one frame. `mcpServers: []` IS sent, on the
  // same rule as `value` above — the live agent flags it as missing otherwise, and a hint list
  // should name the field we withheld rather than the ones we forgot.
  { method: "session/resume", params: (sessionId) => ({ sessionId, mcpServers: [] }) },
  { method: "session/load", params: (sessionId) => ({ sessionId, mcpServers: [] }) },
  // The control, last before teardown.
  { method: CONTROL_METHOD, params: (sessionId) => ({ sessionId }) },
];

/** The resume spellings, in the order the descriptor prefers them, narrowed to the two we know. */
function resumeCandidates(d: RuntimeDescriptor): readonly ResumeMethod[] {
  const known: readonly string[] = ["session/resume", "session/load"];
  const preferred = (d.prefer["resume"]?.spellings ?? []).filter((s) => known.includes(s));
  // A descriptor that names neither still gets both tried: the probe's job is to find out, and
  // "the descriptor did not say" is not evidence that the agent cannot.
  const ordered = preferred.length > 0 ? preferred : known;
  return ordered as readonly ResumeMethod[];
}

/**
 * One deadline for the WHOLE probe, not one per call — the same rule `runHandshake` uses and for
 * the same reason: a battery of ten calls each allowed `timeoutMs` would make the worst case ten
 * times the number an operator configured, while `POST /v1/agents/{id}/probe` holds one HTTP
 * request open for exactly this window.
 */
function deadline(o: { timeoutMs: number; clock: Clock; signal?: AbortSignal }): {
  race<T>(p: Promise<T>): Promise<T>;
  expired(): boolean;
  dispose(): void;
} {
  let timer: TimerHandle | null = null;
  let onAbort: (() => void) | null = null;
  let done = false;
  let blown = false;

  const failure = new Promise<never>((_resolve, reject) => {
    const fail = (e: OmniError): void => {
      if (done) return;
      done = true;
      blown = true;
      reject(e);
    };
    if (o.signal?.aborted === true) {
      fail(new OmniError("agent_timeout", "probe aborted before it started"));
      return;
    }
    timer = o.clock.setTimer(o.timeoutMs, () => {
      fail(new OmniError("agent_timeout", `probe exceeded ${String(o.timeoutMs)}ms`));
    });
    if (o.signal !== undefined) {
      onAbort = (): void => {
        fail(new OmniError("agent_timeout", "probe aborted"));
      };
      o.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  // The loser of every race is this promise; one permanent sink so an unobserved rejection can
  // never become a process-level warning.
  failure.catch(() => {});

  return {
    race: <T>(p: Promise<T>): Promise<T> => Promise.race([p, failure]),
    expired: () => blown,
    dispose: (): void => {
      done = true;
      timer?.cancel();
      timer = null;
      if (onAbort !== null && o.signal !== undefined) {
        o.signal.removeEventListener("abort", onAbort);
        onAbort = null;
      }
    },
  };
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * ONE throwaway process: `initialize`, and when `deep` also `session/new` in a `mkdtemp` cwd plus
 * the side-effect-free method battery (CONTRACTS.md §17.4, H16). Reclaims the tree on every edge
 * and leaves no temp directory behind. Costs ~0 tokens — corpus `08` ran 11 probes and no prompt.
 *
 * Four operability guarantees live in this function, and each has a test:
 *
 *  - **Not a spawn back door.** Through `Supervisor.spawn` and the `SpawnSpec` the Catalog
 *    produced (F10); `no-direct-spawn` stays green, and Windows gets §6.3's `bad_request` naming
 *    `process.execPath <module>` rather than an `EINVAL` from a `.cmd` shim, because the probe
 *    goes through the same `resolveLaunch`.
 *  - **The cwd is a `mkdtemp`, removed afterwards.** Never the caller's cwd, so a probe cannot
 *    mutate a workspace — and it is created HERE rather than by the service, so the "leaves no
 *    temp dir" guarantee and the code that could break it are the same lines.
 *  - **The battery never answers a permission request** and never sends `allow_always`: the
 *    inbound handler refuses with `-32601`, which is DESIGN §6.2's "don't leave the agent
 *    hanging" without granting anything.
 *  - **Reclaims its tree on every edge** (H5's rule): the `finally` runs on success, on a blown
 *    deadline, on an abort and on a spawn that came up and then died.
 *
 * Owned by M1-WP-E.
 */
export async function probeAgent(o: ProbeOptions): Promise<ProbeSummary> {
  const logger = o.logger.child({ mod: "probe", agent: o.agentId });
  const startedAtMs = o.clock.now();
  const timings: Record<string, number> = {};

  // A `mkdtemp` under the OS temp dir, used as BOTH the process cwd and the `session/new` cwd.
  // §17.4: never the caller's cwd. It is removed in the `finally`, on every edge.
  const workspace = await mkdtemp(join(tmpdir(), `omni-probe-${o.agentId.slice(0, 24)}-`));

  const window = deadline({ timeoutMs: o.config.timeoutMs, clock: o.clock, signal: o.signal });
  let proc: AgentProcess | null = null;
  let link: AcpLink | null = null;
  /**
   * Unprompted `session/update` notifications seen during the probe. Corpus 08 shows three
   * `available_commands_update`s arriving during the battery alone. Counted per PROBE — a
   * module-level counter would be shared by two concurrent probes of two different agents.
   */
  let updates = 0;

  const measure = async <T>(label: string, work: Promise<T>): Promise<T> => {
    const at = o.clock.now();
    try {
      return await window.race(work);
    } finally {
      timings[label] = o.clock.now() - at;
    }
  };

  try {
    proc = await window.race(o.supervisor.spawn({ ...o.spec, cwd: workspace }, o.signal));

    link = openAcpLink(
      proc.stream,
      {
        // Updates during a probe are noise we are not paid to interpret: `available_commands_update`
        // arrives unprompted (corpus 08 shows three of them during the battery alone). Counting
        // them is the only honest thing to do with them here.
        onSessionUpdate: () => {
          updates += 1;
        },
        // §17.4: the battery NEVER sends a permission answer and never `allow_always`. Refusing
        // with a JSON-RPC error is DESIGN §6.2's rule — do not leave the agent waiting — while
        // granting nothing. A probe that answered a permission request would be a probe that can
        // change the disk.
        onPermissionRequest: () =>
          Promise.reject(
            new AcpRequestError(-32601, "omni-acp probe does not answer permission requests"),
          ),
        onClosed: () => {},
      },
      { logger },
    );

    const initRaw = await measure(
      "initialize",
      link.request<unknown>("initialize", {
        protocolVersion: ACP_V1_VERSION,
        clientCapabilities: {},
      }),
    );
    const init = record(initRaw) ?? {};
    const protocolVersion =
      typeof init["protocolVersion"] === "number" ? init["protocolVersion"] : ACP_V1_VERSION;
    const agentInfo = record(init["agentInfo"]);
    const capabilities = record(init["agentCapabilities"]) ?? {};

    const verdicts = new Map<string, MethodVerdict>();
    let sessionId: string | null = null;

    if (o.config.deep) {
      const newRaw = await measure(
        "session/new",
        link.request<unknown>("session/new", { cwd: workspace, mcpServers: [] }),
      );
      const created = record(newRaw);
      const id = created?.["sessionId"];
      sessionId = typeof id === "string" && id.length > 0 ? id : null;
      if (sessionId === null) {
        // Not fatal: `initialize` already told us the protocol version and the capability block,
        // which is what a shallow probe returns. Everything the battery would have learned is
        // recorded as `skipped` with the reason, so the gap is visible instead of implied.
        logger.warn("probe: session/new returned no sessionId; skipping the method battery");
      }
    }

    if (sessionId !== null) {
      for (const entry of BATTERY) {
        const at = o.clock.now();
        try {
          const result = await window.race(
            link.request<unknown>(entry.method, entry.params(sessionId)),
          );
          verdicts.set(entry.method, classifyProbe({ result }));
        } catch (e) {
          if (window.expired()) throw e;
          verdicts.set(entry.method, classifyProbe(e));
        }
        timings[entry.method] = o.clock.now() - at;
      }

      // The teardown IS the `close` probe: we have to end the throwaway session anyway, and
      // asking twice would be a second round trip to learn what the first one already answered.
      // A failure here is data, never a reason to fail the probe — the process is about to be
      // terminated regardless.
      const at = o.clock.now();
      try {
        const result = await window.race(link.request<unknown>("session/close", { sessionId }));
        verdicts.set("session/close", classifyProbe({ result }));
      } catch (e) {
        if (window.expired()) throw e;
        verdicts.set("session/close", classifyProbe(e));
      }
      timings["session/close"] = o.clock.now() - at;
    } else {
      const reason = o.config.deep ? "session/new produced no sessionId" : "probe.deep is false";
      for (const entry of BATTERY) verdicts.set(entry.method, { kind: "skipped", reason });
      verdicts.set("session/close", { kind: "skipped", reason });
    }

    const supportedMethods: string[] = [];
    const unsupportedMethods: string[] = [];
    const learnedParams: Record<string, string> = {};
    for (const [method, verdict] of verdicts) {
      if (verdict.kind === "not_implemented") unsupportedMethods.push(method);
      else if (verdictImpliesSupport(verdict)) supportedMethods.push(method);
      if (verdict.kind === "implemented_other_params") {
        const first = verdict.hints[0];
        // The first hint, not all of them: `learnedParams` is `Record<string,string>` and the
        // question it answers is "what is this method's parameter called". A method that named
        // two is reported by its first, and the raw verdicts are not part of the summary shape.
        if (first !== undefined) learnedParams[method] = first;
      }
    }

    // The control method must be `-32601`; if this adapter answers something ELSE to a method
    // nobody implements, the descriptor's `unknownMethodErrorCode` is wrong for it and every
    // "is this implemented?" verdict below is suspect. Say so rather than reporting it as a
    // supported method.
    const control = verdicts.get(CONTROL_METHOD);
    if (control !== undefined && control.kind !== "not_implemented" && control.kind !== "skipped") {
      logger.warn("probe: the control method did not answer 'method not found'", {
        verdict: control.kind,
        expected: o.descriptor.quirks.unknownMethodErrorCode,
      });
    }
    // The control is an instrument, not a capability: it must never appear in either list.
    const isReal = (m: string): boolean => m !== CONTROL_METHOD;

    const resumeMethod =
      resumeCandidates(o.descriptor).find((m) => supportedMethods.includes(m)) ?? null;

    timings["total"] = o.clock.now() - startedAtMs;

    return {
      at: o.clock.iso(),
      agentId: o.agentId,
      descriptorFingerprint: o.fingerprint ?? "unresolved",
      protocolVersion,
      agentInfo,
      capabilities,
      unsupportedMethods: unsupportedMethods.filter(isReal),
      supportedMethods: supportedMethods.filter(isReal),
      resumeMethod,
      learnedParams,
      timings,
    };
  } finally {
    logger.debug("probe finished", { updates, workspace });
    window.dispose();
    link?.close();
    if (proc !== null) {
      // H5: the tree is reclaimed on EVERY edge, forced, and a failure to reclaim must not mask
      // the failure that brought us here. `terminate` never rejects in practice; the catch is
      // what makes that a property of this function rather than a hope about that one.
      await proc.terminate({ force: true }).catch((e: unknown) => {
        logger.warn("probe: reclaiming the process tree failed", { error: String(e) });
        return null;
      });
    }
    // The workspace is a `mkdtemp` this function created; `force` so a probe that never got as
    // far as creating a file still cleans up, and a failure here is logged rather than thrown —
    // a leaked temp dir must not turn a successful probe into a 500.
    await rm(workspace, { recursive: true, force: true }).catch((e: unknown) => {
      logger.warn("probe: removing the temporary workspace failed", {
        workspace,
        error: String(e),
      });
    });
  }
}
