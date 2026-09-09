# omni-acp — M2 Delivery Plan

> Companion to `docs/CONTRACTS.md` (binding shapes, now M2) and `docs/DESIGN.md` v0.8 (binding decisions).
> This document says **who builds what, in which files, and what "done" means**.
>
> M0 and M1 are done and green on `main` (2166 tests, three OSes). M2's goal, from DESIGN §11:
> *InteractionRequest + 策略引擎（三种 onUnresolved、deny 规则）；认证 / ACL / cwd 白名单 / mcpServers preset +
> capabilities 过滤；webhook 投递与重试；git diff provider；idle watchdog 双预算；Runtime 描述符与 quirk 表.*
>
> **M2 ships in two slices.** **M2-A** — the interaction lifecycle, the idle watchdog, the config route
> (CONTRACTS §19, §21, §22). **M2-B** — the policy engine, MCP presets and env, the Run API and webhooks,
> the diff provider and prompt containment (§20, §23, §24, §25, §26). M2-A is **independent of M2-B and
> must be shippable alone**: with no engine, provider, dispatcher or run registry injected, the daemon is
> M1 plus a park, and the whole M1 suite proves it (ruling M2-R1).
>
> **Real-agent runs use `claude-acp` and `codex-acp`, and no others.** They are the only two ACP agents
> installed on this machine (`npx -y @agentclientprotocol/claude-agent-acp@0.73.0`, logged-in Claude Code;
> `npx -y @agentclientprotocol/codex-acp@1.8.0`, ChatGPT login). **No other agent may be installed.** They
> are YAML entries somebody else adds later, with zero code changes.

---

## 1. The M2 Land step — run once, alone, before any work package

**The Land step is not a work package.** It is a single preparatory commit by one owner. It produces
everything that would otherwise be a guaranteed merge conflict, and it produces every new source file as a
**signature-complete stub whose body throws**, so that `pnpm -r build && pnpm test` is green on all three
OSes with M1's 2166 tests still passing and every new test `todo`, before a single line of M2 behaviour
exists.

This is M0-PLAN §1's and M1-PLAN §1's scaffold discipline, reused unchanged, because it is the thing that
made six parallel packages work twice. M2 has **more** cross-cutting features than M1 and exactly one file
that all of them want — `packages/core/src/worker/worker.ts` — so the Land step is bigger and the seams are
named more tightly.

### 1.1 What the Land step produces

**Permanently Land-owned — frozen for the whole of M2** (nobody else ever edits these):

```
package.json  pnpm-lock.yaml  tsconfig*.json  vitest.config.ts  .github/workflows/*.yml
packages/*/package.json   packages/*/tsconfig.json   packages/*/vitest.config.ts
packages/*/src/index.ts                              ← re-export barrels, re-export-only
packages/protocol/src/*.ts   EXCEPT turn.ts          ← every §5.8 diff lands here first
packages/core/src/worker/worker.ts                   ← the nine named hunks (§1.2), then FROZEN
packages/core/src/acp/link.ts                        ← ONE registration: elicitation/create
packages/core/src/worker/handshake.ts                ← clientCapabilities becomes a parameter (F42)
packages/core/src/normalizer/turn-lifecycle.ts       ← ONE hunk: prompt_result.meta (seam D)
packages/daemon/src/http/routes/{index,workers}.ts
packages/daemon/src/types.ts                         ← re-export-only
packages/client/src/worker.ts                        ← three delegating members, then FROZEN
packages/testkit/src/{index,scripted-agent}.ts       ← +1 generic client-request hook
packages/testkit/src/stub-daemon.ts                  ← WP-I, WP-C and WP-R all build route tests on it
tests/compat/src/cases/index.ts                      ← the case registry (the cases/ split, §1.4)
tests/compat/src/cases/support.ts                    ← CompatCase/CompatContext + the shared assertions
tests/compat/src/{harness,runner,config}.ts
```

The last two rows are the files where six packages could still meet (review R9, R17). The rule is the one
this plan already applies elsewhere: **a work package that needs a new shared helper puts it in its own case
or test file, and a widening of `CompatContext` or of `stubDaemon` is a REQUEST to the Land owner.**
`stubDaemon` already takes `Partial<Daemon>`, so no work package needs to edit it to override a verb.

**Land-written, then TRANSFERRED permanently** (one owner each, and nobody else may edit them):

| file | to |
| ---- | -- |
| `packages/protocol/src/turn.ts` | **M2-WP-W** (`strandedToolCalls`, `patch`, `patchInfo`, the widened `InteractionRecord`) |
| `packages/core/src/worker/session-open.ts` | **M2-WP-I** (F42's wake-path fix lives here) |
| `packages/core/src/worker/permission-responder.ts` | **M2-WP-P** (`selectOption` extraction) |
| `packages/core/src/persist/schema.ts` | **M2-WP-R** (the v2 CREATE-only migration) |
| `packages/daemon/src/{registry,create-daemon,auth}.ts` | **M2-WP-J** (all daemon wiring) |
| `packages/core/src/runtime/known.ts` | **M2-WP-J** (the descriptor rows and `unverified` entries) |

**Created by the Land step, then handed over permanently:** every other new
`packages/**/src/**/*.ts`, `tests/compat/src/cases/*.ts` and each new `*.itest.ts`, with the exact signature
from CONTRACTS §5.8 and a body of `throw new OmniError("internal", "unimplemented: M2-WP-x")`, plus one
`it.todo()` per acceptance bullet below.

`tests/compat/agents.{ci,local}.yaml` are **NOT** frozen — they are WP-J's, exactly as they were WP-F's in
M1. WP-J is the only package that reads them, so freezing them buys no disjointness and costs the milestone
the ability to fix its own data.

### 1.2 The nine `worker.ts` hunks — named, so nobody re-opens the file

`worker.ts` is 1884 lines and every M2 feature wants it. It is edited **once**, by the Land step, in nine
named places, and then frozen. **Every new dependency is OPTIONAL, and with all of them absent the file
compiles and `core/test/worker/**` passes unedited** — that is Land exit criterion 8 and it is the proof
that the seams are real rather than aspirational.

| # | hunk | default when the dep is absent |
| - | ---- | ------------------------------ |
| 1 | `CreateWorkerDeps` gains six optional fields: `interactions?`, `watchdog?`, `diff?`, `validateContent?`, `clientCapabilities?`, `mcpServers?`, plus `limits.parkTimeoutMs?` and `limits.diffTimeoutMs?` (review R14) | M1 |
| 2 | `#onPermissionRequest` → `this.#interactions.permission(mapped, ctx)`. M1's responder path becomes `baselineInteractions`'s body and moves out of this file **unchanged in behaviour** | M1 (baseline wrapper, byte-identical envelopes) |
| 3 | `#onElicitation(params)` registered on the link; `mapElicitation` → `this.#interactions.elicitation(...)` | never called — the capability is not declared, and D10 says answer `decline` if it arrives anyway |
| 4 | `#park(id)` / `#unpark(id)` — refcounted `running ⇄ requires_action`; the lease pin is **held**, the hibernate timer stays paused, and the watchdog is disarmed | never called |
| 5 | `answerInteraction(reqId, a, who)` — `lease.assertHolder(who)` **first**, exactly as `prompt`/`cancel`/`wake` do (F22's payoff, again) | throws `interaction_not_found` (no strategy, nothing pending) |
| 6 | `setConfig(body, who)` — lease-gated, `worker_busy` while running, auto-wake, the `mapRequest` spelling loop (`-32601` ⇒ `noteUnsupported` ⇒ next spelling), `#configOptions` replaced **wholesale** from the result, and the synthesized `config_option_update` fed as an `agent_update` so the DESCRIPTOR decides whether it lands | `agent_error` (`-32601`) when every spelling is exhausted |
| 7 | watchdog feed: `observe()` on every append, at prompt admission, at turn end, at park/unpark; `onFire` → `cancelInternal()` → M1's **existing** `cancel_timeout` escalation | disarmed |
| 8 | diff: `begin({cwd, workerId, signal})` at admission; `end(handle, {signal})` **immediately before** `#feed({type:"prompt_result", meta:{"omni/patch": p}})`. **Both bounded by `limits.diffTimeoutMs`** with an `AbortController`, and expiry stamps a real `PatchResult{quality:"unavailable"}` carrying `TurnWarning{code:"patch_timeout"}` rather than dropping the key (review R14) | `patch: null` |
| 9 | `await (this.#deps.validateContent ?? assertTextOnlyContent)(content)` in `prompt()`, immediately after the check-and-set, rolling the admission back on rejection. The fallback is spelled **differently** from the injected `assertPromptContent` so a name-matching guard cannot pass while the injection is missing (review R2) | M0's text-only whitelist |

Hunk 3 depends on a one-line `link.ts` edit, and **the parser it uses is the single most important line in
this plan**:

```ts
.onRequest("elicitation/create", verbatim, (ctx) => h.onElicitation(ctx.params))
```

A `z.object` parse would strip `_meta._askUserQuestionCustomAnswer` — the marker that decides which of two
properties the agent will actually read (F30: our accept filled both and it created `omni-choice.txt`
instead of `notes.md`) — and would strip the **flat** `sessionId`/`toolCallId`, the only scope the request
carries (F29). `link.ts` already uses `verbatim` for `session/request_permission` (F43), so this is a
registration and not a mechanism; the `no-elicitation-schema-parse` guard fails the build on any regression.

**Hunk 6 is a BODY, not a stub** (review R12). `setConfig` had no seam any work package could reach: it ran
the gates and then threw `unimplemented`, `CreateWorkerDeps` had no config hook, and `worker.ts` is frozen
afterwards — so M2-A-WP-C's acceptance 1-6 and 8 all needed a frozen file. The wire call therefore lives
here, and `core/src/worker/config-options.ts` keeps only the PURE halves WP-C owns and unit-tests against
transcripts `15` and `07` with no link at all: `viewConfigOptions` (the entry view, `raw` by identity) and
`configOptionsDelta` (the `removed`/`added` membership delta). `setConfigOption` is gone from §5.8.9 for the
same reason: its body is this hunk.

### 1.3 The four seams

**Seam A — `InteractionStrategy` supersedes `PermissionResponder` by wrapping it.** M1 already injects a
`PermissionResponder`; M2 does not widen it, it wraps it, so every M1 behaviour is preserved *by
construction* rather than by care:

```ts
export function baselineInteractions(r: PermissionResponder, clock: Clock): InteractionStrategy {
  return {
    clientCapabilities: {},                       // D10: no park ⇒ no elicitation
    async permission(req, ctx) {
      const decided = r.decide(req);              // ← M1's exact call
      ctx.emit(envelopesFor(decided, req));       // ← M1's exact two envelopes, in M1's order
      if (decided.response === null) throw AcpRequestError.internalError(…);
      return decided.response;
    },
    async elicitation() { return { action: "decline" }; },     // D10, and never reached
    answer() { throw new OmniError("interaction_not_found", "no interaction is awaiting an answer"); },
    get pending() { return []; }, async settleAll() {}, close() {},
  };
}
```

The real strategy (WP-I) differs in exactly one place — it consults an injected
`decide: (subject) => PolicyVerdict`, defaulting to
`() => ({action: onUnresolved, rule: "m2:onUnresolved", source: "default", clamped: null})`. **That default
is why WP-I and WP-P are file-disjoint and can land in either order**, and why M2-A ships without M2-B.

**Seam B — `Watchdog`, split pure/timer exactly like `HibernateTimer`.** `watchdogStep(state, signal, cfg)`
is the fold and lives in its own file with **no clock and no process**; `createWatchdog` wraps it in one
`Clock.setTimer`. Every corpus lesson becomes a table row: *"a `session_info_update` arriving 20 ms after
the prompt response re-arms the silent budget"* (F25 — it is an `envelope` signal like any other, which is
exactly why the window is anchored on it), *"a `tool_call` with no terminal update keeps the tool budget
armed until `turn_end`"* (F36), *"a park disarms both budgets and unparking re-bases"* (M2-R21).

**Seam C — `DiffProvider` reaches git only through the injected `RunUtility`.**
`core/test/process/no-direct-spawn.test.ts` already forbids `node:child_process` anywhere but
`core/src/process/spawn.ts`, so the provider takes the same `RunUtility` `fingerprint.ts` uses for `ps`.
Its unit tests then need **no git installed at all**.

**Seam D — the patch reaches a pure fold through one generic hunk.** `TurnInput.prompt_result` gains
`meta?: Record<string, unknown>`, merged into `state_update{idle}._meta` — the channel `omni/vendorPatch`
and `omni/warnings` already ride (§12.5). The reducer does not know what any key means, which is what lets
WP-J's git provider land with **zero** edits to `turn-lifecycle.ts` (ruling M2-R9).

Concretely, and the whole of it: `TurnLifecycleState` carries `meta`, the `prompt_result` case sets it from
`input.meta ?? state.meta` on **all three** branches (settle-now, settling and `rung > 0`), `IDLE` resets it,
and `idle()` merges it into the local `_meta` record **before** stamping `omni/warnings` and
`omni/vendorPatch` — so a provider key can never overwrite a reducer key. A turn with no meta emits
byte-for-byte M0's payload, and `turn-lifecycle.test.ts`'s "seam D" block asserts both halves. Review R10 is
the record that this hunk was declared and not written the first time; the chain
`worker.ts → prompt_result.meta → idle._meta → reduceTurn` is dead at any missing link and produces the same
`patch: null` a working M1 daemon produces, which is why it needs its own test rather than a reader's care.

**A seam is DISPOSED, not only fed.** `InteractionStrategy.close()` and `Watchdog.cancel()` are called from
every teardown path — `#doClose`, `#doHibernate` and the crash-hibernate — beside the three timer cancels
that are already there (review R15). `settleAll` returns a promise and every caller awaits it, because the
whole point of §19.8 is an ordering (`settleAll` **then** `session/cancel`) that a `void` method cannot
express (review R1).

### 1.4 The two splits that keep six packages out of one file

Both are Land-owned mechanics, both reused from M1's routes split.

**Compat cases.** `tests/compat/src/cases.ts` becomes a directory, so six work packages never meet:

```
tests/compat/src/cases/index.ts          ← Land: `export const CASES = [...m1, ...permission, …]`
tests/compat/src/cases/m1.ts             ← M1's 13 cases, moved VERBATIM, then FROZEN
tests/compat/src/cases/elicitation.ts    ← WP-I     permission.ts ← WP-P
tests/compat/src/cases/config-option.ts  ← WP-C     watchdog.ts   ← WP-W
tests/compat/src/cases/webhook-run.ts    ← WP-R     patch.ts      ← WP-J
tests/compat/src/cases/prompt-content.ts ← WP-S
```

**Client channels.** `client/src/worker.ts` stays frozen because each feature gets its own *channel* file,
exactly as M1 already did for `client/src/lease.ts`:

```ts
const interactions = createInteractionChannel(transport, id, bus);   // client/src/interactions.ts — WP-I
const config       = createConfigChannel(transport, id, () => current);  // client/src/config.ts   — WP-C
return { …, lease,
  get interactions() { return interactions.pending; },
  get config()       { return config.options; },
  setConfig: (k, v)  => config.set(k, v) };
```

`on("interaction", cb)` is one more arm in the existing `bus` switch — Land-written, delegating to
`interactions.handleEnvelope(e)`.

### 1.5 Land step exit criteria

1. `pnpm -r build && pnpm test` green on ubuntu-latest, macos-latest **and** windows-latest, with **all 2166
   M1 tests still passing**, every new body throwing `OmniError("internal","unimplemented: M2-WP-x")` and
   every new test `todo`.
2. An **unmodified M1 config file still parses**, and `DaemonConfig.parse({tokens:[…]})` yields every new
   default (`policy`, `mcpServers`, `watchdog`, `interaction`, `diff`, `webhooks`, `run`, `envDeny`).
3. `eventEnvelopeSchema` round-trips: an `acp.interaction{kind:"elicitation", status:"pending", park, raw,
   toolCallId}`, an `omni.policy_decision{decision:"answer", ruleSource, clamped}`, an
   `omni.worker_state{state:"requires_action", reason:"interaction_parked", watchdog, interactions}`, and an
   `omni.run`. **A checked-in M1 `events.db` parses under the M2 schema** in a golden test.
4. `ERROR_STATUS` is still total over `OmniErrorCode` at **compile** time, and exactly **two** codes were
   added (`interaction_not_found`, `interaction_settled` — ruling M2-R2). `CLOSE_REASON_CODE` is still total
   over `WorkerCloseReason` and **no close reason was added**.
5. `M2_WORKER_STATES` is exported; `M1_WORKER_STATES` and `M0_WORKER_STATES` are unchanged and still
   exported.
6. `packages/daemon/src/http/sse.ts` is **byte-identical** and the `sse-is-unchanged` checksum guard passes —
   the Run API proxies the worker log rather than adding a stream writer.
7. **No new external dependency.** Glob matching, HMAC (`node:crypto`), CIDR parsing and git (through the
   injected `RunUtility`) are all built-in. `pnpm install --frozen-lockfile` followed by
   `git diff --exit-code pnpm-lock.yaml` is clean.
8. **`worker.ts` compiles with every new `CreateWorkerDeps` field ABSENT and `core/test/worker/**` passes
   unedited** — the proof that M1 behaviour is the default and not a migration.
9. `@omni-acp/protocol` still imports no other `@omni-acp/*` package; the §3.1 DAG holds.

### 1.6 What the Land step actually produced, where it differs from §1.1–§1.5, and why

The Land step ran, was reviewed adversarially, and the review's eighteen findings were applied. The rows
below are the deviations from the plan as written above — each one a decision with a reason, recorded here so
a work-package owner reads the plan and the tree saying the same thing.

| # | deviation | why |
| - | --------- | --- |
| 1 | `tests/compat/src/cases/index.ts` is **Land-owned**, and §3's row now gives WP-J only `cases/patch.ts` | §1.1 and §3 disagreed. Resolved in favour of §1.1 and made moot: `index.ts` already imports all eight case files including the seven empty ones, so no work package ever edits the registry to add its cases |
| 2 | `tests/compat/src/cases/support.ts` is a NEW Land-owned file | the split needed somewhere for `CompatCase`/`CompatContext` and the five shared helpers; putting them in `index.ts` would make every case file import the registry that imports it. Content is verbatim from the old `cases.ts` (review R9, R17) |
| 3 | the seven per-package compat case factories return `[]` rather than throwing | `runner.ts` enumerates every case at LOAD, so a factory that threw would take M1's thirteen green cases with it. `[]` is the honest "this package has recorded no case yet", and `OMNI_COMPAT_REQUIRE=1` still turns an empty selection into a failure. Each file's header says so |
| 4 | every M2 row on `WorkerSnapshot` / `WorkerRow` / `AgentCapabilitiesSnapshot.clientCapabilities` is optional; so are `InteractionPayload.{kind,raw,toolCallId,answer.parkedMs}` and `PolicyDecisionPayload.{kind,method,by,ruleSource,parkedMs}`; `CreateWorkerRequest`'s TS type is `z.input`; `PolicySelection` lives in `control-plane.ts` | all four are recorded in CONTRACTS §5.8's preamble with the reason. The load-bearing one is the payload optionality: Land exit criterion 3 requires an **M1** `events.db` to parse under the M2 schema, and an M1-written envelope carries none of those fields |
| 5 | `Watchdog` gained a fourth member, `readonly config: ResolvedWatchdogConfig` | `WorkerSnapshot.watchdog` must report the resolved budgets and `worker.ts` is frozen; a worker handed the numbers a second time can disagree with its own watchdog. Recorded at the declaration and in CONTRACTS §5.8.8 |
| 6 | `TurnResult.strandedToolCalls` is declared and **stubbed to `[]`** | computing it at Land would flip `permission-deny` and `tool-call-upsert` from `ok` to `partial` — i.e. implement behaviour, which the Land step must not, and which WP-W acceptance 8 says must not happen. **It stays M2-A-WP-W's to compute**, and M2-R8's full rule is spelled out at the stub so WP-W implements a written rule rather than an inferred one. The precedent is M1's `patch: null`. `pendingInteractions` IS folded, because it is provably `[]` on every M1 golden |
| 7 | hunk 9 runs immediately **after** `#state = "running"`, not before the check-and-set | the M1 call sat before it, and an `await` there reopens the 50-concurrent-callers race the admission exists to close. The rollback on rejection is the existing `#step`-failure path, so the `400` still comes from `prompt()` (H8 unmoved) and F37/F38's "zero `session/prompt` calls" holds by construction |
| 8 | `mapElicitation` is a free function on `@omni-acp/core`, not a `Normalizer` member, and `worker.ts` carries a small `mapElicitationFallback` | it is pure, total and holds no descriptor, so there is nothing per-runtime to branch on. The fallback returns the honest unparseable shape (`fields: []`, every property in `unmodelled`) — and since review R11 it also carries `raw`, which is what lets WP-I's real mapper run without reopening a frozen file |
| 9 | `seqIds().request()`'s prefix is `q_`, not `r_` | `r_` is now `RunId`, and a fake whose opaque request ids look exactly like real run ids is a collision an `assertRunId` test would pass for the wrong reason |
| 10 | the M1 corpus set is NAMED rather than globbed | `07e1086` added seven M2 transcripts without updating the M1 counts, so `corpus.test.ts` and the event-log acceptance were **already red on `main`** — confirmed by stashing and re-running. `corpus.test.ts` now asserts BOTH numbers, 11 M1 and 18 on disk, so a transcript nobody uses is still visible |
| 11 | F42 is left UNFIXED in `session-open.ts`'s wake path | WP-I acceptance 2 is a regression test written FIRST; landing the fix would leave it passing on arrival. `handshake.ts` already threads `clientCapabilities` and records it AS SENT |
| 12 | the seven fixture agents and the eight named guard tests were **not** created | they are behaviour, not signatures: each fixture encodes a recorded wire shape its owning package must get right, and several guards are specified as having to be demonstrated FAILING on a planted violation, which a stub cannot do. §3's "guard tests live with their owner" stands |
| 13 | `Daemon.runs` / `Daemon.deliveries` are REQUIRED members filled by `unimplementedRuns()` / `unimplementedDeliveries()`; only the two list-shaped reads answer empty | every verb answers `bad_request` naming M2-B-WP-R — D29's honest "not implemented yet", the M1 Land precedent. A `list()` returning `[]` would say there are no runs, which is a different and worse lie |
| 14 | `AuthContext.assertEnv(undefined)` and `assertMcp(undefined)` answer honestly instead of throwing | a request that asked for no env and no MCP is every M1 request, and refusing it would refuse the whole existing suite. Every non-empty case throws naming M2-B-WP-S. `assertPolicy` always throws — there is no "asked for nothing" reading of a policy question |
| 15 | `persist/schema.ts` still says `SCHEMA_VERSION = 1`; `agents.{ci,local}.yaml` and `runtime/known.ts`'s new rows are untouched | all three are a work package's, named in §1.1 and §2. The files were transferred, not edited |
| 16 | four blockers and eleven other findings from the 2026-09-09 review were applied on top of the Land commit | `docs/review/2026-09-09-m2-contract-review.md` carries the per-finding 处理记录. The four blockers were seams that had been declared and not wired: seam D's hunk in `turn-lifecycle.ts`, the raw request on both interaction arms, `Worker.setConfig`'s body, and the testkit's generic client-request hook |

---

## 2. Work packages

Seven packages, **file-disjoint after the Land step**. **M2-A is WP-I, WP-W and WP-C**, and none of the three
depends on the others or on any M2-B package — each compiles against Land stubs and testkit fakes and is
unit-testable alone. M2-B is WP-P, WP-S and WP-R, likewise mutually independent. WP-J is the join, exactly as
WP-F was in M1.

```
                     ┌──► M2-A-WP-I  interactions · park · elicitation ─┐
Land ────────────────┼──► M2-A-WP-W  idle watchdog · turn projection    │
                     └──► M2-A-WP-C  config options · SDK config        │   ← M2-A ships here
                     ┌──► M2-B-WP-P  policy engine · ceiling            │
                     ├──► M2-B-WP-S  mcp presets · env · containment    │
                     └──► M2-B-WP-R  runs · webhooks · schema v2        │
                                                                        └──► M2-WP-J  diff · wiring
                                                                                      compat · CLI
```

---

### M2-A-WP-I — InteractionRequest: park / deny / fail, elicitation, `requires_action`

**Owns exclusively**

```
packages/core/src/worker/interaction/**          strategy.ts baseline.ts registry.ts park.ts capability.ts
packages/core/src/worker/session-open.ts         ← Land-written, transferred (F42's wake-path fix)
packages/core/src/normalizer/map/elicitation.ts
packages/core/test/worker/interaction/**
packages/core/test/worker/permissions.test.ts             ← transferred by review R4 (M2-R3's payloadVersion flip)
packages/core/test/normalizer/{elicitation.test.ts,support/emit.ts}
packages/core/test/normalizer/golden/{03,04,09,10}-*.envelopes.json
packages/daemon/src/http/routes/interactions.ts
packages/daemon/test/http/interactions.test.ts
packages/client/src/interactions.ts
packages/client/test/interactions.test.ts
packages/testkit/src/interaction-conformance.ts
packages/testkit/src/scripts/elicitation.ts
packages/testkit/fixtures/agents/elicit-{oneof,custom,multi,never-answers}.mjs
tests/compat/src/cases/elicitation.ts
tests/integration/src/{interaction-park,interaction-timeout,elicitation-gate}.itest.ts
```

**dependsOn**: Land only.

**Acceptance**

1. `runInteractionConformance` passes for **`baselineInteractions` and the real strategy**, and the baseline
   run's envelopes are **identical to M1's modulo `payloadVersion` and the additive fields** — asserted
   against a checked-in **M2** golden (review R4). Ruling M2-R3 flips `acp.interaction` to `payloadVersion 2`
   with a mapped `request` beside `raw`, and §19.10 adds `kind`/`toolCallId`/`answer.parkedMs`, so a
   byte-identical claim was never satisfiable; what IS asserted is that nothing else moved and that no M1
   assertion is weakened. The files this bullet changes are listed in §3 as this package's:
   `core/test/normalizer/golden/{03,04,09,10}-*.envelopes.json`, their emitter
   `core/test/normalizer/support/emit.ts`, and `core/test/worker/permissions.test.ts`. Every M1 test that does
   not spell the payload out — `permission-responder.test.ts`, compat's `permission-deny` verdict — runs
   **unedited**, and that is the bullet's real content.
2. `clientCapabilitiesFor` is `{elicitation:{form:{}}}` **iff** `onUnresolved === "park"`, `{}` otherwise, no
   `url` key ever, and **the same value is used on `reopen` after a wake**. There is a named regression test
   that FAILS against `session-open.ts:251`'s current hard-coded `{}` (F42) — write it first.
3. `mapElicitation` is pure, total and idempotent over transcripts `12`/`13`: the **flat** scope (F29),
   `oneOf[].const` **and** `enum`, the `_custom` pairing via `_meta._askUserQuestionCustomAnswer` (F30), no
   `required` array, `unmodelled: []`. A fixture that nests the scope under `scope` is rejected with a named
   error, never silently mis-parsed. An unparseable schema yields `fields: []` with every property in
   `unmodelled`.
4. `buildElicitationContent` emits **exactly one property per questionId**; answering both members of a group
   is `400`. **The regression test is named after `omni-choice.txt`** — the file transcript `12` wrongly
   created.
5. The auto-resolved path emits M1's two envelopes in M1's order; the park path emits §19.10's five-envelope
   sequence, and `omni.policy_decision` appears **exactly once, at settlement** (M2-R4).
6. Park refcounts: two concurrent interactions park once, `interaction_resolved` fires only on the second
   answer, the lease pin is held for the whole window, and
   `interactions.length > 0 ⟺ state === "requires_action"` is an invariant test.
7. `parkTimeoutMs` under `fakeClock()` on `elicit-never-answers.mjs` produces `by:"timeout"` and applies
   `parkTimeoutAction` for **both** `"deny"` and `"fail"`; `parkTimeoutMs: 0` never expires;
   `interaction.maxParked` denies the newest with `rule:"limit:max_parked"` and never drops it.
8. Every row of §19.6's status table returns the exact code and body extra, in the exact check order
   (visibility → state → existence → lease → shape → semantics → deliver), and two identical failures produce
   **deep-equal bodies**. A `role:"admin"` caller without the lease is `423`; `steal` then answer succeeds and
   the log shows `omni.lease{stolen}` **before** the answer (M2-R6).
9. `settleAll("cancel")` resolves every held promise **before `session/cancel` reaches stdin**, asserted by
   method order on a recording scripted agent; `settleAll("shutdown")` leaves **no** `pending` interaction in
   the log — a log that ends on one fails this bullet.
10. `worker.on("interaction", req => req.allow())` — DESIGN §9.1's literal line — runs; `answer()` is keyed
    by question id and the **wire** carries exactly one property per question, asserted on captured frames
    rather than on the SDK's own view. `prompt()` survives a park longer than `requestTimeoutMs`.

---

### M2-A-WP-W — Idle watchdog, dual budget, turn projection

**Owns exclusively**

```
packages/core/src/worker/{watchdog,watchdog-state}.ts
packages/core/test/worker/{watchdog,watchdog-state}.test.ts
packages/protocol/src/turn.ts                    ← Land-written, transferred
packages/protocol/test/{turn,turn-golden}.test.ts
packages/testkit/src/fake-diff-provider.ts
packages/testkit/fixtures/agents/stall-{silent,in-tool}.mjs
tests/compat/src/cases/watchdog.ts
tests/integration/src/watchdog.itest.ts
```

**dependsOn**: Land only. It consumes `DiffProvider` as an **interface** and never WP-J's implementation.

**Acceptance**

1. `watchdogStep` is pure and table-tested with **100 % branch coverage, no clock and no process**; there is
   no `setTimeout` in the file.
2. The quiet window is anchored on the **last envelope appended**: a fixture emitting an update 20 ms after
   `prompt_result` under `silentMs: 10` does **not** trip — F25, 7/7, as a unit test driven by the recorded
   timings. Replayed envelopes (`replay:true`) are **not** activity.
3. `tool_call` opens; a terminal `tool_call_update` closes; a **sparse** update with no `status` neither
   opens a closed call nor closes an open one; the set is emptied only by `turn_end`. Driven by claude `16`'s
   and codex `08`'s exact sequences, where the budget is **still armed at the cancel** (F36).
4. A parked interaction disarms **both** budgets and unparking **RE-BASES** from the unpark instant (M2-R21):
   a twenty-minute park followed by one update does not immediately cancel. `silentMs: 0` / `toolMs: 0`
   disable that budget only; `enabled:false` disarms both and the snapshot's `watchdog` is `null`.
5. Firing appends `omni.error{agent_timeout}` **before** `cancelInternal`, and the close comes only after
   `cancelTimeoutMs` and is **`cancel_timeout`** — M1's existing reason. `cancelTimeoutMs <= turn.cancelGraceMs`
   is a config **load** error. `cancel-and-close.test.ts` passes unedited.
6. The watchdog and the hibernate timer are **never both armed**, for every state in §15.1's table.
7. **The watchdog does not survive a restart, and a test asserts it**: an adopted row is never `running`, so
   there is nothing to arm.
8. `strandedToolCalls` is exactly the one open id on claude `16` (`pending`) and codex `08` (`in_progress`),
   and **empty on every clean M1 turn**, so no M1 golden changes its verdict. `TurnResult` aggregation
   **never blocks**: a turn whose only tool call stays `pending` still settles.
9. `patch` / `patchInfo` are read from `state_update{idle}._meta["omni/patch"]`; with no provider the key is
   absent and the value is `null`, so every M1 golden asserting `patch: null` passes unchanged. A hung
   provider still yields `idle` with `patch: null` and a `patch_timeout` warning.
10. `reduceTurn` is still **pure**, deterministic, de-duplicating by `(workerId, seq)` and replay-skipping;
    M1's six generated goldens and eight named cases pass unchanged apart from the additive new keys.

---

### M2-A-WP-C — `session/set_config_option`, the config route, SDK `setConfig`

**Owns exclusively**

```
packages/core/src/worker/config-options.ts
packages/core/test/worker/config-options.test.ts
packages/daemon/src/http/routes/config.ts
packages/daemon/test/http/config.test.ts
packages/client/src/config.ts
packages/client/test/config.test.ts
tests/compat/src/cases/config-option.ts
tests/integration/src/config-option.itest.ts
```

**dependsOn**: Land only (it compiles against Land stubs and `stubDaemon()`).

**Acceptance**

1. The call goes through `Normalizer.mapRequest("session/set_config_option", …)`, so `configId` vs
   `optionId` is descriptor **data** and this file names neither spelling; a `-32602` on the first spelling
   falls through to the next (F34: `optionId` is `-32602` on claude-acp).
2. `WorkerSnapshot.configOptions` is **replaced wholesale from the method result**. A golden over claude `15`
   asserts the list shrinks **4 → 2** and that **no phantom `effort` survives**; a golden over codex `07`
   asserts all five survive. `AgentCapabilitiesSnapshot.configOptions` is **unchanged** by the call.
3. **Zero** agent-emitted `config_option_update` is consumed: a test whose stream carries none still sees the
   new value, and a **planted spurious** `config_option_update` is ignored. The route's own synthesized
   envelope carries `_meta["omni/source"]:"set_config_option"` and is distinguishable from an agent's.
4. `SetConfigResponse.stale` is `true` when the method returned no list, and the previous list is **KEPT**,
   never merged with a guess. `removed`/`added` name the membership delta.
5. `409 worker_busy` while a turn is live; `423` without the lease or with a stale epoch; auto-wake from
   `hibernated`; `ready` succeeds. A bad value is `502` carrying `-32603 data.details` verbatim, classified
   through `errorRules` on **code + a data pointer**, never on message text (F44).
6. `viewConfigOptions` lifts `id` through the descriptor's quirk and keeps `raw` **by identity**: codex's two
   model spellings (`gpt-5.6-sol[low]` vs `gpt-5.6-sol`) are both preserved untouched (F35).
7. `worker.config` is updated **synchronously with the promise's resolution** — no round trip, no
   notification wait — and a `503`/network failure leaves it **unchanged**.
8. After a wake, `configOptions` is re-seeded from `reopen`'s result, because a resumed session may report a
   different catalogue.

---

### M2-B-WP-P — Policy rule engine, presets, `policyCeiling` enforced

**Owns exclusively**

```
packages/core/src/policy/**       engine.ts match.ts glob.ts subject.ts ceiling.ts presets.ts
packages/core/src/worker/permission-responder.ts   ← Land-written, transferred; selectOption extracted
packages/core/test/policy/**
packages/core/test/worker/permission-responder.test.ts
packages/daemon/src/policy/{resolve,ceiling}.ts
packages/daemon/test/policy/**
packages/testkit/src/policy-conformance.ts
packages/testkit/src/scripts/permission.ts
packages/testkit/fixtures/agents/permission-allow-always-only.mjs
tests/compat/src/cases/permission.ts
tests/integration/src/policy-ceiling.itest.ts
```

**dependsOn**: Land only. **Not WP-I**: the engine is a pure `decide` function WP-I injects, and WP-I's
default is `onUnresolved` (§1.3 seam A), so the two land in either order.

**Acceptance**

1. `runPolicyConformance` passes for the engine **and still for `baselineInteractions`**, over a generated
   `offered` array (a fixed 64-row table plus a seeded shuffle — **no new dependency**), including the empty
   array, the unknown-kind-only array, and the `allow_always`-only array whose correct answer is `-32603`.
2. **`permission-responder.test.ts` passes UNEDITED** after `selectOption` is extracted, and the
   `policy-never-names-an-option` guard passes — demonstrated **failing on a planted `optionId` literal**.
3. DESIGN §4's four example rules are a literal table test with literal inputs and literal verdicts.
4. The §20.3 match table is complete: unknown kind → `default`; a path-less call vs a `path` rule → **no
   match**; all-paths-must-match; a `path`-only rule is a **load error** (M2-R17); a `cmd` clause on a
   `tool_call` subject is **rejected at compile** (M2-R18); regexes anchored, length-capped and rejected at
   load on catastrophic backtracking; action-directional case folding.
5. `toPolicySubject` realpaths, resolves a **not-yet-existing** file through its deepest existing ancestor,
   and a symlink into `src/` does **not** satisfy `src/**`.
6. `assertWithinCeiling` is total and decidable and throws `403 policy_exceeds_ceiling` with
   `body.policy.{ceiling, offending}` naming the offending rules; `clampVerdict` catches a case the static
   check **provably cannot** (an inline `allow` on `path:["**"]` under `pathRoots:["src"]`) and stamps
   `clamped` **plus** a `TurnWarning` — never silently. The `dominates` table includes `fail ≡ deny` and
   tie-resolves-to-policy.
7. The four presets load from YAML as **data**; `readonly` never allows `edit`/`delete`/`execute` (a property
   test over 10 000 generated subjects); its `kind:read` exfiltration hazard (F37) is documented in
   `presets.ts` with the citation and covered by `readonly-contained`.
8. `extends` resolves, cycles are a load error, `preset ⊕ inline` is inline-last-wins, and
   `PolicySnapshot.sources` names every layer in order.
9. `alertOnUnpoliced` produces `TurnWarning{code:"unpoliced_tool_call"}` for a listed kind that never reached
   the engine — claude `13`'s silent `ls -A` is the fixture (F40).
10. Every D4 hard rule has a test that **would fail if the invariant were removed**, and the engine is pure:
    the same subject in yields a deep-equal verdict 1 000 times over a seeded table, with no clock and no I/O.

---

### M2-B-WP-S — MCP presets, `mcpCapabilities` filtering, per-worker `env`, prompt containment

**Owns exclusively**

```
packages/core/src/mcp/**                    presets.ts capabilities.ts
packages/core/src/worker/{prompt-content,env}.ts
packages/core/test/mcp/**
packages/core/test/worker/{prompt-content,env}.test.ts
packages/daemon/src/mcp.ts
packages/daemon/test/mcp.test.ts
packages/testkit/fixtures/mcp/**
tests/compat/src/cases/prompt-content.ts
tests/integration/src/{mcp-preset,prompt-content}.itest.ts
```

**dependsOn**: Land only.

**Acceptance**

1. A client can name a preset and **cannot express a command**: the type is `string[]`, the
   `client-never-sends-a-command` guard passes (both halves — the type, and that no route builds an
   `McpServerPreset` from a body), an unknown name is `400` **naming it**, and a disallowed one is `403`.
2. §12.3 row 22's MCP `type` injection — implemented and **unreachable from the wire** in M1 — is exercised
   end to end for the first time, and `toleratesOmittedMcpCapabilities` decides the absent-block case **from
   the descriptor**, never from an agent-id branch.
3. `filterMcpCapabilities` never filters stdio (v1 has no stdio bit, and codex advertises
   `{acp:false, http:true, sse:false}` while happily taking stdio); an unusable `http` preset lands as
   `applied:[] / dropped:[{name,reason}]` on the snapshot **plus a `TurnWarning`**, not as an error.
4. `resolveWorkerEnv` **rejects with a 400 naming the key** for every entry of `ENV_DENY_EXACT` and every
   `ENV_DENY_PREFIX`; `envDeny` extends and **provably cannot shrink** the hard list; `envAllow` is enforced;
   invalid key names, NUL values and an over-sized map are `400`.
5. **Both platform branches are tested**: `{"path": "…"}` is rejected on `win32` and accepted on `linux`.
   The test **injects `platform`**; it does not skip.
6. `WorkerSnapshot.envKeys` carries names only, and a grep test asserts **no env value** appears in any
   snapshot, log line or HTTP body across a full create-prompt-close cycle. Requested env layers **on top of**
   the descriptor's and never overwrites it.
7. `env.persist:false` forces `resume.method: null`; the worker refuses to hibernate under
   `whenNotResumable:"keep"` and the reason says why. A wake whose preset vanished from config closes with
   `acl_revoked`, matching §15.5's 403 row.
8. The `assert-prompt-content-is-called` guard is **structural** (review R2): it asserts that the daemon's
   worker-creation path passes `deps.validateContent` bound to the token's `cwdRoots` and the worker's
   `promptCapabilities` — not that some file mentions the name, which `worker.ts`'s deliberately
   differently-spelled `assertTextOnlyContent` fallback would satisfy while the real check was absent. It is
   demonstrated failing on a planted violation (the injection removed), beside the integration test below.
   `assertPromptContent` itself rejects, **before the prompt is sent**: a `resource_link` outside `cwdRoots`; a
   symlink inside `cwd` that realpaths outside; a relative or non-`file://` uri; a `..` traversal; an
   embedded `resource` block failing any of the above; and a block type the worker's `promptCapabilities`
   does not advertise. **In every case the fixture agent recorded ZERO `session/prompt` calls** (F37, F38),
   and the error message elides the path.
9. The M0 text-only path still works and `curl-shapes.itest.ts`'s widened case documents the new rule.

---

### M2-B-WP-R — Run API, webhook delivery, persistence v2

**Owns exclusively**

```
packages/core/src/run/**                    registry.ts recovery.ts
packages/core/src/webhook/**                dispatcher.ts sign.ts ladder.ts guard.ts
packages/core/src/persist/schema.ts         ← Land-written, transferred (v2 migration)
packages/core/src/persist/{run-store,delivery-store}.ts
packages/core/test/{run,webhook,persist}/**
packages/daemon/src/runs.ts
packages/daemon/src/http/routes/{runs,webhooks}.ts
packages/daemon/test/http/{runs,webhooks}.test.ts
packages/client/src/runs.ts
packages/client/test/runs.test.ts
packages/testkit/src/webhook-receiver.ts
tests/compat/src/cases/webhook-run.ts
tests/integration/src/run-webhook.itest.ts
```

**dependsOn**: Land only. **It is the only package that touches `persist/**` in M2.**

**Acceptance**

1. `SCHEMA_VERSION` 2 is **CREATE-only**: a v1 file opened by an M2 daemon migrates forward keeping every M1
   event, §14.11's conformance suite runs **verbatim**, and a v2 file opened by an M1 daemon still fails
   loudly naming the version.
2. `planNextAttempt` is **pure** and reproduces D9's ladder exactly — 0s / 30s / 2m / 10m / 30m / 2h, then
   `failed` — under `fakeClock()` with no network; jitter stays within `[0, base*jitter]` and `rnd` is
   injected.
3. The delivery body has **exactly the eight `WebhookPayload` keys** (`webhook-body-is-thin`), `deliveryId`
   is the idempotency key, and the `worker.requires_action` payload carries **no request content**.
   `signDelivery` matches a fixed vector and `fakeWebhookReceiver` verifies it; a wrong secret fails.
4. Receiver 500 ×6 → `failed`; **410 → `failed` immediately**; a hang → aborted at `timeoutMs`; a `3xx` is a
   failure and **not** followed; the response body is **never read** (`no-unbounded-outbound`).
5. **Restart safety, four tests**: a `delivering` row with a foreign `lease_boot` is re-queued with `attempt`
   **unchanged**; two dispatchers racing one row see **exactly one** `claim` succeed; a live `runs` row from
   a foreign boot becomes `abandoned` with a terminal `run.failed` delivery enqueued; and a **planted throw
   between the state change and the enqueue leaves neither** (one transaction).
6. `idempotencyKey` returns the **original** run on a repeat, across a restart.
7. `GET /v1/webhooks/deliveries` is admin-or-owner only, cursor-paginated, survives a restart, and
   `retentionDays` sweeps runs and their deliveries **together** on M1's existing timer. `redeliver` keeps the
   `deliveryId` and resets `attempt`.
8. A slow or dead receiver **never blocks a turn**: a run whose webhook hangs for `timeoutMs` reports its
   `TurnResult` at the same time as one with no webhook.
9. `webhooks.mode:"allowlist"` with an empty `allow` makes a webhook run **`403` at create**, not at delivery;
   a hostname resolving into `denyCidrs` is `403` — with **`169.254.169.254`, not loopback**, because the
   local receiver every other bullet needs is on loopback and §24.6's CIDR check is absolute (review R16).
   The test's own daemon config sets `denyCidrs: []` for the same reason. The URL is validated where the
   operator can see it.
10. `POST /v1/runs` = create + prompt + settle + close (or `keepWorker`), and `…/events?since=` returns the
    worker's envelopes with M1's exact `?since=` semantics — proven by **reusing `sse-resume.itest.ts`'s
    frame comparison** against a run's stream. A run whose worker parks reports `state:"requires_action"` and
    fires `run.requires_action`. Under the memory driver a run is allowed and reports
    `persistence:"memory"` (M2-R14).

---

### M2-WP-J — git diff provider, daemon wiring, compat, CLI, acceptance (the join)

**Owns exclusively**

```
packages/core/src/diff/**                   git-provider.ts temp-index.ts worktrees.ts
packages/core/test/diff/**
packages/core/src/runtime/known.ts          ← Land-written, transferred
packages/daemon/src/{registry,create-daemon,auth,boot-recovery}.ts   ← Land-written, transferred
packages/daemon/test/**  MINUS http/{interactions,config,runs,webhooks}.test.ts, policy/**, mcp.test.ts
packages/client/src/{server,local,omni-acp,transport}.ts
packages/client/test/**  MINUS {lease,interactions,config,runs}.test.ts
packages/cli/{src,test}/**
packages/testkit/src/git-fixture.ts
packages/testkit/test/arch/**
tests/compat/src/cases/patch.ts · tests/compat/agents.{ci,local}.yaml
tests/integration/src/*.itest.ts   (the M2 files not owned above, incl. m2-acceptance)
examples/03-interactive.mjs · examples/04-run-webhook.mjs · examples/daemon.example.yaml
docs/M2-PLAN.md (this file's §5 record)
```

**dependsOn**: `["M2-A-WP-I", "M2-A-WP-W", "M2-A-WP-C"]` for the M2-A half of the acceptance script;
`["M2-B-WP-P", "M2-B-WP-S", "M2-B-WP-R"]` for the M2-B half. **The diff-provider half depends on nothing and
starts on day 1** — it is ~150 lines whose only risky dependency is the `RunUtility` process seam this
package already owns.

**Acceptance**

1. `createGitDiffProvider` reaches git **only** through the injected `RunUtility` (`no-direct-spawn`,
   `patch-runs-no-shell`), and its unit tests run with **no git installed**.
2. `GIT_INDEX_FILE` is used on both `write-tree` calls; a test asserts the user's real index and worktree are
   byte-identical before and after (D8's 不碰用户 index), that the temp index **never appears in a produced
   patch**, and that `.gitignore` is respected.
3. `--no-ext-diff` / `--no-textconv` are present and a **planted `diff.external`** in the test repo's config
   is **not executed**. `GIT_OPTIONAL_LOCKS=0` is set.
4. `patch` is `null` **outside a repo**, `null` when the agent **created `.git/` mid-session**
   (`initRepoMidSession()` — codex's observed behaviour, F39, not a hypothetical), `null` over
   `diff.maxBytes` (truncated at a hunk boundary, `truncated: true`), `null` on any git failure and on
   timeout — and **every one carries its named `TurnWarning`**. Never wrong, never a throw, never a failed
   turn.
5. Two workers on one repo: both patches carry `quality:"shared_worktree"` and the warning; a single worker
   carries `"exact"`. A produced patch passes `git apply --check` in a clean clone (`skipIf(no git)`).
6. `reduceTurn` locally and `GET /turns/{id}` return **deep-equal** `TurnResult`s **including `patch`** on
   every M2 integration test — D7 re-proven, not assumed.
7. `create-daemon.ts` flips six defaults (`interactions`, `watchdog`, `policy`, `diff`, `webhooks`, `runs`);
   **with all six absent the whole M1 suite passes unedited**, which is the test that the seams were real.
   Boot order is `persistence → worker adopt → run recover → delivery requeue → dispatcher.start → listen`;
   `stop()` is `interactions.settleAll → dispatcher.drain(bounded) → workers → socket`. Both asserted by a
   recording order test.
8. `runtime/known.ts` gains the `session_info_update` row (F25) and the `unverified` entries for
   `elicitation.url`, `elicitation/complete`, `action:"cancel"`, multi-question forms, `parkTimeoutAction`
   and — for codex — `cmd`-matching rules (F38); the compat suite **refuses to assert an `unverified` row**,
   with a printed reason. There is **no `configOptionIdField` row**: the returned entry's key is `id` on both
   agents, measured in claude `15` and codex `07`, so it is not a quirk at all (review R3, CONTRACTS §22.1).
9. The full compat matrix runs: hermetic `agents.ci.yaml` green on three OSes with **zero unsourced skips**,
   and `OMNI_COMPAT_REAL=1` green against **claude-acp and codex-acp** with every skip carrying a source and
   a ≥10-character reason.
10. §4's acceptance script is green against the real agents **twice in a row**, and its transcript is recorded
    in §5 the way M1's was.
11. `omni-acp interactions <wid>`, `omni-acp interactions answer <wid> <reqId> --allow|--deny|--value q=v`,
    `omni-acp config <wid> <id> <value>`, `omni-acp runs`, `omni-acp deliveries [--redeliver <id>]` exist and
    are parse → one call → print (D15). `omni-acp workers` prints `requires_action` and the pending count.
12. `exports-are-stable.itest.ts` records the new surface; `client-has-no-daemon-import`,
    `dependency-direction` and `sdk-version-pinned` still pass.

---

## 3. Ownership map (no path appears twice)

| Path | Owner |
| ---- | ----- |
| root configs, `.github/**`, all `package.json` / `tsconfig.json` / `vitest.config.ts`, all `src/index.ts`, `packages/protocol/src/**` **except `turn.ts`**, `packages/core/src/worker/worker.ts`, `packages/core/src/worker/handshake.ts`, `packages/core/src/acp/link.ts`, `packages/core/src/normalizer/turn-lifecycle.ts`, `packages/client/src/worker.ts`, `packages/daemon/src/{types.ts, http/routes/index.ts, http/routes/workers.ts}`, `packages/testkit/src/{index,scripted-agent,stub-daemon}.ts`, `tests/compat/src/{harness,runner,config}.ts`, `tests/compat/src/cases/support.ts` | **Land (frozen)** |
| `packages/core/src/worker/interaction/**`, `packages/core/src/worker/session-open.ts`, `packages/core/src/normalizer/map/elicitation.ts`, `packages/core/test/worker/interaction/**`, `packages/core/test/normalizer/elicitation.test.ts`, `packages/daemon/src/http/routes/interactions.ts`, `packages/daemon/test/http/interactions.test.ts`, `packages/client/src/interactions.ts`, `packages/client/test/interactions.test.ts`, `packages/testkit/src/{interaction-conformance.ts, scripts/elicitation.ts}`, `packages/testkit/fixtures/agents/elicit-*.mjs`, `tests/compat/src/cases/elicitation.ts`, `tests/integration/src/{interaction-park,interaction-timeout,elicitation-gate}.itest.ts`, **and — transferred by review R4, because ruling M2-R3's `payloadVersion` flip is what changes them —** `packages/core/test/normalizer/golden/{03,04,09,10}-*.envelopes.json`, `packages/core/test/normalizer/support/emit.ts`, `packages/core/test/worker/permissions.test.ts` | **M2-A-WP-I** |
| `packages/core/src/worker/{watchdog,watchdog-state}.ts`, `packages/core/test/worker/{watchdog,watchdog-state}.test.ts`, `packages/protocol/src/turn.ts`, `packages/protocol/test/{turn,turn-golden}.test.ts`, `packages/testkit/src/fake-diff-provider.ts`, `packages/testkit/fixtures/agents/stall-*.mjs`, `tests/compat/src/cases/watchdog.ts`, `tests/integration/src/watchdog.itest.ts` | **M2-A-WP-W** |
| `packages/core/src/worker/config-options.ts`, `packages/core/test/worker/config-options.test.ts`, `packages/daemon/src/http/routes/config.ts`, `packages/daemon/test/http/config.test.ts`, `packages/client/src/config.ts`, `packages/client/test/config.test.ts`, `tests/compat/src/cases/config-option.ts`, `tests/integration/src/config-option.itest.ts` | **M2-A-WP-C** |
| `packages/core/src/policy/**`, `packages/core/src/worker/permission-responder.ts`, `packages/core/test/policy/**`, `packages/core/test/worker/permission-responder.test.ts`, `packages/daemon/src/policy/**`, `packages/daemon/test/policy/**`, `packages/testkit/src/{policy-conformance.ts, scripts/permission.ts}`, `packages/testkit/fixtures/agents/permission-allow-always-only.mjs`, `tests/compat/src/cases/permission.ts`, `tests/integration/src/policy-ceiling.itest.ts` | **M2-B-WP-P** |
| `packages/core/src/mcp/**`, `packages/core/src/worker/{prompt-content,env}.ts`, `packages/core/test/mcp/**`, `packages/core/test/worker/{prompt-content,env}.test.ts`, `packages/daemon/src/mcp.ts`, `packages/daemon/test/mcp.test.ts`, `packages/testkit/fixtures/mcp/**`, `tests/compat/src/cases/prompt-content.ts`, `tests/integration/src/{mcp-preset,prompt-content}.itest.ts` | **M2-B-WP-S** |
| `packages/core/src/{run,webhook}/**`, `packages/core/src/persist/**`, `packages/core/test/{run,webhook,persist}/**`, `packages/daemon/src/runs.ts`, `packages/daemon/src/http/routes/{runs,webhooks}.ts`, `packages/daemon/test/http/{runs,webhooks}.test.ts`, `packages/client/src/runs.ts`, `packages/client/test/runs.test.ts`, `packages/testkit/src/webhook-receiver.ts`, `tests/compat/src/cases/webhook-run.ts`, `tests/integration/src/run-webhook.itest.ts` | **M2-B-WP-R** |
| `packages/core/src/diff/**`, `packages/core/test/diff/**`, `packages/core/src/runtime/known.ts`, `packages/daemon/src/{registry,create-daemon,auth,boot-recovery}.ts`, `packages/daemon/test/**` (minus the rows above), `packages/client/src/{server,local,omni-acp,transport}.ts`, `packages/client/test/**` (minus the rows above), `packages/cli/{src,test}/**`, `packages/testkit/src/git-fixture.ts`, `packages/testkit/test/arch/**`, `tests/compat/src/cases/patch.ts`, `tests/compat/agents.*.yaml`, `tests/integration/src/*.itest.ts` (minus the rows above), `examples/**` | **M2-WP-J** |

Every path not listed keeps its M1 owner and its M1 content; an M2 work package that needs one edited files a
request to the Land owner rather than editing it.

**The three named seam files, restated so nobody is surprised.** `packages/core/src/worker/worker.ts` is
Land-edited in the nine hunks of §1.2 and then **frozen** — not transferred, not shared.
`packages/daemon/src/registry.ts` is Land-edited to hold the three new façade rows (`answer`, `interactions`,
`setConfig`) and the park-timer disposal, then **transferred to WP-J**, which is the only owner of daemon
wiring. `packages/daemon/src/http/routes/index.ts` and `workers.ts` stay Land-frozen; each feature adds its
**own** route module beside them, which is M1's routes split reused unchanged.

Guard tests live with their owner: `no-elicitation-schema-parse` and `interaction-id-is-daemon-minted` → WP-I;
`policy-never-names-an-option` and the extended `no-agent-prose` → WP-P; `env-deny-is-one-table`,
`client-never-sends-a-command` and `assert-prompt-content-is-called` → WP-S; `webhook-body-is-thin` and
`no-unbounded-outbound` → WP-R; `patch-runs-no-shell`, `no-direct-spawn`, `http-has-no-logic`,
`sse-is-unchanged`, `descriptor-is-the-only-branch` and `exports-are-stable` → WP-J.

---

## 4. The M2 acceptance script

`tests/compat/src/runner.ts`, driven by `agents.yaml`, plus `tests/integration/src/m2-acceptance.itest.ts`
for the parts a fixture agent can prove deterministically. **For each configured agent** the identical script
runs; an agent that cannot satisfy a case is **skipped with a printed source and reason**, never silently
passed, and `OMNI_COMPAT_REQUIRE=1` turns an empty selection into a failure.

> **Real-agent runs use `claude-acp` and `codex-acp` only.** They are the two ACP agents installed on this
> machine — `npx -y @agentclientprotocol/claude-agent-acp@0.73.0` (logged-in Claude Code) and
> `npx -y @agentclientprotocol/codex-acp@1.8.0` (ChatGPT login). **No other agent may be installed**; gemini,
> opencode and kimi are YAML entries somebody else adds later, with zero code changes. CI runs
> `agents.ci.yaml` (the SDK example agent plus the turn-completing testkit fixtures, now including the four
> `elicit-*` and two `stall-*` fixtures) on three OSes; the real-agent file is `OMNI_COMPAT_REAL=1`,
> `workflow_dispatch` only.
>
> **The two agents disagree about almost everything M2 is about** — claude asks permission and elicits,
> codex does neither — and that is what makes the skip taxonomy load-bearing rather than decorative.

**Setup.** `mkdtemp` workspace under `os.tmpdir()`, registered as the token's only `cwdRoot`.
`createDaemon({ listen: {host:"127.0.0.1", port:0}, dataDir: <mkdtemp>, eventLog: {driver:"sqlite"},
hibernate: {idleMs: 60_000}, watchdog: {silentMs: 300_000, toolMs: 8_000, cancelTimeoutMs: 20_000},
interaction: {parkTimeoutMs: 0}, diff: {provider:"git"},
webhooks: {enabled:true, mode:"allowlist", allow:[<the local receiver's origin>], denyCidrs: [],
           secrets:{ci:<32 bytes>}},
policy: {presets: {…}}, tokens: [<admin>, <second user token on the same cwdRoot>],
agents: [<the YAML entry, resolved for this platform>] })`, `daemon.start()`, then **two** SDK clients on one
token with distinct client ids: `A` (the controller) and `B` (the observer).

**Step 0 — probe.** `A.probe(agentId)` once. Its `ProbeSummary` and the resolved descriptor's `unverified`
list drive every `capability` skip below, so a missing capability is reported as a skip rather than a failure.

**Step 1 — the park path, end to end (claude-acp; the M2-A headline).**

- `w = A.createAgent(agentId, { cwd, onUnresolved: "park", policy: "readonly", parkTimeoutMs: 0 })`.
  Assert `state === "ready"`, `onUnresolved === "park"`, and that our recorded outbound `initialize` params
  carry `clientCapabilities.elicitation = { form: {} }` **and no `url` key** (D10, F28).
- `B` opens `w.events({ since: 0 })` and keeps it for the whole step.
- `A.prompt("create hello.txt containing exactly: hello")` — do **not** await it yet.
- The `edit` permission cannot be auto-decided under `readonly`, so it parks. Assert on `B`'s stream:
  `acp.interaction{status:"pending", park:{expiresAt:null, onTimeout:"deny"}}` then
  `omni.worker_state{state:"requires_action", reason:"interaction_parked"}`.
- `GET /v1/workers/{wid}` from **B** shows `state:"requires_action"` and `interactions.length === 1`;
  `B`'s own `GET …/interactions` **succeeds** (ungated) and `B`'s `POST …/interactions/{reqId}` is
  **`423`** with `body.lease.holder.clientId === A` (M2-R6, rule L2).
- `A`'s handler — DESIGN §9.1's literal line — answers: `w.on("interaction", req => req.allow())`.
  Assert the selected `optionId` was in `offered` (D4 rule 1) and its `kind` was **not** `allow_always`
  (rule 3).
- The prompt resolves. Assert `stopReason === "end_turn"`, **`hello.txt` exists on disk with exactly
  `hello`**, `result.interactions.length === 1` with `decision:"allow"`, `by:"human"`, `parkedMs > 0`, and
  `omni.policy_decision` appears **exactly once** for that `requestId` (M2-R4).
- Then the admin path: `B.lease.steal("on-call takeover")`, a second parking prompt, `B` answers it, and
  `A`'s next `prompt` is `423` with a bumped epoch — D13 through D5, in two calls.

**Step 1b — the elicitation control (claude-acp).** A second worker with `onUnresolved:"deny"` and the
byte-identical "ask me a clarifying question first" prompt gets **no `elicitation/create` and no tool call at
all** and still ends `end_turn` — F28 reproduced live. A third with `"park"` gets a real
`elicitation/create`, `answer({question_0: <a oneOf const>})` creates **that** file, and the captured frame
shows the paired `question_0_custom` property **absent from the wire** (F30's regression).

**Step 2 — the watchdog (fixture agent, deterministic; then both real agents).**

- Fixture: `stall-in-tool.mjs` opens a `tool_call{status:"pending"}` and goes silent. Under
  `watchdog.toolMs: 8_000` assert `session/cancel` on the wire, then after `cancelTimeoutMs` a close with
  reason **`cancel_timeout`** (M1's existing reason — no new one), `omni.error{agent_timeout}` appended
  **before** the cancel, `strandedToolCalls.length === 1`, `verdict:"partial"`, and that `TurnResult`
  settled without blocking.
- Fixture: `stall-silent.mjs` under `silentMs: 3_000` trips the **silent** budget, and a fixture that emits
  one update 20 ms **after** `prompt_result` does **not** trip it (F25).
- Real agents: a 30 s `python3 -c 'import time; time.sleep(30)'` (claude) and `sleep 30` (codex) under a
  case-scoped `toolMs: 8_000` reach `stopReason:"cancelled"` with the tool call at its last non-terminal
  status (F36).

**Step 3 — config (codex-acp is the headline here).**

- `await w.setConfig("mode", "read-only")`. Assert the returned list **replaces** `worker.config`
  synchronously with the promise, that all five codex entries survive (F35), and that **zero
  agent-emitted `config_option_update` envelopes** appear on the tail.
- On claude-acp: `setConfig("model", "haiku")` shrinks the list **4 → 2** with **no phantom `effort`**, and
  the next turn's `_meta.quota.model_usage[0].model` is `claude-haiku-4-5-20251001` (F34) — the assertion
  that the switch is real and not cosmetic.
- `setConfig` mid-turn is `409`; without the lease it is `423`; a bad value is `502` carrying
  `data.details` verbatim (F44).

**Step 4 — webhook (a local receiver, both agents).**

- `fakeWebhookReceiver()` on loopback, its origin in `webhooks.allow` — **and `denyCidrs: []` in the setup
  config above, which is the whole reason it is spelled there** (review R16). CONTRACTS §24.6 makes the CIDR
  check absolute: an `allow` entry does not exempt an address, so the default `denyCidrs` (which contains
  `127.0.0.0/8`) would `403` every webhook run in this script, in `run-webhook.itest.ts` and in the hermetic
  CI matrix. WP-R acceptance 9's "resolves into `denyCidrs` ⇒ 403" fixture therefore uses a NON-loopback deny
  address — `169.254.169.254` — rather than the receiver's own.
- `A.runs.create({ agent, cwd, prompt: "Reply with exactly the word PONG.", webhook: {url, secret:"ci"} })`.
- Assert **exactly one** delivery, `Omni-Signature` verifies against the configured secret, the body has
  **exactly eight keys**, and `GET /v1/runs/{rid}` reports `succeeded` with a `TurnResult`.
- Then `receiver.failNext(3)` on a second run and assert four attempts at the configured backoff under
  `fakeClock`; **kill the daemon mid-`delivering`**, restart on the same `dataDir`, and assert the delivery
  arrives once more with the **same `deliveryId`** and `attempt` not double-counted (§24.4 rule 3).
- A run with an off-allowlist url is `403` **at create**.

**Step 5 — patch (both agents).** A write turn in a `tempRepo()` cwd yields a non-null `TurnResult.patch`
that `git apply --check` accepts, and `reduceTurn` locally is **deep-equal** to `GET /turns/{id}` including
`patch` (D7). The same turn in `tempNonRepo()` yields `patch: null` + `patch_not_a_repo`. And
`initRepoMidSession()` — the agent creating `.git/` between `begin` and `end`, which is codex's **observed**
behaviour (F39) — yields `null` + `patch_repo_changed`, never a garbage diff.

**Step 6 — containment (both agents).** A prompt carrying `resource_link(file://<outside cwdRoots>/x.txt)`
is `400 bad_request`, the path is elided from the message, and the agent recorded **zero `session/prompt`
calls** (F37, F38).

**Step 7 — the M1 bar, unmoved.** The whole M1 script (§M1-PLAN §4) still runs green in the same suite:
hibernate/wake with `outcome:"landed"`, restart-survivable `?since=`, the lease steal and its fence, and
`two-workers-do-not-interfere.itest.ts` **untouched**. That is the compatibility bar for the whole milestone.

**Companion integration files** (M1's set, plus M2's): `interaction-park.itest.ts`,
`interaction-timeout.itest.ts`, `elicitation-gate.itest.ts`, `watchdog.itest.ts`, `config-option.itest.ts`,
`policy-ceiling.itest.ts`, `mcp-preset.itest.ts`, `prompt-content.itest.ts`, `run-webhook.itest.ts`,
`patch.itest.ts`, `m2-acceptance.itest.ts`.

**Budget.** claude-acp is ~1.5 s warm handshake plus 3–7 s per turn; codex-acp is ~2.0–2.2 s `initialize`
plus 3–10 s per turn (its README's measured timings), and a **cold** `npx` for codex once took >90 s. The
full real-agent script is ~3 minutes per agent, dominated by step 2's two 8-second watchdog waits. Integration
and compat `testTimeout: 180_000`, `retry: 1`.

---

## 5. Definition of done for M2

1. `pnpm -r build && pnpm test` green on ubuntu-latest, macos-latest and windows-latest, with **all 2166 M1
   tests still passing unmodified** — except the handful whose shape the contract requires. **No test is
   weakened**; each change is listed in §5.1 below with the section that requires it. (M2 DoD 1 originally
   said "in the M2 Land commit's message"; review R18 moved the record HERE, because a commit message is not
   amendable and a table a reviewer can diff against the tree is the artefact this bullet actually wants.)
2. **M2-A is green and shippable before any M2-B package merges.** With `policy`, `diff`, `webhooks` and
   `runs` absent from `DaemonDeps`, the daemon is M1 plus a park, and the M1 suite proves it (ruling M2-R1).
3. Every acceptance bullet in §2 passes, and every architecture guard in CONTRACTS §10.2 and §27.4 passes —
   with `policy-never-names-an-option`, `no-elicitation-schema-parse` and `assert-prompt-content-is-called`
   each **demonstrated failing on a planted violation**.
4. The §4 script is green over `agents.ci.yaml` on three OSes, and green over `agents.local.yaml` against
   **claude-acp and codex-acp** on Linux under `OMNI_COMPAT_REAL=1`, **twice in a row**, with the run
   recorded below in M1's format.
5. `compat-report.json` shows **zero unexplained skips**: every skip has a source and a ≥10-character reason,
   and every row of each agent's `unverified` list in the resolved descriptor appears as a
   `config`/`capability` skip rather than as a pass. `agents.local.yaml` restates those lists and never a
   shorter one.
6. Zero orphan processes after any suite, on any OS. Zero temp git index files left behind. Zero `.git`
   directories created inside a `dataDir`.
7. No file in the repository has two owners; `pnpm-lock.yaml` gains **no new external package**, and CI's
   `git diff --exit-code pnpm-lock.yaml` after `pnpm install --frozen-lockfile` proves no work package
   rewrote it.
8. `docs/CONTRACTS.md` §2.3's M2 rows are struck through with the section that replaced each, and §11.8's
   rulings are the only place a proposal disagreement is resolved.

### 5.1 The M1 tests the contract required to change — the complete list

Each row is a SHAPE change the contract requires and each carries an inline comment in the file saying so.
**None is a weakening**: no assertion was deleted, relaxed or replaced with a looser matcher.

| file(s) | what changed | required by |
| ------- | ------------ | ----------- |
| `packages/protocol/test/transcripts/*.expected.json` (12 files) | additive `patchInfo` / `strandedToolCalls` / `pendingInteractions` on every `TurnResult`; `permission-deny.expected.json` also gains the widened `InteractionRecord` fields | §5.8.5 (`TurnResult`, `InteractionRecord`), M2-R3, M2-R8 |
| `packages/core/test/worker/permissions.test.ts` | the widened `InteractionRecord` rows (`kind`, `method`, `by`, `parkedMs`, `toolCallId`), each with an M1 reading that is a TRUTH about an M1 daemon rather than a guess | §5.8.5, M2-R3 |
| `packages/client/test/prompt.test.ts` | the same widening, seen through the SDK | §5.8.5 |
| `packages/core/test/worker/handshake.test.ts` | `clientCapabilities: {}` on `AgentCapabilitiesSnapshot` — recorded AS SENT (F28, F42) | §5.8.4 |
| `packages/core/test/normalizer/corpus.test.ts`, `packages/core/test/normalizer/support/corpus-facts.ts`, `packages/core/test/event-log/m1-acceptance.test.ts` | the corpus grew 11 → 18 transcripts, so the M1 set is now **NAMED** (`M1_TRANSCRIPTS`, `M1_CORPUS_FILES`) instead of globbed; `corpus.test.ts` asserts BOTH counts so a transcript nobody uses is still visible. This was **pre-existing red on `main`** from `07e1086`, fixed here (Land note S13) | §18, §27.3 |
| `packages/protocol/test/config.test.ts` | M2 defaults; `CreateWorkerRequest` now ACCEPTS `mcp`/`policy`/`env`/`park` and still refuses a command object; `PromptRequestBody` no longer decides block types | §5.8.6, §5.8.7, H28 |
| `packages/protocol/test/errors.test.ts` | the two new codes and only two | M2-R2 |
| `packages/protocol/test/events-schema.test.ts` | the `omni.run` arm, plus two NEW tests: an M1-era envelope still parses, and M2's widened arms parse | §5.8.3, Land exit criterion 3 |
| `packages/daemon/test/registry.test.ts`, `packages/daemon/test/http/routes.test.ts` | H28 moved the block-TYPE decision out of the schema, so these assert the SHAPE boundary the route still owns and that types are forwarded | H28, §26.2 |
| `packages/daemon/test/create-daemon.test.ts`, `packages/testkit/test/stub-daemon.test.ts` | `whoami`'s three new fields | §5.8.6 |
| `packages/daemon/test/arch/http-has-no-logic.test.ts` | the four new route modules, all still covered | §27.4 |
| `packages/testkit/test/seq-ids.test.ts` | `seqIds().request()`'s prefix `r_` → `q_`, because `r_` is now `RunId` and a fake whose request ids look like run ids is a collision an `assertRunId` test would pass for the wrong reason (Land note S12) | §5.8.1 |
| `tests/integration/src/exports-are-stable.itest.ts` | records the new runtime AND type surface | WP-J acceptance 12 |

Two further edits belong to the **review** of this Land step rather than to the Land step itself, and are
listed for the same reason:

| file(s) | what changed | required by |
| ------- | ------------ | ----------- |
| `packages/core/test/normalizer/turn-lifecycle.test.ts` | a new `seam D` block: `prompt_result.meta` reaches `idle._meta` verbatim, a turn with no meta emits byte-for-byte M0's payload, a reducer-owned key wins over a provider key of the same name, and one turn's meta never reaches the next | review R10, M2-R9 |
| `tests/integration/src/exports-are-stable.itest.ts`, `packages/core/test/worker/config-options.test.ts` | `setConfigOption` → `configOptionsDelta` on `@omni-acp/core`'s barrel: the wire call moved into `Worker.setConfig` | review R12, §5.8.9 |

### Real-agent record

To be filled in the shape of M1-PLAN §5's record, after the two green runs: the exact commands, the
pass/fail/skip table per agent, every skip with its source, the `ProbeSummary` for each agent, and — because
this is the milestone where it matters — **the first real-agent observation of an unanswered
`elicitation/create`** (§11.9's first risk, which `interaction-park-timeout` exists to discover rather than
to confirm). Anything the run contradicts in the corpus READMEs is recorded here rather than smoothed over,
exactly as M1's record did for its two contradictions.
