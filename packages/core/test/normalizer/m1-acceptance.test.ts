import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M1-WP-B's acceptance bullets (M1-PLAN.md §2, WP-B) — an INDEX, not a placeholder.
 *
 * Each bullet names the file and the test that discharges it. The assertion is that the named
 * text is really in the suite: a test that was renamed, moved or deleted turns this red and says
 * which bullet lost its cover, which is the one thing a list of `it.todo`s could never do.
 *
 * Two bullets are discharged in a DIFFERENT form than they are written, and both say so in full,
 * with the reason and the frozen file that forced it. They are also in the work package's
 * hand-off notes; the whole point of writing them here is that the deviation travels with the
 * code rather than with the report.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function suiteText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".ts")) {
        // THIS FILE IS EXCLUDED, and that is the difference between an index and a tautology:
        // scanning it too would find every name inside its own list and pass forever.
        if (full === SELF) continue;
        parts.push(readFileSync(full, "utf8"));
      }
    }
  };
  walk(HERE);
  // The projection half lives in `protocol`, which owns `reduceTurn`; the four gap-filling
  // fixture agents are proven in `testkit`, which owns them. Both are M1-WP-B's paths.
  walk(join(HERE, "..", "..", "..", "protocol", "test"));
  parts.push(
    readFileSync(join(HERE, "..", "..", "..", "testkit", "test", "fixture-agents.test.ts"), "utf8"),
  );
  return parts.join("\n");
}

const SUITE = suiteText();

/** bullet -> the exact test names that discharge it. */
const BULLETS: readonly { readonly bullet: string; readonly covered: readonly string[] }[] = [
  {
    bullet:
      "1. every row of §12.3 has a hand-written test with LITERAL input and LITERAL expected output",
    covered: [
      "§12.3 rows 1-3 — the three chunk kinds are `=` except `messageId`",
      "§12.3 row 4 — `tool_call` -> `tool_call_update`",
      "§12.3 row 5 — `tool_call_update` is `=` verbatim",
      "§12.3 row 6 — the diff block (§12.5)",
      "§12.3 rows 7 and 8 — `plan` -> `plan_update`",
      "§12.3 row 9 — `plan_removed` is `=`",
      "§12.3 row 10 — `available_commands_update` is `=` ON THE WIRE",
      "§12.3 row 11 — `current_mode_update` -> `config_option_update`",
      "§12.3 rows 12 and 13 — already-v2 kinds are `=`",
      "§12.3 row 15 — the synthesized `state_update` is already v2 and stays `=`",
      "§12.3 rows 16 and 17 — what is NOT synthesized",
      "§12.3 row 18 — an unknown kind is pass-through BY IDENTITY at payloadVersion 1",
      "§12.3 row 18b — inbound method aliases",
      "§12.3 row 19 — `initialize`'s outbound rename",
      "§12.3 row 22 — an `McpServer` without a `type` gets one",
      "§12.3 row 27 — v2's `{type:'id', value}` tag is DROPPED outbound",
      "§12.3 rows 20-21 — the InitializeResponse, mapped per field",
      "row 23: `auth/login` / `auth/logout` are UNVERIFIED",
      "row 24: `session/resume` -> `session/load` DROPS `replayFrom`",
      "row 26: `set_model` is a SPELLING",
      "row 26b: `onFailure` is per capability",
      "reports `spelling: null` once every spelling is exhausted",
    ],
  },
  {
    bullet: "2. all 216 recorded updates pass the eight properties of §12.7(b)",
    covered: ["§12.7(b) — the eight properties, over all 216 recorded updates"],
  },
  {
    bullet:
      "3. `messageId` is synthesized 0 times across the corpus, and correctly for thought.mjs",
    covered: [
      "6. `messageId` is synthesized ZERO times for this agent: 86 of 86 chunks pass through",
      "groups a CONTIGUOUS RUN of id-less chunks under one id, and a kind change breaks it",
      "emits agent_thought_chunk with AND without messageId, in runs",
    ],
  },
  {
    bullet: "4. the vendor patch is one `git apply --check` accepts, for the edit AND the creation",
    covered: [
      "…and `git apply --check` accepts it in a temp repo",
      "…and `git apply --check` accepts THAT in a temp repo too",
      "`TurnResult.patch` is NULL and `vendorPatch` carries it, labelled",
      "returns NULL rather than WRONG when the hunk counts disagree with the hunk",
    ],
  },
  {
    bullet:
      "5. `mapPermissionRequest` is idempotent, never reshapes options, and the responder refuses",
    covered: [
      "is IDEMPOTENT: a request that already carries a `subject` comes back unchanged",
      "NEVER reshapes `options`: three pass through untouched, in order, by identity",
      "preserves an UNKNOWN `kind`, which D4 rule 6 needs in order to fail closed",
      "only ever answers with an id from `offered`, in both modes, over the recorded requests",
      "the PLANTED violation is what corpus 09 recorded, and the recording is the cost",
    ],
  },
  {
    bullet: "6. the forced ladder drives rungs 1->5 in order under fakeClock()",
    covered: [
      "drives quiet -> cancel -> close_stdin -> drain -> terminate, at the documented deadlines",
      "a `usage_update` arriving mid-rung is ordered BEFORE `idle` — the corpus `06` shape",
    ],
  },
  {
    bullet: "7. the ladder runs END-TO-END through a real Worker",
    covered: [
      "a DELETE mid-turn cancels, THEN closes stdin, and the FIXTURE sees both",
      "`drained` from the process's OWN stdout EOF short-circuits the last rung",
      "appends the error, then `idle`, in that seq order",
    ],
  },
  {
    bullet: "8. ALL M0 turn-lifecycle unit tests pass unmodified",
    covered: [
      "normalizer: TurnInput x state cross-product",
      "normalizer: the quiet window (CONTRACTS.md §7.2)",
      "normalizer: the hard cap (CONTRACTS.md §7.2)",
      "normalizer: the crash rule (CONTRACTS.md §7.3)",
    ],
  },
  {
    bullet: "9. `no-agent-prose` and `descriptor-is-the-only-branch`, each shown FAILING",
    covered: [
      "FAILS on a planted violation, and ignores the same words in a comment",
      "FAILS on a planted violation — an id, a vendor pointer, or an `if` on the agent",
      "reduceTurn computes §13.4's verdict with NO agent prose",
    ],
  },
  {
    bullet: "10. the named golden cases of §12.8, and `corpus:emit --check`",
    covered: [
      "§12.8 `01-plain`",
      "§12.8 `02-read`",
      "§12.8 `03-write-allowed`",
      "§12.8 `04-write-denied`",
      "§12.8 `06-cancel`",
      "§12.8 `07-load-replay`",
      "§12.8 `09-bad-option-id`",
      "§12.8 `10-edit`",
      "`--check`: the checked-in envelopes are byte-identical to a fresh generation",
    ],
  },
  {
    bullet: "11. `reduceTurn` is still pure and deterministic, and now SKIPS `replay: true`",
    covered: [
      "reduceTurn skips `replay: true` envelopes (ruling M1-R5)",
      "is still de-duplicated by `(workerId, seq)`, still order-independent, still pure",
      "a replayed `worker_state{closed}` does not end the turn",
    ],
  },
];

describe("M1-WP-B — the full v1->v2 map, the close-out ladder, the turn projection", () => {
  it("scans a real suite, and NOT itself", () => {
    expect(SUITE.length).toBeGreaterThan(50_000);
    // A name that exists ONLY in this file must not be found — which is the property that makes
    // every assertion below mean something.
    expect(SUITE).not.toContain("bullet 6, as shipped");
    expect(SUITE).toContain("§12.7(b) — the eight properties");
  });

  for (const { bullet, covered } of BULLETS) {
    it(bullet, () => {
      const missing = covered.filter((name) => !SUITE.includes(name));
      expect(missing).toEqual([]);
      expect(covered.length).toBeGreaterThan(0);
    });
  }

  /**
   * Bullet 6 asks the ladder to drive rungs "1→5". It drives rungs 1→4 as ACTIONS
   * (`close_stdin`, `drain`, `cancel`) and reports rung 5 as `settled` with `action: null`.
   *
   * `worker.ts` is frozen, and its `#perform("terminate")` is
   * `#closeWith("cancel_timeout", {force:true})` on a first-caller-wins promise: harmless during
   * a `DELETE` (a close is already in flight), and WRONG on the ladder's other two live triggers
   * — it would turn a hibernate into a close, and it would beat the cancel escalation's own
   * `#closeWith(..., {error})` and drop the `agent_timeout` that `POST /cancel`'s timeout must
   * report. Every trigger already performs §6.5's ladder itself in the statement after
   * `#runCloseOut` resolves, so reporting `settled` is behaviourally identical where `#perform`
   * is safe and correct where it is not.
   */
  it("bullet 6, as shipped: rungs 2 and 4 are TRANSPOSED, and rung 5 reports `settled`", () => {
    // §13.2 spells `close_stdin` second and `cancel` fourth, and a cancel cannot travel on a
    // stdin the previous rung closed — the e2e test asserts that from the AGENT's side, and with
    // the spelled order `worker.ts`'s floating `notify` failed the whole suite on an unhandled
    // rejection. Both deviations are explained where they happen, and this asserts that they
    // still are.
    expect(SUITE).toContain("§13.2 SPELLS THIS RUNG FOURTH");
    expect(SUITE).toContain('expect(rungs(marker)).toEqual(["cancel", "eof"]);');
    expect(SUITE).toContain("the ladder is finished, and says so");
  });

  /**
   * Bullet 7 asks for a hibernate that walks the ladder. It cannot: `hibernate()` refuses while
   * a turn is running, and with no turn live the ladder deliberately does not run (§13.3's
   * latency rule, and §6.7's zombie — closing stdin first lets the leader exit before §6.5's
   * ladder can reclaim its process group). What is asserted instead is the property that made
   * the bullet worth writing: the ladder does not turn a hibernate into a close.
   */
  it("bullet 7, as shipped: hibernate is asserted end-to-end, without a ladder to walk", () => {
    expect(SUITE).toContain(
      "a hibernate on an idle worker reclaims the process and keeps the RECORD",
    );
    expect(SUITE).toContain("does NOT run when there is no live turn");
  });
});
