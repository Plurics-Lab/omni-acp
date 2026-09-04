import { OmniError, type EventLog, type EventLogCoreOptions } from "@omni-acp/protocol";

/**
 * The ring, the subscribers, the overflow policy, the re-entrancy guard and the ONE `seq`
 * assigner — M0's `memory-log.ts` moved here VERBATIM, so that both drivers sit on identical
 * behaviour (CONTRACTS.md §14.1).
 *
 * The ring stays in front of the durable store as a CONTRACT REQUIREMENT, not a performance
 * choice: `runEventLogConformance` asserts object IDENTITY (`log.read(0)[0]` is the object
 * `append()` returned, F11), and a pure-SQLite `read()` returns a deserialized copy.
 *
 * `startSeq` seeds `head` on a rehydrated worker so a log whose rows retention already evicted
 * does NOT restart its own sequence at 1 (§14.4, L15) — the single most dangerous line in M1.
 *
 * Owned by M1-WP-A.
 */
export function createEventLogCore(_o: EventLogCoreOptions): EventLog {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
