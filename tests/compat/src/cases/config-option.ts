import type { ConfigOptionView } from "@omni-acp/protocol";
import type { Worker } from "@omni-acp/client";
import {
  allEnvelopes,
  assert,
  asRecord,
  deepEqual,
  updateKind,
  type CompatCase,
} from "./support.js";

/**
 * Compat cases for `session/set_config_option` and the live catalogue (§22, §27.2's `config-set`).
 *
 * Every case declares what it `requires`, so an agent that cannot do it is SKIPPED with a printed
 * source and a reason rather than silently passed — and the suite refuses to assert an
 * `unverified` descriptor row at all. `config-set` requires `configOptions`, which no
 * `agents.*.yaml` entry declares yet: `provides:` is `agents.{ci,local}.yaml`'s and those files
 * belong to M2-WP-J, so today this case is a sourced `capability` skip everywhere and turns on
 * with a YAML edit and no code change — which is §18.1's rule, applied to its own new case.
 *
 * **What this case deliberately does NOT assert, and why.** §27.2's claude row also asks that
 * "the next turn's `_meta.quota.model_usage[0].model` changes (F34)". That is not observable from
 * anywhere this work package can reach: the prompt RESPONSE's `_meta` is read for `usage` and
 * nothing else (`worker.ts`'s `#drivePrompt` feeds `prompt_result{stopReason, usage, meta}`, and
 * `meta` carries only the diff provider's `omni/patch`), so no envelope and no `TurnResult` ever
 * carries `quota`; and `acpConversation` — the raw-wire escape hatch a case would otherwise use —
 * takes a STATIC list of calls, so it cannot thread `session/new`'s own `sessionId` into a later
 * `session/prompt`. Both files are frozen for M2. The gap is recorded in M2-A-WP-C's notes with
 * the two candidate changes; what IS asserted below is the half §22.1 actually turns on: the
 * result replaces the catalogue wholesale, and no notification was consumed to learn it.
 *
 * Owned by M2-A-WP-C.
 */

interface Target {
  readonly id: string;
  readonly value: string | number | boolean;
}

/**
 * How the suite decides WHICH option to set, without naming an agent.
 *
 * `expect.configOption: {id, value}` in the agents file wins — that is how §27.2's two rows
 * (`model` on claude-acp, `mode: agent → read-only` on codex-acp) are expressed as DATA. With no
 * row, the target is derived from the agent's OWN catalogue, so a runtime somebody adds tomorrow
 * is covered by a YAML edit and nothing else.
 *
 * The derivation ranks by the entry's `category`, which is the agent's own taxonomy on the wire
 * and not an agent id: `mode` is ranked LAST on purpose. A permission mode is the one setting
 * whose change would alter what every later case in this run observes, and a compat suite that
 * silently relaxed an agent's permission posture to test a config route would be trading the
 * thing it is measuring for the thing it is measuring it with.
 */
const CATEGORY_RANK: readonly string[] = ["model", "thought_level", "model_config"];

function chooseTarget(
  config: { expect?: Readonly<Record<string, unknown>> },
  options: readonly ConfigOptionView[],
): Target {
  const declared = asRecord(config.expect?.["configOption"]);
  const declaredId = declared["id"];
  const declaredValue = declared["value"];
  if (
    typeof declaredId === "string" &&
    (typeof declaredValue === "string" ||
      typeof declaredValue === "number" ||
      typeof declaredValue === "boolean")
  ) {
    return { id: declaredId, value: declaredValue };
  }

  const rank = (o: ConfigOptionView): number => {
    const category = asRecord(o.raw)["category"];
    const at = typeof category === "string" ? CATEGORY_RANK.indexOf(category) : -1;
    return at === -1 ? CATEGORY_RANK.length : at;
  };

  for (const option of [...options].sort((a, b) => rank(a) - rank(b))) {
    // The agent's own offered values, verbatim. Picking anything else would be inventing a
    // choice the agent has told us it does not have (§22.2's bad-value path is a 502, and this
    // case is not about that path).
    const offered = asRecord(option.raw)["options"];
    if (!Array.isArray(offered)) continue;
    for (const entry of offered) {
      const value = asRecord(entry)["value"];
      if (typeof value !== "string" || value === option.currentValue) continue;
      return { id: option.id, value };
    }
  }
  throw new Error(
    `no option in this agent's catalogue offers a value different from its current one: ` +
      JSON.stringify(options.map((o) => o.id)),
  );
}

const idsOf = (options: readonly ConfigOptionView[] | null): readonly string[] =>
  (options ?? []).map((o) => o.id);

export function configOptionCases(): readonly CompatCase[] {
  return [
    {
      id: "config-set",
      requires: ["configOptions"],
      async run(ctx) {
        // A DEDICATED worker, not `ctx.worker()`. Setting a config option changes what the agent
        // does for the rest of the session, and the shared worker is what every other case in
        // this run is measured against — a model swap that leaked into `plain-turn` would be a
        // side effect nobody reading that case could see.
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          const before = worker.config;
          assert(
            before !== null && before.length > 0,
            `this runtime declares configOptions in provides: but ` +
              `session/new returned no catalogue at all`,
          );
          const handshake = worker.snapshot.capabilities?.configOptions ?? null;
          assert(
            handshake !== null && handshake.length === before.length,
            "WorkerSnapshot.configOptions was not seeded from the handshake catalogue",
          );

          const since = worker.snapshot.headSeq;
          const target = chooseTarget(ctx.config, before);
          const after = await worker.setConfig(target.id, target.value);

          // §22.1 trap 2: the result is a FULL REPLACEMENT. The list the promise resolved with is
          // the whole truth, and `worker.config` moved with it — synchronously, with no round
          // trip and no notification wait (§22.2's SDK row).
          assert(after.length > 0, "setConfig returned an empty catalogue");
          assert(
            deepEqual(idsOf(worker.config), idsOf(after)),
            `worker.config (${JSON.stringify(idsOf(worker.config))}) disagrees with the list ` +
              `setConfig resolved with (${JSON.stringify(idsOf(after))})`,
          );
          const set = after.find((o) => o.id === target.id);
          assert(
            set !== undefined && set.currentValue === target.value,
            `${target.id} is ${JSON.stringify(set?.currentValue)} after being set to ` +
              `${JSON.stringify(target.value)}`,
          );

          // NO PHANTOM. F34's four→two shrink is real, and merging by id is exactly what would
          // leave a control on the snapshot that the agent now refuses. An agent whose membership
          // does not churn (F35) satisfies this trivially, which is the point: replacing
          // wholesale is the only handling correct for BOTH.
          const dropped = idsOf(before).filter((id) => !idsOf(after).includes(id));
          for (const id of dropped) {
            assert(
              !idsOf(worker.config).includes(id),
              `"${id}" is absent from the method's result but survives on worker.config — ` +
                `the catalogue was merged instead of replaced`,
            );
          }

          // The DAEMON's own view, re-read by a second handle that never saw the call: the
          // replacement is state on the worker, not a cache in the SDK.
          const reattached: Worker = await ctx.harness.A.attach(worker.id);
          assert(
            deepEqual(idsOf(reattached.snapshot.configOptions ?? null), idsOf(after)),
            `a fresh attach() sees ${JSON.stringify(idsOf(reattached.snapshot.configOptions ?? null))}, ` +
              `not ${JSON.stringify(idsOf(after))}`,
          );

          // `AgentCapabilitiesSnapshot.configOptions` is frozen at handshake and is the historical
          // record (§22.2's snapshot row): the live list may shrink, this one may not move.
          assert(
            (reattached.snapshot.capabilities?.configOptions ?? []).length === handshake.length,
            "the handshake catalogue changed; it is the historical record and must not",
          );

          // §22.1 trap 1, on the wire: neither real agent notifies for a set, so the ONLY
          // `config_option_update` in this window is the one the DAEMON synthesized — and it is
          // stamped, so an agent-emitted one would still be distinguishable from ours (M2-R23).
          const envelopes = await allEnvelopes(ctx, worker.id, since);
          const updates = envelopes.filter((e) => updateKind(e) === "config_option_update");
          assert(
            updates.length === 1,
            `expected exactly one config_option_update after the set, saw ${String(updates.length)}`,
          );
          const meta = asRecord(asRecord(updates[0]?.payload)["_meta"]);
          assert(
            meta["omni/source"] === "set_config_option",
            `the synthesized config_option_update is not stamped: ` +
              `_meta is ${JSON.stringify(meta)}`,
          );
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },
  ];
}
