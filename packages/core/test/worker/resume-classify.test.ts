import { describe, expect, it } from "vitest";
import type { AcpErrorDetail, ResumeAttempt, ResumeReport, SessionId } from "@omni-acp/protocol";
import {
  classifyResume,
  createDeferredPromotion,
  PERMANENT_CODES,
  PERMANENT_TEXT,
  promoteOnFirstTurn,
} from "../../src/worker/resume-classify.js";

/**
 * CONTRACTS.md §15.4, as a table test — M1-PLAN WP-C acceptance 2.
 *
 * Two of the assertions here are not "does the code work" but "does a future edit reduce a
 * recoverable failure to a destroyed session":
 *
 *  - `PERMANENT_TEXT` must not match `"Resource not found"` (F15). That string is the corpus
 *    README's recorded answer to a **cwd mismatch on a LIVE, HEALTHY session**, and broadening
 *    the matcher to catch it would clear a pointer that still works.
 *  - no network / timeout / auth / quota / 5xx error may ever be `rejected_permanent`. Rule 1 is
 *    checked BEFORE rule 2 for exactly that reason, and the property test below is the assertion
 *    that survives a reordering.
 */

const AT = "2026-09-04T00:00:00.000Z";
const SESSION = "sess_live" as SessionId;

function attempt(over: Partial<ResumeAttempt> = {}): ResumeAttempt {
  return {
    method: "session/load",
    requested: SESSION,
    returned: null,
    acp: null,
    transportFailed: false,
    timedOut: false,
    replayedEvents: 0,
    replayDropped: 0,
    capabilityAdvertised: true,
    requiresSameCwd: false,
    cwdChanged: false,
    durationMs: 12,
    at: AT,
    ...over,
  };
}

const err = (code: number, message: string, data?: unknown): AcpErrorDetail =>
  data === undefined ? { code, message } : { code, message, data };

/** The corpus README's finding 10, verbatim — and F15's note that no transcript contains it. */
const CWD_MISMATCH: AcpErrorDetail = {
  code: -32002,
  message: `Resource not found: ${SESSION}`,
  data: { uri: SESSION },
};

interface Row {
  readonly name: string;
  readonly input: ResumeAttempt;
  readonly outcome: ResumeReport["outcome"];
  readonly hint: ResumeReport["hint"];
  readonly rule: string;
  /** `undefined` ⇒ the pointer is KEPT (landedOn === requested). */
  readonly landedOn?: SessionId | null;
  readonly historyLost?: boolean;
}

const TABLE: readonly Row[] = [
  // ── the two pre-checks §15.5 decides before anything is sent ──────────────
  {
    name: "no resume spelling was ever resolved => 422, and nothing was sent",
    input: attempt({ capabilityAdvertised: false, method: null }),
    outcome: "rejected_permanent",
    hint: "capability_absent",
    rule: "pre0:capability-absent",
    landedOn: null,
    // NOT provably gone: the agent may still hold the context, we simply cannot ask for it.
    historyLost: false,
  },
  {
    name: "the pointer was cleared by an earlier verdict => 422",
    input: attempt({ requested: null }),
    outcome: "rejected_permanent",
    hint: "not_found",
    rule: "pre1:no-session-pointer",
    landedOn: null,
    historyLost: false,
  },

  // ── rule 0 ────────────────────────────────────────────────────────────────
  {
    name: "rule 0: the budget expired — no answer, so no classification",
    input: attempt({ timedOut: true }),
    outcome: "unknown",
    hint: "timeout",
    rule: "rule0:timeout",
  },
  {
    name: "rule 0: a dead transport carries no JSON-RPC code (§7.3)",
    input: attempt({ transportFailed: true }),
    outcome: "unknown",
    hint: "transport",
    rule: "rule0:transport",
  },
  {
    name: "rule 0 beats a code: a transport failure that also carried one is still unknown",
    input: attempt({ transportFailed: true, acp: err(-32002, "session not found") }),
    outcome: "unknown",
    hint: "transport",
    rule: "rule0:transport",
  },

  // ── rule 1, the never-rejected class ──────────────────────────────────────
  {
    name: "rule 1: a rate limit",
    input: attempt({ acp: err(-32000, "Rate limit exceeded; retry after 60s") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },
  {
    name: "rule 1: HTTP 429 quoted in the message",
    input: attempt({ acp: err(-32603, "upstream returned 429") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },
  {
    name: "rule 1: quota",
    input: attempt({ acp: err(-32000, "monthly quota exhausted") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },
  {
    name: "rule 1: auth",
    input: attempt({ acp: err(-32002, "Unauthorized: invalid API key") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:auth",
  },
  {
    name: "rule 1: an expired token",
    input: attempt({ acp: err(-32000, "token expired, please log in again") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:auth",
  },
  {
    name: "rule 1: a 5xx",
    input: attempt({ acp: err(-32603, "Service Unavailable") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:server_error",
  },
  {
    name: "rule 1: a network errno",
    input: attempt({ acp: err(-32603, "ECONNRESET while contacting the API") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:network",
  },
  {
    name: "rule 1: overloaded",
    input: attempt({ acp: err(-32000, "The model is overloaded") }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },
  {
    name: "rule 1 is checked BEFORE rule 2: a rate limit that quotes a session id keeps the pointer",
    input: attempt({
      acp: err(-32002, `rate limit exceeded for session not found guard on ${SESSION}`),
    }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },
  {
    name: "rule 1 reads `data` too, because agents put the cause in either field",
    input: attempt({ acp: err(-32603, "Internal error", { details: "429 Too Many Requests" }) }),
    outcome: "rejected_transient",
    hint: "rate_limited",
    rule: "rule1:rate_limited",
  },

  // ── rule 2, the conjunction that is the whole safety margin ───────────────
  ...PERMANENT_CODES.map((code): Row => ({
    name: `rule 2: ${String(code)} AND "session not found" => the pointer is cleared`,
    input: attempt({ acp: err(code, `session not found: ${SESSION}`) }),
    outcome: "rejected_permanent",
    hint: "not_found",
    rule: "rule2:session-not-found",
    landedOn: null,
    historyLost: true,
  })),
  {
    name: 'rule 2: "unknown session" is the same claim in other words',
    input: attempt({ acp: err(-32602, "unknown session") }),
    outcome: "rejected_permanent",
    hint: "not_found",
    rule: "rule2:session-not-found",
    landedOn: null,
    historyLost: true,
  },
  {
    name: "rule 2 needs the CODE too: the right text under an unlisted code is not permanent",
    input: attempt({ acp: err(-31999, `session not found: ${SESSION}`) }),
    outcome: "unknown",
    hint: "unclassified",
    rule: "rule4:unclassified-jsonrpc",
  },
  {
    name: "rule 2 needs the TEXT too: a listed code with unrelated text is not permanent",
    input: attempt({ acp: err(-32603, "Invalid value for config option model: sonnet") }),
    outcome: "unknown",
    hint: "unclassified",
    rule: "rule4:unclassified-jsonrpc",
  },

  // ── rule 3 ────────────────────────────────────────────────────────────────
  {
    name: "rule 3: -32601 is the METHOD missing, not the session",
    input: attempt({
      acp: err(-32601, '"Method not found": session/load', { method: "session/load" }),
    }),
    outcome: "unknown",
    hint: "method_not_found",
    rule: "rule3:method-not-found",
  },

  // ── rule 4, and F15's regression lock ─────────────────────────────────────
  {
    name: "rule 4: F15's recorded -32002 cwd mismatch is UNKNOWN and the pointer SURVIVES",
    input: attempt({ acp: CWD_MISMATCH, requiresSameCwd: true }),
    outcome: "unknown",
    hint: "cwd_mismatch",
    rule: "rule4:cwd-mismatch",
  },
  {
    name: "rule 4: the same shape without the quirk is unclassified, and still keeps the pointer",
    input: attempt({ acp: CWD_MISMATCH, requiresSameCwd: false }),
    outcome: "unknown",
    hint: "unclassified",
    rule: "rule4:unclassified-jsonrpc",
  },
  {
    name: "rule 4: anything else with a code",
    input: attempt({ acp: err(-32099, "the agent is confused") }),
    outcome: "unknown",
    hint: "unclassified",
    rule: "rule4:unclassified-jsonrpc",
  },

  // ── rules 5 and 7 ─────────────────────────────────────────────────────────
  {
    name: "rule 5: a DIFFERENT session came back — our pointer is worthless, and we hold the new one",
    input: attempt({ returned: "sess_other" as SessionId }),
    outcome: "rejected_permanent",
    hint: "silently_created",
    rule: "rule5:silently-created",
    landedOn: "sess_other" as SessionId,
    historyLost: true,
  },
  {
    name: "rule 7: the id matches",
    input: attempt({ returned: SESSION }),
    outcome: "landed",
    hint: "ok",
    rule: "rule7:landed",
  },
  {
    name: "rule 7: a v1 null body is the schema's own answer, not evidence of a failure",
    input: attempt({ returned: null }),
    outcome: "landed",
    hint: "ok",
    rule: "rule7:landed",
  },
];

describe("classifyResume — §15.4's table, row by row", () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const report = classifyResume(row.input);
      expect(report.outcome).toBe(row.outcome);
      expect(report.hint).toBe(row.hint);
      expect(report.rule).toBe(row.rule);
      // The pointer column of the table. `undefined` in a row means "kept", which is the value
      // an operator reads as "your session is still the one you asked for".
      expect(report.landedOn).toBe(row.landedOn === undefined ? row.input.requested : row.landedOn);
      expect(report.historyLost).toBe(row.historyLost ?? false);
      // Passed through, never reshaped, on every row.
      expect(report.acp).toBe(row.input.acp);
      expect(report.method).toBe(row.input.method);
      expect(report.requested).toBe(row.input.requested);
      expect(report.at).toBe(AT);
      expect(report.durationMs).toBe(row.input.durationMs);
    });
  }

  it("is PURE: the same input classified twice is deep-equal, and the input is untouched", () => {
    const input = attempt({ acp: CWD_MISMATCH, requiresSameCwd: true });
    const frozen = JSON.stringify(input);
    expect(classifyResume(input)).toEqual(classifyResume(input));
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("carries the replay audit through verbatim (ruling M1-R5)", () => {
    const report = classifyResume(
      attempt({ returned: SESSION, replayedEvents: 2, replayDropped: 1 }),
    );
    expect(report.replayedEvents).toBe(2);
    expect(report.replayDropped).toBe(1);
  });
});

/**
 * THE NEGATIVE LOCK (F15, ruling M1-R6, §11.6's named risk).
 *
 * If you are here because you "helpfully" broadened the matcher: the string below is what
 * claude-acp answers for a **cwd mismatch on a session that is alive and healthy**. Matching it
 * turns a recoverable mistake into `rejected_permanent`, which CLEARS the session pointer and
 * closes the worker with a 422. The diagnosis belongs in `hint: "cwd_mismatch"`, which rule 4
 * already produces, and the compat suite re-observes the shape live so this stays evidence
 * rather than prose.
 */
describe("PERMANENT_TEXT — the negative lock", () => {
  it('does NOT match "Resource not found"', () => {
    expect(PERMANENT_TEXT.test("Resource not found")).toBe(false);
    expect(PERMANENT_TEXT.test(`Resource not found: ${SESSION}`)).toBe(false);
    expect(PERMANENT_TEXT.test("resource not found")).toBe(false);
  });

  it("still matches the three phrases D2 actually named", () => {
    expect(PERMANENT_TEXT.test("session not found")).toBe(true);
    expect(PERMANENT_TEXT.test("No session found for that id")).toBe(true);
    expect(PERMANENT_TEXT.test("Unknown session")).toBe(true);
  });

  it("has no /g flag, so `.test` cannot go stateful between calls", () => {
    expect(PERMANENT_TEXT.global).toBe(false);
    expect(PERMANENT_TEXT.test("session not found")).toBe(true);
    expect(PERMANENT_TEXT.test("session not found")).toBe(true);
  });
});

/**
 * The property whose violation destroys a LIVE session pointer (§15.4's closing paragraph).
 *
 * Generated adversarially: every message below is a member of rule 1's class, and each is paired
 * with every code in rule 2's set — so a classifier that checked rule 2 first would fail here
 * even though the table above would still pass.
 */
describe("property: no network / timeout / auth / quota / 5xx error is ever rejected_permanent", () => {
  const TRANSIENT_MESSAGES: readonly string[] = [
    "Rate limit exceeded",
    "rate_limit_error: too many requests",
    "429 Too Many Requests",
    "quota exceeded for this organization",
    "The model is currently overloaded",
    "Request throttled, retry later",
    "Unauthorized",
    "authentication failed",
    "invalid api key provided",
    "OAuth token expired",
    "401 while refreshing credentials",
    "Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "504 Gateway Timeout",
    "upstream connect error",
    "ECONNRESET",
    "ECONNREFUSED 127.0.0.1:443",
    "ETIMEDOUT",
    "EAI_AGAIN api.example.com",
    "socket hang up",
    "fetch failed",
  ];

  it("holds over every (transient message x permanent code) pair", () => {
    for (const message of TRANSIENT_MESSAGES) {
      for (const code of [...PERMANENT_CODES, -32601, -1, 0, 500]) {
        const report = classifyResume(attempt({ acp: err(code, message) }));
        expect(
          report.outcome,
          `code ${String(code)} / ${message} must never be permanent`,
        ).not.toBe("rejected_permanent");
        // And the pointer survives, which is the fact the outcome exists to protect.
        expect(report.landedOn).toBe(SESSION);
        expect(report.historyLost).toBe(false);
      }
    }
  });

  it("holds when the cause is in `data` rather than in the message", () => {
    for (const message of TRANSIENT_MESSAGES) {
      const report = classifyResume(
        attempt({ acp: err(-32603, "Internal error", { details: message }) }),
      );
      expect(report.outcome).not.toBe("rejected_permanent");
      expect(report.landedOn).toBe(SESSION);
    }
  });

  it("holds for a timeout and for a dead transport, which carry no code at all", () => {
    expect(classifyResume(attempt({ timedOut: true })).outcome).not.toBe("rejected_permanent");
    expect(classifyResume(attempt({ transportFailed: true })).outcome).not.toBe(
      "rejected_permanent",
    );
  });
});

/** §15.4's rule 8, and M1-PLAN WP-C acceptance 9. */
describe("rule 8 — the deferred promotion", () => {
  const unknownReport = classifyResume(attempt({ acp: CWD_MISMATCH, requiresSameCwd: true }));
  const landedReport = classifyResume(attempt({ returned: SESSION }));

  it("promotes an `unknown` wake whose first turn refuses with ZERO activity", () => {
    const promoted = promoteOnFirstTurn(unknownReport, { stopReason: "refusal", activity: false });
    expect(promoted).not.toBeNull();
    expect(promoted?.outcome).toBe("rejected_permanent");
    expect(promoted?.hint).toBe("refusal_no_activity");
    expect(promoted?.rule).toBe("rule8:refusal-no-activity");
    // The pointer is CLEARED and the context is provably gone: it refused, said nothing, did
    // nothing. §15.5's row for rule 8 is an envelope-only `closed(not_resumable)`.
    expect(promoted?.landedOn).toBeNull();
    expect(promoted?.historyLost).toBe(true);
  });

  it("can NEVER overturn a `landed`", () => {
    expect(promoteOnFirstTurn(landedReport, { stopReason: "refusal", activity: false })).toBeNull();
    const gate = createDeferredPromotion(landedReport);
    expect(gate.offer({ stopReason: "refusal", activity: false })).toBeNull();
    expect(gate.report).toBe(landedReport);
    expect(gate.report.outcome).toBe("landed");
  });

  it("never touches a verdict that already decided, in either direction", () => {
    const permanent = classifyResume(attempt({ acp: err(-32002, "session not found") }));
    const transient = classifyResume(attempt({ acp: err(-32000, "rate limit exceeded") }));
    for (const report of [permanent, transient]) {
      expect(promoteOnFirstTurn(report, { stopReason: "refusal", activity: false })).toBeNull();
    }
  });

  it("needs BOTH halves: a refusal that produced output is a refusal, not a lost session", () => {
    expect(promoteOnFirstTurn(unknownReport, { stopReason: "refusal", activity: true })).toBeNull();
    expect(
      promoteOnFirstTurn(unknownReport, { stopReason: "end_turn", activity: false }),
    ).toBeNull();
    expect(promoteOnFirstTurn(unknownReport, { stopReason: null, activity: false })).toBeNull();
  });

  it("fires AT MOST ONCE per wake, whatever the later turns look like", () => {
    const gate = createDeferredPromotion(unknownReport);
    expect(gate.spent).toBe(false);
    // The FIRST turn is the only one rule 8 looks at. This one does not promote…
    expect(gate.offer({ stopReason: "end_turn", activity: true })).toBeNull();
    expect(gate.spent).toBe(true);
    // …and a later refusal is a refusal, not evidence about a resume three turns ago.
    expect(gate.offer({ stopReason: "refusal", activity: false })).toBeNull();
    expect(gate.report).toBe(unknownReport);
  });

  it("a promotion is also spent: a second offer cannot promote twice", () => {
    const gate = createDeferredPromotion(unknownReport);
    const first = gate.offer({ stopReason: "refusal", activity: false });
    expect(first?.outcome).toBe("rejected_permanent");
    expect(gate.report).toBe(first);
    expect(gate.offer({ stopReason: "refusal", activity: false })).toBeNull();
    expect(gate.report).toBe(first);
  });

  it("keeps everything the wake recorded — the promotion is a verdict, not a new attempt", () => {
    const promoted = promoteOnFirstTurn(unknownReport, { stopReason: "refusal", activity: false });
    expect(promoted?.method).toBe(unknownReport.method);
    expect(promoted?.requested).toBe(unknownReport.requested);
    expect(promoted?.acp).toBe(unknownReport.acp);
    expect(promoted?.replayedEvents).toBe(unknownReport.replayedEvents);
    expect(promoted?.at).toBe(unknownReport.at);
  });
});
