import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { OmniError } from "@omni-acp/protocol";
import type { Worker } from "@omni-acp/client";
import { tempDir } from "../harness.js";
import { assert, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for MCP presets, per-worker env and prompt containment.
 *
 * Every case declares what it `requires`, so an agent that cannot do it is SKIPPED with a printed
 * source and a reason rather than silently passed — and the suite refuses to assert an
 * `unverified` descriptor row at all.
 *
 * WHAT IS HERE, AND WHAT IS NOT. The two cases below are the containment REFUSALS: an
 * out-of-`cwdRoots` `resource_link`, and six malformed uri / block shapes. They assert the
 * property §26 actually cares about — the prompt is refused, the refusal elides the path, and the
 * worker is left usable — and they hold identically whether the refusal comes from
 * `Worker.prompt`'s injected `assertPromptContent` or from M0's `assertTextOnlyContent` fallback,
 * which is what makes them honest to run today.
 *
 * The case that CANNOT be written yet is the ACCEPTANCE: an inside-`cwd` `resource_link` must be
 * accepted (F37's `inside.txt`, which both real agents read without complaint). It is `400` today
 * and `202` once `packages/daemon/src/registry.ts` injects `deps.validateContent` — a file
 * M2-B-WP-S does not own — so writing it now would mean writing it backwards. The hunk is in
 * M2-B-WP-S's hand-off notes; `tests/integration/src/prompt-content.itest.ts` covers the
 * acceptance against a real process in the meantime, and
 * `packages/core/test/worker/prompt-content.test.ts` carries the guard that says whether the
 * injection has landed.
 *
 * NEITHER CASE CONSUMES A TURN, and both create their OWN worker.
 *
 *  - No turn: every prompt below is refused before anything reaches the agent, so a fixture that
 *    never answers `session/prompt` (`slow.mjs`) and a real agent that costs minutes per turn
 *    both run these for the price of the round trips. It is also the only shape that needs no
 *    `provides:` entry, so `requires` is honestly empty rather than a capability list nobody
 *    checks.
 *  - Own worker: `ctx.worker()`'s shared handle has been through `lease` (which steals control to
 *    client B) and `restart-survives` (which restarts the daemon) by the time these run, so a
 *    prompt on it can answer `423 lease_held` or `410 worker_closed` for reasons that have
 *    nothing to do with containment. A fresh worker makes the status under test the only status
 *    on offer.
 *
 * Owned by M2-B-WP-S.
 */

/**
 * The blocks below are DELIBERATELY malformed, which is what the SDK's `ContentBlock` type exists
 * to prevent. Sending them is the test, so the cast is named once, here, rather than sprinkled.
 */
type LooseBlock = Parameters<Worker["prompt"]>[0];
const block = (b: Record<string, unknown>): LooseBlock => b as unknown as LooseBlock;

/** The `OmniError` a rejected prompt threw, or a failure if it was not rejected at all. */
async function refusal(worker: Worker, content: LooseBlock, what: string): Promise<OmniError> {
  const e = await worker.prompt(content).then(
    () => null,
    (err: unknown) => err,
  );
  assert(e instanceof OmniError, `${what} was ACCEPTED, or failed with a non-OmniError`);
  return e;
}

/** `GET /v1/workers` says what the DAEMON thinks the state is, not what the handle cached. */
async function stateOf(ctx: CompatContext, workerId: string): Promise<string> {
  const snapshots = await ctx.harness.A.workers();
  const mine = snapshots.find((s) => s.workerId === workerId);
  assert(mine !== undefined, "the worker vanished from GET /v1/workers");
  return mine.state;
}

export function promptContentCases(): readonly CompatCase[] {
  return [
    {
      /**
       * F37 / F38, the recorded shape: `[text, resource_link(<cwd>/inside.txt),
       * resource_link(<other tmpdir>/outside.txt)]`. claude-acp accepted all three with no
       * `promptCapabilities` complaint and expanded each link into its own `Read`; codex-acp
       * asked nothing and read both files in one call whose `locations` names only the inside
       * one and whose `rawInput` is absent entirely. Containment is ours, before the send, or it
       * does not exist.
       */
      id: "prompt-content-out-of-cwd-link",
      requires: [],
      async run(ctx) {
        const outside = await tempDir("omni-compat-outside-");
        const secret = join(outside, "outside.txt");
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          await writeFile(secret, "OUTSIDE-SECRET-BETA\n");

          const rejected = await refusal(
            worker,
            block({ type: "resource_link", uri: pathToFileURL(secret).href, name: "outside" }),
            "an out-of-cwdRoots resource_link",
          );
          assert(
            rejected.status === 400,
            `an out-of-cwdRoots resource_link answered ${String(rejected.status)}, not 400`,
          );
          assert(
            rejected.code === "bad_request",
            `an out-of-cwdRoots resource_link answered code ${rejected.code}`,
          );

          // The message ELIDES the path, so a probe cannot use the 400 to map the filesystem —
          // and cannot use it to read one either.
          assert(
            !rejected.message.includes(outside) &&
              !rejected.message.includes("outside.txt") &&
              !rejected.message.includes("OUTSIDE-SECRET-BETA"),
            "the rejection echoed the path or the file back to the caller",
          );

          // THE ADMISSION WAS ROLLED BACK. A worker left `running` by a rejected prompt answers
          // `409 worker_busy` for the rest of its life, which is how a containment gate placed
          // one line too early turns one bad request into a dead worker (M2-PLAN §1.6 ruling 7).
          assert(
            (await stateOf(ctx, worker.id)) === "ready",
            "the worker is not ready after a rejected prompt: the admission was not rolled back",
          );
        } finally {
          await worker.close().catch(() => {});
          await rm(outside, { recursive: true, force: true }).catch(() => {});
        }
      },
    },

    {
      /**
       * §26.2's uri table, minus the symlink row — a compat case cannot make a symlink inside a
       * REAL agent's workspace without also asking that agent to read it, and the symlink escape
       * is tested against a real `realpath` in `core/test/worker/prompt-content.test.ts` and
       * `tests/integration/src/prompt-content.itest.ts` instead.
       */
      id: "prompt-content-bad-uri",
      requires: [],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          const cases: Record<string, Record<string, unknown>> = {
            "a relative uri": { type: "resource_link", uri: "notes.txt", name: "n" },
            "a bare absolute path": { type: "resource_link", uri: "/etc/shadow", name: "n" },
            "a non-file scheme": {
              type: "resource_link",
              uri: "https://example.invalid/x",
              name: "n",
            },
            "a `..` traversal": {
              type: "resource_link",
              uri: `${pathToFileURL(ctx.cwd).href}/../../etc/shadow`,
              name: "n",
            },
            "a uri with a host": { type: "resource_link", uri: "file://server/share/x", name: "n" },
            "an unknown block type": { type: "terminal", terminalId: "t1" },
          };

          for (const [what, shape] of Object.entries(cases)) {
            const rejected = await refusal(worker, block(shape), what);
            assert(rejected.status === 400, `${what} answered ${String(rejected.status)}, not 400`);
            assert(rejected.code === "bad_request", `${what} answered code ${rejected.code}`);
          }

          assert(
            (await stateOf(ctx, worker.id)) === "ready",
            "the worker is not ready after six rejected prompts",
          );
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },
  ];
}
