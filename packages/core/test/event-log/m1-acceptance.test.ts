import { describe, it } from "vitest";

/**
 * M1-WP-A's acceptance bullets, one `it.todo` each (M1-PLAN §2, WP-A).
 *
 * Landed as todos by the Land step so the obligations are visible in the tree that owns them
 * from the first commit — the same discipline M0-PLAN §1 used, and the reason six parallel
 * packages worked the first time. WP-A replaces each todo with the real test; it does not
 * delete one.
 */
describe("M1-WP-A — event-log persistence, retention, restart-survivable ?since=", () => {
  it.todo(
    "runEventLogConformance passes for memory, sqlite(:memory:) and sqlite(file) — M0's suite VERBATIM, object-identity assertion included (F11)",
  );
  it.todo("runEventLogPersistenceConformance passes all ten items of §14.11");
  it.todo(
    "item 3 FAILS on a planted `head = max(seq)` — the §14.4 bug, demonstrated red during review",
  );
  it.todo(
    'driver:"memory" never loads node:sqlite (zero ExperimentalWarnings across a full cycle), driver:"sqlite" emits zero, and an UNRELATED ExperimentalWarning still gets through',
  );
  it.todo(
    'a put that throws degrades to persistence:"degraded", never throws into append, keeps seq gap-free, still delivers to subscribers, and reaches writeFailures',
  );
  it.todo(
    "planRetention is pure and table-tested; runRetention raises tail_seq in the SAME transaction as the DELETE and never ages out a live or hibernated worker",
  );
  it.todo(
    "the digest cuts the corpus's 23 available_commands_update appends to 2 stored payloads with a byte-identical read(0); a stream:false/store:true UpdateRule is rejected at descriptor resolution",
  );
  it.todo(
    "the ring/disk boundary survives a randomized append/read/evict fuzz (gap-free, no duplicates) and a read across the floor with the ring sized to 3",
  );
  it.todo(
    "the data-dir lock refuses a second live daemon naming the first's pid, breaks a stale one, and is skipped entirely for the memory driver",
  );
  it.todo("a per-append latency budget over 5 000 appends holds on all three OSes");
});
