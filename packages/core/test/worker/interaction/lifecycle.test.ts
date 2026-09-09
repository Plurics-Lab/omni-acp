import { describe, it } from "vitest";

/**
 * M2-A-WP-I's acceptance script (docs/M2-PLAN.md §2), one `it.todo` per bullet.
 *
 * They are `todo` rather than absent so the shape of the milestone is visible from `vitest run`
 * on the Land commit itself, and so a work package cannot quietly finish having tested something
 * else. The wording is the bullet's; the bullet is the contract.
 *
 * Owned by M2-A-WP-I.
 */

describe("M2-A-WP-I — InteractionRequest: park / deny / fail, elicitation, requires_action", () => {
  it.todo(
    "runInteractionConformance passes for baselineInteractions AND the real strategy, and the baseline run's envelopes are byte-identical to M1's (checked-in golden); permission-deny and every M1 permission test run UNEDITED",
  );
  it.todo(
    'clientCapabilitiesFor is {elicitation:{form:{}}} iff onUnresolved === "park", {} otherwise, no `url` key ever, and the SAME value is used on reopen after a wake — with a named regression test that FAILS against session-open.ts\'s hard-coded {} (F42), written first',
  );
  it.todo(
    "mapElicitation is pure, total and idempotent over transcripts 12/13: the FLAT scope (F29), oneOf[].const AND enum, the _custom pairing via _meta._askUserQuestionCustomAnswer (F30), no required array, unmodelled: []; a fixture that nests the scope is rejected with a named error; an unparseable schema yields fields: [] with every property in unmodelled",
  );
  it.todo(
    "buildElicitationContent emits EXACTLY ONE property per questionId; answering both members of a group is 400 — the regression test named after omni-choice.txt, the file transcript 12 wrongly created",
  );
  it.todo(
    "the auto-resolved path emits M1's two envelopes in M1's order; the park path emits §19.10's five-envelope sequence, and omni.policy_decision appears EXACTLY ONCE, at settlement (M2-R4)",
  );
  it.todo(
    'park refcounts: two concurrent interactions park once, interaction_resolved fires only on the second answer, the lease pin is held for the whole window, and interactions.length > 0 <=> state === "requires_action" is an invariant test',
  );
  it.todo(
    'parkTimeoutMs under fakeClock() on elicit-never-answers.mjs produces by:"timeout" and applies parkTimeoutAction for BOTH "deny" and "fail"; parkTimeoutMs: 0 never expires; interaction.maxParked denies the newest with rule:"limit:max_parked" and never drops it',
  );
  it.todo(
    'every row of §19.6\'s status table returns the exact code and body extra, in the exact check order (visibility -> state -> existence -> lease -> shape -> semantics -> deliver), and two identical failures produce deep-equal bodies; a role:"admin" caller without the lease is 423; steal then answer succeeds and the log shows omni.lease{stolen} BEFORE the answer (M2-R6)',
  );
  it.todo(
    'settleAll("cancel") resolves every held promise BEFORE session/cancel reaches stdin, asserted by method order on a recording scripted agent; settleAll("shutdown") leaves NO pending interaction in the log',
  );
  it.todo(
    'worker.on("interaction", req => req.allow()) — DESIGN §9.1\'s literal line — runs; answer() is keyed by question id and the WIRE carries exactly one property per question, asserted on captured frames; prompt() survives a park longer than requestTimeoutMs',
  );
});
