import { OmniError, type ResumeAttempt, type ResumeReport } from "@omni-acp/protocol";

/**
 * D2's four states, decided by RULE NUMBER (§15.4). PURE: no clock, no process, no network — the
 * table test is written against exactly this function.
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
export function classifyResume(_a: ResumeAttempt): ResumeReport {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
