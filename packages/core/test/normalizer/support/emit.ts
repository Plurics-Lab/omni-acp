import { createBaselineResponder, createNormalizer } from "@omni-acp/core";
import { loadTranscript } from "@omni-acp/testkit";
import type {
  Clock,
  DaemonId,
  EventEnvelope,
  EventInput,
  RuntimeDescriptor,
  SessionId,
  TimerHandle,
  TurnId,
  TurnInput,
  WorkerId,
} from "@omni-acp/protocol";
import { mapPermissionRequest } from "../../../src/normalizer/map/permission.js";
import { claudeAcpDescriptor } from "./claude-acp.js";

/**
 * The corpus → envelope generator behind `corpus-golden.test.ts` (CONTRACTS.md §12.7(c)).
 *
 * It walks one recorded transcript IN WIRE ORDER through the real `Normalizer` and the real
 * baseline responder, and stamps the envelopes an `EventLog` would have stamped — so the
 * generated file is what a worker's log would actually hold for that scenario, and the ordering
 * assertions §12.8 makes (a `usage_update` that arrived AFTER our `session/cancel` and BEFORE the
 * prompt response must have a lower `seq` than `idle`) are about the recorded timing rather than
 * about the order the generator happened to choose.
 *
 * Everything is deterministic — fixed ids, `ts` derived from `seq` — because a generator whose
 * output changed run to run could not be `--check`ed.
 *
 * What it does NOT generate: the `.expected.json` beside it. Generating those would make the
 * tier tautological (§12.7(c)), so they are hand-written from the recorded wire.
 */

export const GOLDEN_DAEMON = "d_00000000000000000000000001" as DaemonId;
export const GOLDEN_WORKER = "w_00000000000000000000000001" as WorkerId;
export const GOLDEN_TURN = "t_00000000000000000000000001" as TurnId;
export const GOLDEN_SESSION = "sess-corpus" as SessionId;
const T0 = Date.UTC(2026, 0, 1);

/**
 * The scenarios that get a generated envelope golden.
 *
 * §12.7(c) asks for six; eight are generated, because §12.8 names eight cases and a case whose
 * envelopes are not checked in cannot be a golden. `08-set-model-extension` is the ninth and has
 * no turn at all — it is 11 probe calls and no `session/prompt` — so it belongs to the probe's
 * suite (M1-WP-E), not to a turn projection.
 */
export const GOLDEN_SCENARIOS: readonly {
  readonly name: string;
  /**
   * The mode the RECORDER answered permission requests in, so the generated log carries the
   * `omni.policy_decision` the recorded run actually produced. Anything else would make the
   * tool statuses in the transcript unexplainable by the envelopes beside them.
   */
  readonly responder: "allow" | "deny";
  /** The session cwd, so a reconstructed vendor patch names paths git can apply. */
  readonly cwd?: string;
}[] = [
  // Each `cwd` is the one the recorder actually passed to `session/new` (or `session/load`).
  { name: "01-plain-answer", responder: "allow", cwd: "/tmp/acp-ws-plain-Jog3o2" },
  { name: "02-tool-read", responder: "allow", cwd: "/tmp/acp-ws-read-asP79Z" },
  { name: "03-tool-write-allowed", responder: "allow", cwd: "/tmp/acp-ws-wa-VxS6ru" },
  { name: "04-tool-write-denied", responder: "deny", cwd: "/tmp/acp-ws-wd-G9y7rN" },
  { name: "06-cancel-mid-turn", responder: "allow", cwd: "/tmp/acp-ws-cancel-aqoi9f" },
  { name: "07-session-load", responder: "allow", cwd: "/tmp/acp-ws-plain-Jog3o2" },
  { name: "09-permission-bad-option-id", responder: "allow", cwd: "/tmp/acp-ws-wa-GWOIjS" },
  { name: "10-tool-edit-existing", responder: "allow", cwd: "/tmp/acp-ws-edit-96xAuv" },
];

export function goldenNames(): readonly string[] {
  return GOLDEN_SCENARIOS.map((s) => s.name);
}

/** A clock that is a pure function of the transcript's own `tMs`. */
function transcriptClock(): Clock & { at(ms: number): void } {
  let now = T0;
  return {
    now: () => now,
    iso: () => new Date(now).toISOString(),
    setTimer: (): TimerHandle => ({ cancel: () => {} }),
    at(ms: number): void {
      now = T0 + Math.round(ms);
    },
  };
}

interface WireMessage {
  readonly method?: unknown;
  readonly id?: unknown;
  readonly params?: { readonly update?: unknown };
  readonly result?: { readonly stopReason?: unknown; readonly usage?: unknown };
}

/** The methods whose request→response window is D6's replay window (F16). */
const RESUME_METHODS: ReadonlySet<string> = new Set(["session/load", "session/resume"]);

export function emitScenario(name: string, descriptor?: RuntimeDescriptor): EventEnvelope[] {
  const scenario = GOLDEN_SCENARIOS.find((s) => s.name === name);
  if (scenario === undefined) throw new Error(`unknown golden scenario: ${name}`);
  const runtime = descriptor ?? claudeAcpDescriptor();

  const clock = transcriptClock();
  const norm = createNormalizer({
    quietMs: 250,
    hardMs: 5_000,
    descriptor: runtime,
    ...(scenario.cwd === undefined ? {} : { cwd: scenario.cwd }),
  });
  const responder = createBaselineResponder(scenario.responder, clock);

  const out: EventEnvelope[] = [];
  let seq = 0;
  const append = (e: EventInput): void => {
    seq += 1;
    out.push({
      seq,
      // Derived from `seq`, so the file is byte-stable: a wall clock would make `--check` fail
      // on every run for a reason that has nothing to do with the map.
      ts: new Date(T0 + seq).toISOString(),
      daemonId: GOLDEN_DAEMON,
      workerId: GOLDEN_WORKER,
      sessionId: GOLDEN_SESSION,
      turnId: e.turnId ?? null,
      payloadVersion: e.payloadVersion,
      ...(e.replay === undefined ? {} : { replay: e.replay }),
      kind: e.kind,
      payload: e.payload,
    } as EventEnvelope);
  };
  const step = (input: TurnInput): void => {
    for (const e of norm.step(input).emit) append(e);
  };

  const lines = loadTranscript(name);
  // D6's replay window is the WORKER's, and F16 fixes it at request-to-response. It is computed
  // from the transcript here rather than counted by hand, so a transcript that changed would
  // move the window with it.
  let resumeRequestId: unknown = null;
  let replaying = false;
  let started = false;
  let ended = false;
  let requestOrdinal = 0;

  for (const line of lines) {
    clock.at(line.tMs);
    const msg = line.msg as WireMessage | undefined;
    if (msg === undefined) continue;

    if (line.dir === "client->agent") {
      const method = typeof msg.method === "string" ? msg.method : "";
      if (RESUME_METHODS.has(method)) {
        resumeRequestId = msg.id;
        replaying = true;
      }
      if (method === "session/prompt") {
        started = true;
        step({ type: "prompt_sent", turnId: GOLDEN_TURN, at: clock.now() });
      }
      continue;
    }
    if (line.dir !== "agent->client") continue;

    if (msg.method === "session/update") {
      step({
        type: "agent_update",
        update: msg.params?.update,
        at: clock.now(),
        ...(replaying ? { replay: true as const } : {}),
      });
      continue;
    }

    if (msg.method === "session/request_permission") {
      // Ruling M1-R14: the responder sees the V2-MAPPED request. The two envelopes and their
      // order are §7.4's, verbatim — `acp.interaction` keeps the raw request for audit and
      // `omni.policy_decision` is the one `reduceTurn` folds.
      requestOrdinal += 1;
      const raw = (line.msg as { params?: Record<string, unknown> }).params ?? {};
      const decision = responder.decide(mapPermissionRequest(raw, runtime));
      append({
        kind: "acp.interaction",
        payloadVersion: 1,
        turnId: started && !ended ? GOLDEN_TURN : null,
        payload: {
          requestId: `perm_${String(requestOrdinal)}`,
          method: "session/request_permission",
          request: raw,
          status: decision.response === null ? "failed" : "answered",
          answer: { optionId: decision.record.optionId, by: "baseline" },
        },
      });
      append({
        kind: "omni.policy_decision",
        payloadVersion: 2,
        turnId: started && !ended ? GOLDEN_TURN : null,
        // The synthesized `requestId` is made deterministic here; everything else is the
        // responder's own record, including the `toolCallId` join §13.4 needs.
        payload: { ...decision.record, requestId: `perm_${String(requestOrdinal)}` },
      });
      continue;
    }

    if (msg.result !== undefined) {
      if (msg.id === resumeRequestId) replaying = false;
      const stopReason = msg.result.stopReason;
      if (typeof stopReason === "string" && started && !ended) {
        ended = true;
        step({
          type: "prompt_result",
          stopReason,
          at: clock.now(),
          ...(msg.result.usage === undefined ? {} : { usage: msg.result.usage }),
        });
      }
    }
  }

  // The quiet window expires: the Worker's timer fires at the deadline the reducer asked for.
  clock.at((lines.at(-1)?.tMs ?? 0) + 250);
  step({ type: "tick", at: clock.now() });
  return out;
}
