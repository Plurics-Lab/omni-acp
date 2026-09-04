import type {
  AcpErrorDetail,
  ResumeAttempt,
  ResumeHint,
  ResumeOutcome,
  ResumeReport,
  SessionId,
  StopReason,
} from "@omni-acp/protocol";

/**
 * D2's four states, decided by RULE NUMBER (CONTRACTS.md §15.4). PURE: no clock, no process, no
 * network — the table test is written against exactly this function.
 *
 * Two rules the implementation must not soften:
 *
 *  - the NEGATIVE LOCK: `PERMANENT_TEXT` must NOT match `"Resource not found"`. F15 found that
 *    shape in the corpus README and in NO committed transcript, so it is an unrecorded
 *    observation; it is kept as a regression fixture and re-observed live by the compat suite,
 *    never promoted to a permanent-failure matcher on the strength of prose.
 *  - no network / timeout / auth / quota / 5xx error may EVER yield `rejected_permanent`. Those
 *    are `rejected_transient`, and the pointer is kept.
 *
 * Owned by M1-WP-C.
 */

/**
 * D2's permanent CODE set. It is only half of rule 2 — the conjunction with `PERMANENT_TEXT` is
 * the entire safety margin, because every one of these codes is also produced by failures that
 * have nothing to do with the session (`-32603` is JSON-RPC's own "Internal error", and corpus
 * `08` shows claude-acp answering a bad config VALUE with it).
 */
export const PERMANENT_CODES: readonly number[] = [-32603, -32602, -32002, -32000];

/**
 * The other half of rule 2, and the most dangerous regex in the repository.
 *
 * It must NOT match `"Resource not found: <sessionId>"` — the shape the corpus README records
 * for a claude-acp **cwd mismatch on a live, healthy session** (F15). Broadening this to
 * `/resource not found/` would turn a recoverable cwd mismatch into `rejected_permanent` and
 * destroy a live session pointer, which is why a named unit test asserts the non-match and why
 * the compat suite re-observes the shape live rather than trusting the note.
 */
export const PERMANENT_TEXT = /session not found|no session found|unknown session/i;

/**
 * Rule 1's never-rejected class, split by cause so `ResumeReport.rule` says WHICH one fired.
 *
 * The `outcome` for every member is `rejected_transient` and the `hint` for every member is
 * `rate_limited`, because §15.4's table gives the row one outcome and one hint; the class that
 * actually matched is recorded in the rule string instead, where it costs nothing and lies to
 * nobody.
 */
const TRANSIENT_CLASSES: readonly { readonly id: string; readonly re: RegExp }[] = [
  {
    id: "rate_limited",
    re: /rate[ _-]?limit|too many requests|\b429\b|quota|overloaded|over capacity|throttl/i,
  },
  {
    id: "auth",
    re: /unauthorized|unauthenticated|authentication|invalid api key|api key|credential|token (?:has )?expired|session expired|expired token|\b401\b|\b403\b|permission denied/i,
  },
  {
    id: "server_error",
    re: /internal server error|bad gateway|service unavailable|gateway time-?out|upstream|\b5\d\d\b/i,
  },
  {
    id: "network",
    re: /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|EPIPE|socket hang ?up|network (?:error|failure)|fetch failed/i,
  },
];

/** The `-32002` "resource not found" SHAPE, from the corpus README's finding 10 (F15). */
const RESOURCE_NOT_FOUND_TEXT = /resource not found/i;

function textOf(acp: AcpErrorDetail): string {
  // The message plus a flattened `data`, because agents put the cause in either one and F17
  // shows the message is not a stable contract on its own.
  const data = acp.data;
  if (data === undefined || data === null) return acp.message;
  try {
    return `${acp.message} ${JSON.stringify(data)}`;
  } catch {
    // A circular or otherwise unserialisable `data` is still an error we must classify.
    return acp.message;
  }
}

function isResourceNotFoundShape(acp: AcpErrorDetail): boolean {
  if (RESOURCE_NOT_FOUND_TEXT.test(acp.message)) return true;
  const data = acp.data;
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { uri?: unknown }).uri === "string" &&
    acp.code === -32002
  );
}

interface Verdict {
  readonly outcome: ResumeOutcome;
  readonly hint: ResumeHint;
  readonly rule: string;
  readonly landedOn: SessionId | null;
  readonly historyLost: boolean;
}

/**
 * The quirk rule 4 and rule 6 need that `ResumeAttempt` does not (yet) carry.
 *
 * §15.4 describes the classifier as pure over `{…, quirks}`, but the landed
 * `protocol/src/resume.ts` gives it only `requiresSameCwd`. `resumeSilentlyCreates` therefore
 * arrives as an OPTIONAL extra property on the same record: reading it here is inert for every
 * caller that does not set it, and rule 6 becomes live the moment the field is added to the
 * frozen interface. See this work package's notes — the exact one-line change is recorded there
 * rather than made here, because `packages/protocol/src/resume.ts` is Land-frozen.
 */
function silentlyCreates(a: ResumeAttempt): boolean {
  return (a as { silentlyCreates?: unknown }).silentlyCreates === true;
}

function decide(a: ResumeAttempt): Verdict {
  const requested = a.requested;

  // ── the two pre-checks §15.5's table decides BEFORE any call is made ──────
  //
  // Neither is a numbered row of §15.4's table (nothing was sent, so no rule can have fired),
  // and both are `rejected_permanent` because §15.5 answers each with a 422 and a closed worker.
  // `historyLost` stays FALSE for both: the agent may well still hold the context — we simply
  // have no way left to ask for it, and `historyLost` means *provably* gone.
  if (!a.capabilityAdvertised || a.method === null) {
    return {
      outcome: "rejected_permanent",
      hint: "capability_absent",
      rule: "pre0:capability-absent",
      landedOn: null,
      historyLost: false,
    };
  }
  if (requested === null) {
    return {
      outcome: "rejected_permanent",
      hint: "not_found",
      rule: "pre1:no-session-pointer",
      landedOn: null,
      historyLost: false,
    };
  }

  // ── rule 0: the call never produced a JSON-RPC answer ────────────────────
  //
  // A dead transport tells us nothing about the SESSION, so the pointer is kept and the label
  // is `unknown` — §7.3's rule ("a rejection with no JSON-RPC code is a dead transport, do not
  // classify from it") applied to resume.
  if (a.timedOut) {
    return {
      outcome: "unknown",
      hint: "timeout",
      rule: "rule0:timeout",
      landedOn: requested,
      historyLost: false,
    };
  }
  if (a.transportFailed) {
    return {
      outcome: "unknown",
      hint: "transport",
      rule: "rule0:transport",
      landedOn: requested,
      historyLost: false,
    };
  }

  const acp = a.acp;
  if (acp !== null) {
    const text = textOf(acp);

    // ── rule 1: the never-rejected class, CHECKED BEFORE RULE 2 ────────────
    //
    // The ordering is the safety property, not a style choice: a rate-limit message may quote a
    // session id, and if rule 2 saw it first a throttled resume would clear a live pointer.
    for (const klass of TRANSIENT_CLASSES) {
      if (klass.re.test(text)) {
        return {
          outcome: "rejected_transient",
          hint: "rate_limited",
          rule: `rule1:${klass.id}`,
          landedOn: requested,
          historyLost: false,
        };
      }
    }

    // ── rule 2: D2's permanent rule — code AND text, never either alone ────
    if (PERMANENT_CODES.includes(acp.code) && PERMANENT_TEXT.test(text)) {
      return {
        outcome: "rejected_permanent",
        hint: "not_found",
        rule: "rule2:session-not-found",
        landedOn: null,
        historyLost: true,
      };
    }

    // ── rule 3: the METHOD is missing, not the session ─────────────────────
    //
    // The caller walks its preference order and only an exhausted list is fatal, so the pointer
    // survives a spelling this agent happens not to implement.
    if (acp.code === -32601) {
      return {
        outcome: "unknown",
        hint: "method_not_found",
        rule: "rule3:method-not-found",
        landedOn: requested,
        historyLost: false,
      };
    }

    // ── rule 4: anything else with a code ──────────────────────────────────
    //
    // `cwd_mismatch` is F15's recorded shape and the reason M1-R6 chose `unknown` over
    // `rejected_transient`: both keep the pointer, so the ACTION is identical, and `unknown` is
    // the honest label for "we could not tell" while `transient` asserts a cause. The hint is
    // where the diagnosis lives.
    //
    // `a.cwdChanged` is deliberately NOT part of the condition. The observation is of an agent
    // refusing a session because ITS idea of the cwd differs from ours; a daemon that never
    // moved the worker can still hit it, so requiring us to have noticed a change first would
    // silence exactly the case the hint exists for.
    const cwdMismatch = a.requiresSameCwd && isResourceNotFoundShape(acp);
    return {
      outcome: "unknown",
      hint: cwdMismatch ? "cwd_mismatch" : "unclassified",
      rule: cwdMismatch ? "rule4:cwd-mismatch" : "rule4:unclassified-jsonrpc",
      landedOn: requested,
      historyLost: false,
    };
  }

  // ── the success arms ─────────────────────────────────────────────────────

  // rule 5: the agent answered with a DIFFERENT session. Our pointer is worthless whatever it
  // thinks it did, and we already hold the replacement — so the pointer is replaced rather than
  // merely cleared, and `historyLost` is the fact that makes that visible.
  if (a.returned !== null && a.returned !== requested) {
    return {
      outcome: "rejected_permanent",
      hint: "silently_created",
      rule: "rule5:silently-created",
      landedOn: a.returned,
      historyLost: true,
    };
  }

  // rule 6: the descriptor says this runtime silently creates, and nothing in the answer told us
  // whether it did this time. `unknown`, pointer kept.
  if (silentlyCreates(a)) {
    return {
      outcome: "unknown",
      hint: "unclassified",
      rule: "rule6:silent-create-inconclusive",
      landedOn: requested,
      historyLost: false,
    };
  }

  // rule 7: success, and the id matches — or the agent returned the v1 `null` body, which is the
  // schema's own answer and not evidence of anything going wrong.
  return {
    outcome: "landed",
    hint: "ok",
    rule: "rule7:landed",
    landedOn: a.returned ?? requested,
    historyLost: false,
  };
}

export function classifyResume(a: ResumeAttempt): ResumeReport {
  const verdict = decide(a);
  return {
    outcome: verdict.outcome,
    hint: verdict.hint,
    rule: verdict.rule,
    method: a.method,
    requested: a.requested,
    landedOn: verdict.landedOn,
    historyLost: verdict.historyLost,
    acp: a.acp,
    replayedEvents: a.replayedEvents,
    replayDropped: a.replayDropped,
    durationMs: a.durationMs,
    at: a.at,
  };
}

// ── rule 8: the deferred promotion ──────────────────────────────────────────

/** What rule 8 needs to know about the first turn after an `unknown` wake. */
export interface FirstTurnEvidence {
  readonly stopReason: StopReason | null;
  /** ANY agent output: text, thought, or a tool call. Zero activity is the whole signal. */
  readonly activity: boolean;
}

/**
 * §15.4's rule 8, as a pure function.
 *
 * It is a PROMOTION only: it can never overturn a `landed` and it only ever moves an `unknown`
 * to `rejected_permanent`. Returns `null` when nothing should change, so a caller can tell "no
 * promotion" from "promoted to the same shape".
 *
 * It lives outside `classifyResume` because it needs a SETTLED TURN, which is state the pure
 * classifier is not allowed to hold; `createDeferredPromotion` below is the once-only gate a
 * stateful caller drives.
 */
export function promoteOnFirstTurn(
  report: ResumeReport,
  turn: FirstTurnEvidence,
): ResumeReport | null {
  // "can never overturn a `landed`" — and by the same argument it never touches a verdict that
  // already decided, in either direction. Only `unknown` is still open.
  if (report.outcome !== "unknown") return null;
  if (turn.stopReason !== "refusal") return null;
  if (turn.activity) return null;
  return {
    ...report,
    outcome: "rejected_permanent",
    hint: "refusal_no_activity",
    rule: "rule8:refusal-no-activity",
    // The pointer is CLEARED (§15.4's pointer column), and the agent's context is provably gone:
    // it refused, said nothing, and did nothing.
    landedOn: null,
    historyLost: true,
  };
}

export interface DeferredPromotion {
  /** Feeds the FIRST turn after the wake. Later calls are ignored — rule 8 fires at most once. */
  offer(turn: FirstTurnEvidence): ResumeReport | null;
  /** The report as it stands: the wake's, or the promoted one. */
  readonly report: ResumeReport;
  readonly spent: boolean;
}

/**
 * The once-only gate around `promoteOnFirstTurn`.
 *
 * "At most once per wake" is a property of the CALLER, not of the rule, so it is modelled here
 * rather than inside the pure function: a wake creates one of these, the first settled turn is
 * offered to it, and every later turn is a no-op whatever it looks like.
 */
export function createDeferredPromotion(initial: ResumeReport): DeferredPromotion {
  let report = initial;
  let spent = false;
  return {
    offer(turn: FirstTurnEvidence): ResumeReport | null {
      if (spent) return null;
      // The FIRST turn is the only one rule 8 looks at, whether or not it promotes: a second
      // refusal three turns later is a refusal, not evidence about the resume.
      spent = true;
      const promoted = promoteOnFirstTurn(report, turn);
      if (promoted === null) return null;
      report = promoted;
      return promoted;
    },
    get report(): ResumeReport {
      return report;
    },
    get spent(): boolean {
      return spent;
    },
  };
}
