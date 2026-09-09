import {
  AcpRequestError,
  OmniError,
  type AcpErrorDetail,
  type AcpLinkLike,
  type AgentCapabilitiesSnapshot,
  type Clock,
  type Logger,
  type ResumeAttempt,
  type ResumeMethod,
  type ResumeReport,
  type RuntimeDescriptor,
  type SessionId,
  type SessionOpenOptions,
  type SessionOpenResult,
  type SessionReopenOptions,
  type SessionStrategy,
} from "@omni-acp/protocol";
import {
  assertNegotiated,
  capabilitiesFromInitialize,
  handshakeBudget,
  performHandshake,
  record,
  resumeSpellings,
  withSessionBody,
  type Budget,
  type RequestFn,
} from "./handshake.js";
import { classifyResume } from "./resume-classify.js";
import { attemptResume } from "./resume.js";

/**
 * SEAM 2 (M1-PLAN §1.2). After M1, `Worker` never names `initialize`, `session/new`,
 * `session/load` or `session/resume` again: it holds a `SessionStrategy` and calls `open()` on
 * create and `reopen()` on wake.
 *
 * That is what lets the resume work package and the daemon work package own disjoint files while
 * `worker.ts` is edited exactly ONCE, by the Land step, and then frozen.
 *
 * Owned by M1-WP-C.
 */

/** What the replay window observed, for `ResumeReport`'s audit fields (ruling M1-R5). */
export interface ReplayCounts {
  readonly events: number;
  readonly dropped: number;
}

/**
 * How many `session/update` notifications arrived inside the replay window, and how many were
 * dropped before `append()` under `resume.replay: "drop_duplicates"`.
 *
 * It cannot be observed HERE: a `SessionStrategy` is handed an `AcpLinkLike` — `request`,
 * `notify`, `closed` — while notifications are routed by the Worker, which the strategy cannot
 * see. So the count arrives from outside, by either of two routes, and `countsFor` below picks:
 *
 *  1. `SessionReopenOptions.controls.replayCounts()`, which `worker.ts` supplies as an extra
 *     member beyond the frozen `{replayWindow()}` declaration. This is the production path.
 *  2. `SessionStrategyOptions.replayMeter`, for a caller that has its own source (a test, or an
 *     embedder driving `reopen` directly).
 *
 * Neither present ⇒ both numbers are 0, which `ResumeReport` reports honestly rather than
 * inventing a figure.
 */
export interface ReplayMeter {
  /** Called once, when the wake begins. The returned reader may be called repeatedly. */
  begin(): () => ReplayCounts;
}

const ZERO_COUNTS: ReplayCounts = { events: 0, dropped: 0 };
const ZERO_METER: ReplayMeter = { begin: () => () => ZERO_COUNTS };

/** The extra member `worker.ts` puts on `controls`; absent on a hand-rolled `SessionReopenOptions`. */
interface CountingControls {
  replayCounts(): ReplayCounts;
}

/**
 * The reader for ONE wake, as a DELTA.
 *
 * The Worker's counter is cumulative for the worker's whole life — a second wake must not report
 * the first one's replay as its own — so the baseline is taken here, when the wake begins, and
 * every read subtracts it.
 */
function countsFor(
  controls: SessionReopenOptions["controls"],
  fallback: ReplayMeter,
): () => ReplayCounts {
  const live = (controls as Partial<CountingControls>).replayCounts;
  if (typeof live !== "function") return fallback.begin();
  const from = live.call(controls);
  return () => {
    const now = live.call(controls);
    return { events: now.events - from.events, dropped: now.dropped - from.dropped };
  };
}

export interface SessionStrategyOptions {
  readonly descriptor: RuntimeDescriptor;
  readonly clock: Clock;
  readonly logger: Logger;
  /** See `ReplayMeter`. Absent ⇒ both counts are reported as 0. */
  readonly replayMeter?: ReplayMeter;
}

/** One spelling's raw result. NEVER an exception: the classifier decides what a failure means. */
interface RawAttempt {
  readonly method: ResumeMethod;
  readonly body: Record<string, unknown> | null;
  readonly acp: AcpErrorDetail | null;
  readonly transportFailed: boolean;
  readonly timedOut: boolean;
}

/** The JSON-RPC error behind a rejection, or null when there was no JSON-RPC answer at all. */
function acpErrorOf(e: unknown): AcpErrorDetail | null {
  if (e instanceof AcpRequestError) {
    return e.data === undefined
      ? { code: e.code, message: e.message }
      : { code: e.code, message: e.message, data: e.data };
  }
  if (e instanceof OmniError && e.acp !== undefined) return e.acp;
  return null;
}

function isTimeout(e: unknown): boolean {
  return e instanceof OmniError && e.code === "agent_timeout";
}

/** True when the agent ANSWERED — a body, or a JSON-RPC error — as opposed to silence. */
function answered(report: ResumeReport): boolean {
  return report.hint !== "transport" && report.hint !== "timeout";
}

export function createSessionStrategy(o: SessionStrategyOptions): SessionStrategy {
  const logger = o.logger.child({ component: "session-strategy" });
  const meter = o.replayMeter ?? ZERO_METER;

  /**
   * The descriptor in force for ONE call.
   *
   * `SessionOpenOptions.descriptor` is the WORKER's resolved table (builtin ⊕ config ⊕ probe,
   * §17.2), so it wins; the strategy's own is the fallback for a caller that has only one.
   */
  const descriptorFor = (call: { descriptor?: RuntimeDescriptor }): RuntimeDescriptor =>
    call.descriptor ?? o.descriptor;

  const request =
    (link: AcpLinkLike): RequestFn =>
    (method, params) =>
      link.request(method, params);

  /**
   * §15.3 step 6 for ONE spelling: send it inside the replay window and bring back the raw
   * material. It never throws — every failure edge becomes a `RawAttempt`, because the
   * four-state classification is what decides whether a failure is fatal, and a `throw` here
   * would decide that with a `try`/`catch` instead.
   *
   * On a lost `budget.race` the request is still in flight, so `attemptResume`'s `finally` — and
   * with it the replay window — closes when the request finally settles rather than now. That is
   * correct and not a leak: `worker.ts` reclaims the process on every failed wake, which closes
   * the link and rejects the pending request; and the Worker's own refcounted window closes in
   * its own `finally` regardless, so no LIVE turn can be marked as replay in the meantime.
   */
  const sendOne = async (
    link: AcpLinkLike,
    method: ResumeMethod,
    call: SessionReopenOptions,
    budget: Budget,
  ): Promise<RawAttempt> => {
    try {
      const raw = await budget.race(attemptResume(link, method, call.sessionId, call));
      return { method, body: record(raw), acp: null, transportFailed: false, timedOut: false };
    } catch (e) {
      const acp = acpErrorOf(e);
      const timedOut = isTimeout(e);
      return {
        method,
        body: null,
        acp,
        // §7.3, and rule 0: a rejection with NO JSON-RPC code is a dead transport, and a dead
        // transport says nothing at all about the session.
        transportFailed: acp === null && !timedOut,
        timedOut,
      };
    }
  };

  return {
    async open(link: AcpLinkLike, call: SessionOpenOptions): Promise<SessionOpenResult> {
      const { capabilities, sessionId } = await performHandshake(request(link), {
        cwd: call.cwd,
        timeoutMs: call.budgetMs,
        clock: o.clock,
        descriptor: descriptorFor(call),
        mcpServers: call.mcpServers,
        // M2-A, D10 (§5.8.8). One value, computed by `clientCapabilitiesFor()` and threaded
        // through — the CREATE half. The WAKE half below still hard-codes `{}`, and that is
        // F42: the two copies drift, a `park` worker that hibernates and wakes silently stops
        // declaring elicitation, and F28 says the agent then asks in prose instead. M2-A-WP-I
        // owns this file from the Land commit on, and its acceptance bullet 2 is a named
        // regression test written FIRST, against the literal on line 251 below.
        ...(call.clientCapabilities === undefined
          ? {}
          : { clientCapabilities: call.clientCapabilities }),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      // `resume: null`, never a fabricated `landed`: D2's four states describe a RESUME, and a
      // freshly created session has no resume verdict to report.
      return { capabilities, sessionId, resume: null };
    },

    async reopen(link: AcpLinkLike, call: SessionReopenOptions): Promise<SessionOpenResult> {
      const descriptor = descriptorFor(call);
      const quirks = descriptor.quirks;
      // ONE budget for the whole wake — spawn is the Worker's, `initialize` and every resume
      // spelling are ours — because §15.3 gives a wake one `hibernate.wakeTimeoutMs`, and a
      // per-round-trip budget makes the worst case a multiple of the configured number.
      const budget = handshakeBudget({
        timeoutMs: call.budgetMs,
        clock: o.clock,
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      });
      const startedAt = o.clock.now();
      const readCounts = countsFor(call.controls, meter);

      const reportFor = (attempt: RawAttempt | null, capabilityAdvertised: boolean): ResumeReport =>
        classifyResume({
          method: attempt?.method ?? null,
          requested: call.sessionId,
          returned:
            typeof attempt?.body?.["sessionId"] === "string"
              ? (attempt.body["sessionId"] as SessionId)
              : null,
          acp: attempt?.acp ?? null,
          transportFailed: attempt?.transportFailed ?? false,
          timedOut: attempt?.timedOut ?? false,
          replayedEvents: readCounts().events,
          replayDropped: readCounts().dropped,
          capabilityAdvertised,
          requiresSameCwd: quirks.resumeRequiresSameCwd,
          // §15.4 rule 6's input, live now that `ResumeAttempt` carries the field: a runtime
          // that silently creates cannot report a `landed` from a bare success.
          silentlyCreates: quirks.resumeSilentlyCreates,
          // We only ever reopen at the worker's OWN cwd, so from this side the cwd never moves.
          // F15's failure is the agent disagreeing with us about it, which rule 4 diagnoses from
          // the error's shape and not from this flag.
          cwdChanged: false,
          durationMs: o.clock.now() - startedAt,
          at: o.clock.iso(),
        } satisfies ResumeAttempt);

      // F42, FIXED (M2-A-WP-I). `clientCapabilities: {}` used to be hard-coded HERE as well as in
      // `handshake.ts`, so a `park` worker that hibernated and woke silently stopped declaring
      // elicitation — and F28 says the agent then asks in PROSE instead, so the park never
      // happened again for the rest of that worker's life. The value is computed ONCE by
      // `clientCapabilitiesFor()` and threaded through `SessionOpenOptions`, which `open` above
      // already uses; this is the second of the two call sites, and the named regression test in
      // `core/test/worker/interaction/capability.test.ts` was written first and failed here.
      //
      // `?? {}` keeps M1's behaviour as the DEFAULT rather than as a migration: a caller that
      // threads nothing sends exactly what M1 sent (D3).
      const clientCapabilities = call.clientCapabilities ?? {};

      try {
        // ── §15.3 step 4: initialize, against a BRAND NEW process ──────────
        const init = record(
          await budget.race(
            request(link)<unknown>("initialize", {
              protocolVersion: descriptor.protocolVersion,
              clientCapabilities,
            }),
          ),
        );
        if (init === null) {
          throw new OmniError("agent_error", "initialize returned a non-object response");
        }
        assertNegotiated(init["protocolVersion"], descriptor);
        // AS SENT (§5.8.4), for the same reason `handshake.ts` records it on the create path:
        // `initialize`'s `agentCapabilities` never mentions elicitation either way (F28), so our
        // own declaration is the only record of why an agent asked in prose — and without it D10
        // is unauditable across a wake.
        const fresh = capabilitiesFromInitialize(init, descriptor, clientCapabilities);

        // ── §15.3 step 5: pick the resume spelling ─────────────────────────
        const spellings = candidateSpellings(descriptor, fresh, call.capabilities);
        if (spellings.length === 0) {
          // §15.5 row 1, reached from the WAKE side: no spelling ⇒ 422, and the worker closes
          // rather than sitting in `hibernated` pretending it could ever come back.
          throw notResumable(
            reportFor(null, false),
            `agent ${descriptor.id} advertises no resume spelling this daemon can send`,
          );
        }

        // ── §15.3 steps 6-7: send, classify, walk the preference order ─────
        // `null` only until the first spelling is sent, and the loop below always sends one:
        // `spellings` is non-empty by the check above. It is a `let` rather than a placeholder
        // report so a future edit that skips the loop is a compile error, not a fabricated
        // verdict about an attempt that never happened.
        let report: ResumeReport | null = null;
        let landed: RawAttempt | null = null;
        for (const [index, method] of spellings.entries()) {
          const attempt = await sendOne(link, method, call, budget);
          report = reportFor(attempt, true);
          // Rule 3: the METHOD is missing, not the session. The preference order tries the next
          // spelling and only an EXHAUSTED list is fatal (§15.4) — which is the whole reason the
          // descriptor carries an ORDER and not a name (F18).
          //
          // `continue` on the LAST spelling too, and deliberately: it leaves `landed` null,
          // which is how "we ran out of spellings" is distinguished from "this one answered".
          if (report.hint === "method_not_found") {
            const next = spellings[index + 1];
            if (next !== undefined) {
              logger.debug("resume spelling not implemented; trying the next", { method, next });
            }
            continue;
          }
          landed = attempt;
          break;
        }
        if (report === null) {
          throw new OmniError("internal", "resume preference order produced no attempt");
        }
        if (landed === null) {
          // Every spelling answered -32601. §15.3 step 5's "none available ⇒ DEAD: 422". The
          // REPORT keeps the classifier's honest `unknown` / `method_not_found`: the agent told
          // us the method is missing, not that the session is gone. Only the ACTION is fatal.
          throw notResumable(
            report,
            `no resume spelling of ${descriptor.id} is implemented by this process`,
          );
        }

        // ── §15.5's mapping, in table order ────────────────────────────────
        if (report.outcome === "rejected_permanent") {
          // 422. The pointer is worthless; `worker.ts`'s `#wakeFailed` clears it and closes.
          throw notResumable(report, `agent refused to resume session ${call.sessionId}`);
        }
        if (report.outcome === "rejected_transient") {
          // 502. The session is healthy and now is not the time — the pointer is KEPT and the
          // worker goes back to `hibernated`.
          throw resumeError(
            "agent_error",
            report,
            `agent could not resume session ${call.sessionId} right now`,
          );
        }
        if (report.outcome === "unknown" && !answered(report)) {
          // A dead transport (502) or a spent budget (504). `unknown` stays the honest
          // CLASSIFICATION and the pointer is kept; the throw is only the action.
          throw resumeError(
            report.hint === "timeout" ? "agent_timeout" : "agent_error",
            report,
            `resume of session ${call.sessionId} did not complete (${report.hint})`,
          );
        }

        // `landed`, and the ANSWERED `unknown`s (rule 4's `cwd_mismatch` / `unclassified`), both
        // reach `ready` with the pointer kept — §15.5's "resume ⇒ unknown or landed ⇒ ready".
        return {
          capabilities: withSessionBody(
            { ...fresh, resume: { ...fresh.resume, method: landed.method } },
            // F18 / corpus README finding 9: `session/load` and `session/resume` BOTH return
            // `{sessionId, modes, configOptions}`, contrary to the v1 schema. Read it exactly as
            // we read `session/new`'s.
            landed.body,
          ),
          sessionId: report.landedOn ?? call.sessionId,
          resume: report,
        };
      } catch (e) {
        throw OmniError.from(e, "agent_error");
      } finally {
        budget.dispose();
      }
    },

    async close(link: AcpLinkLike, sessionId: SessionId): Promise<void> {
      // "Best-effort when advertised. NEVER throws." The caller is already tearing the process
      // down, a failed `session/close` changes nothing it can act on, and `CloseResult`
      // reports `sessionClosed: false` rather than pretending.
      for (const spelling of o.descriptor.prefer["close"]?.spellings ?? []) {
        try {
          await link.request(spelling, { sessionId });
          return;
        } catch (e) {
          logger.debug("session close failed; continuing", { spelling, error: String(e) });
        }
      }
    },
  };
}

/** 422 `not_resumable`, carrying the full `ResumeReport` so `rule` says which line fired. */
function notResumable(report: ResumeReport, message: string): OmniError {
  return resumeError("not_resumable", report, message);
}

function resumeError(
  code: "not_resumable" | "agent_error" | "agent_timeout",
  report: ResumeReport,
  message: string,
): OmniError {
  const acp = report.acp;
  return new OmniError(code, message, {
    resume: report,
    ...(acp === null ? {} : { acp }),
  });
}

/**
 * The spellings to try, in order: what THIS process advertised, then the method the previous
 * handshake resolved.
 *
 * The fallback is not redundancy for its own sake. `capabilities.resume.method` was resolved
 * against the process that actually held the session — §15.1's invariant 1 requires it to be
 * non-null for a `hibernated` worker — so a warm `initialize` that advertises less than the cold
 * one did must not silently turn a resumable worker into a 422.
 */
function candidateSpellings(
  descriptor: RuntimeDescriptor,
  fresh: AgentCapabilitiesSnapshot,
  remembered: AgentCapabilitiesSnapshot | null,
): readonly ResumeMethod[] {
  const out = [...resumeSpellings(descriptor, fresh.raw)];
  const previous = remembered?.resume.method ?? null;
  if (previous !== null && !out.includes(previous)) out.push(previous);
  return out;
}
