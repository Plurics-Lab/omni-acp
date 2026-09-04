import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { OmniError, type ProbeSummary } from "@omni-acp/protocol";
import type { Worker } from "@omni-acp/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compatCases, type CompatCase, type CompatContext } from "./cases.js";
import { compatDir, type CompatAgentConfig, type CompatSelection } from "./config.js";
import { startCompatHarness, type CompatHarness } from "./harness.js";

/**
 * Runs `compatCases()` against every selected agent and writes `compat-report.json`
 * UNCONDITIONALLY — a run that produced no report is a run nobody can argue with (§18.2).
 *
 * Two rules it must not soften:
 *
 *  - a skip carries a source and a reason, and a skip with NO source is a failure;
 *  - `OMNI_COMPAT_REQUIRE=1` fails an EMPTY selection, so "green because it ran nothing" is not
 *    a state this suite can reach silently.
 *
 * Owned by M1-WP-F.
 */

export type SkipSource = "config" | "capability" | "precondition";

export interface CompatResult {
  readonly agent: string;
  readonly case: string;
  readonly status: "passed" | "failed" | "skipped";
  readonly source?: SkipSource;
  readonly reason?: string;
  readonly durationMs: number;
}

export interface CompatReport {
  readonly at: string;
  readonly platform: NodeJS.Platform;
  readonly config: string;
  readonly real: boolean;
  readonly agents: readonly string[];
  readonly skippedAgents: CompatSelection["skipped"];
  readonly results: readonly CompatResult[];
  readonly totals: {
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
  };
}

/**
 * Which capabilities this agent is known to have, and where each answer came from.
 *
 * `resume` is MEASURED — `ProbeSummary.resumeMethod` is the probe's own answer and no YAML may
 * contradict it. The other three cannot be probed for (no method battery can tell you whether an
 * agent will reach for a tool when you ask it something), so they are DECLARED in `provides:`.
 * The distinction matters because a declared capability that turns out to be absent fails a case,
 * where a measured one skips it — and only the second is honest about a machine's limits.
 */
function capabilitiesOf(agent: CompatAgentConfig, probe: ProbeSummary): ReadonlySet<string> {
  const provided = new Set(agent.provides ?? []);
  if (probe.resumeMethod !== null) provided.add("resume");
  else provided.delete("resume");
  return provided;
}

/** Why this case will not run for this agent, or `null` to run it. */
function skipFor(
  agent: CompatAgentConfig,
  probe: ProbeSummary,
  test: CompatCase,
): { source: SkipSource; reason: string } | null {
  // The `config` source first: an explicit YAML entry is the operator's deliberate decision and
  // outranks anything derived, so a case that is BOTH skipped and unsupported reports the reason
  // somebody actually wrote.
  const declared = agent.skip?.find((s) => s.case === test.id);
  if (declared !== undefined) return { source: "config", reason: declared.reason };

  // The `capability` source. §17.2's descriptor `unverified` list is the single source of truth
  // and the YAML's copy restates it; either naming the case or one of its requirements is a gap
  // rather than a failure (§18.3, review R8).
  const unverified = new Set(agent.unverified ?? []);
  if (unverified.has(test.id)) {
    return { source: "capability", reason: `"${test.id}" is unverified for this runtime (§17.2)` };
  }
  const have = capabilitiesOf(agent, probe);
  for (const need of test.requires) {
    if (unverified.has(need)) {
      return { source: "capability", reason: `"${need}" is unverified for this runtime (§17.2)` };
    }
    if (!have.has(need)) {
      return {
        source: "capability",
        reason:
          need === "resume"
            ? "the probe reports no resume spelling for this runtime"
            : `this runtime does not declare "${need}" in provides:`,
      };
    }
  }
  return null;
}

/** Short prompts, because a real agent's turn costs money and time (corpus finding 15). */
const PROMPTS = {
  plain: "Reply with the single word OK.",
  read: "List the files in this directory and tell me how many there are.",
  write: "Create a file report.txt whose first line is exactly OMNI-M1.",
  remember: "Remember the token OMNI-M1 and reply OK.",
  recall: "What token did I ask you to remember?",
} as const;

function reportPathOf(path: string): string {
  return isAbsolute(path) ? path : join(compatDir(), path);
}

export function runCompatSuite(selection: CompatSelection, o: { reportPath: string }): void {
  const results: CompatResult[] = [];
  const path = reportPathOf(o.reportPath);

  /**
   * Written in a file-level `afterAll`, so it exists whatever happened — including a run whose
   * selection was empty, which is the run whose report a reader most needs (§18.2). Vitest runs
   * file-level hooks even when every test was skipped.
   */
  afterAll(() => {
    const report: CompatReport = {
      at: new Date().toISOString(),
      platform: process.platform,
      config: selection.path,
      real: process.env["OMNI_COMPAT_REAL"] === "1",
      agents: selection.selected.map((a) => a.id),
      skippedAgents: selection.skipped,
      results,
      totals: {
        passed: results.filter((r) => r.status === "passed").length,
        failed: results.filter((r) => r.status === "failed").length,
        skipped: results.filter((r) => r.status === "skipped").length,
      },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  });

  describe("selection", () => {
    it("is not silently empty", () => {
      for (const skip of selection.skipped) {
        // §18.3's rule, enforced rather than described: a skip with NO source is a failure, and a
        // reason short enough to be decorative is the same thing one milestone later.
        expect(skip.source, `agent "${skip.id}" was skipped with no source`).toBeDefined();
        expect(skip.reason.length, `agent "${skip.id}" was skipped with no reason`).toBeGreaterThan(
          9,
        );
      }
      if (selection.required) {
        // A mis-set `OMNI_COMPAT_AGENTS` must not masquerade as a pass.
        expect(
          selection.selected.length,
          `OMNI_COMPAT_REQUIRE=1 and no agent was selected from ${selection.path}`,
        ).toBeGreaterThan(0);
      }
    });
  });

  for (const agent of selection.selected) {
    describe(agent.id, () => {
      let harness: CompatHarness | null = null;
      let probe: ProbeSummary | null = null;
      let shared: Worker | null = null;
      let setupError: unknown = null;

      beforeAll(async () => {
        try {
          harness = await startCompatHarness(agent);
          // §4 step 0. Its `ProbeSummary` drives every `capability` skip below, so a missing
          // capability is reported as a skip rather than as a failure.
          probe = (await harness.A.probe(agent.id)).probe;
        } catch (e) {
          // A setup failure must not take the whole file down with an unreadable stack: it is
          // recorded against every case of this agent, and the report says so.
          setupError = e;
        }
      });

      afterAll(async () => {
        await harness?.dispose();
        harness = null;
      });

      const context = (): CompatContext => {
        if (harness === null || probe === null) {
          throw OmniError.from(setupError ?? new Error("the compat harness did not start"));
        }
        const live = harness;
        return {
          agentId: agent.id,
          serverUrl: live.url,
          token: live.tokenA,
          cwd: live.workspace,
          harness: live,
          probe,
          config: agent,
          prompts: PROMPTS,
          async worker(): Promise<Worker> {
            // Re-attached rather than cached blindly: a case that hibernated or closed it would
            // otherwise hand the next case a handle whose state is a lie.
            if (shared !== null) return live.A.attach(shared.id);
            shared = await live.A.createAgent(agent.id, { cwd: live.workspace });
            return shared;
          },
        };
      };

      /**
       * §18.2's four `claude-acp` rows — `plan-update`, `agent-thought`, `current-mode-update`,
       * `git-patch` — name CORPUS GAPS rather than cases in this suite, and M1-PLAN §5's
       * definition of done asks that they "stay visible in every run rather than decaying into
       * silence". A declared skip whose case this suite does not implement is therefore REPORTED
       * under its own name with its own reason, instead of being silently dead config.
       */
      const implemented = new Set(compatCases().map((c) => c.id));
      for (const declared of agent.skip ?? []) {
        if (implemented.has(declared.case)) continue;
        it(`${declared.case} (declared gap)`, (t) => {
          results.push({
            agent: agent.id,
            case: declared.case,
            status: "skipped",
            source: "config",
            reason: declared.reason,
            durationMs: 0,
          });
          t.skip(`config: ${declared.reason}`);
        });
      }

      for (const test of compatCases()) {
        it(test.id, async (t) => {
          const started = Date.now();
          const skip = probe === null ? null : skipFor(agent, probe, test);
          if (skip !== null) {
            results.push({
              agent: agent.id,
              case: test.id,
              status: "skipped",
              source: skip.source,
              reason: skip.reason,
              durationMs: 0,
            });
            t.skip(`${skip.source}: ${skip.reason}`);
            return;
          }
          try {
            await test.run(context());
            results.push({
              agent: agent.id,
              case: test.id,
              status: "passed",
              durationMs: Date.now() - started,
            });
          } catch (e) {
            results.push({
              agent: agent.id,
              case: test.id,
              status: "failed",
              reason: e instanceof Error ? e.message : String(e),
              durationMs: Date.now() - started,
            });
            throw e;
          }
        });
      }
    });
  }
}
