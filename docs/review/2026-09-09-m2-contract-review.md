# M2 契约 + Land 评审（2026-09-09）

来源：workflow `m2-contracts`（wf_86213d37-616）的两个对抗审查 agent 与 Land agent 的备注。**每一条都要处理**：改文档/桩/seam，或写明不改的理由。

## 审查结论：pass-with-issues（9 条）

### R1 [major] `docs/CONTRACTS.md`

§5.8.8 declares `InteractionStrategy.settleAll(reason): void` (line 3875), but §19.8 (line 6226) requires it to "return only once every held JSON-RPC promise has resolved" and to run BEFORE `session/cancel` reaches stdin, and M2-A-WP-I acceptance 9 asserts that ordering by method order on a recording agent. A synchronous void method cannot express that guarantee: resolving a deferred held by the ACP link's request handler causes the response bytes to be written a microtask later, while the landed call site (packages/core/src/worker/worker.ts:882 `this.#settleInteractions("cancel")` followed by `await this.#link.notify("session/cancel", …)`) puts the cancel notification on stdin first — exactly the hang §19.8 exists to prevent. Both `contracts.ts` and `worker.ts` are Land-FROZEN, so WP-I cannot fix this without reopening two frozen files, and its own acceptance bullet 9 cannot pass as written.

**建议修法**：Before any work package starts, amend the Land surface: make `settleAll(reason): Promise<void>` in packages/protocol/src/contracts.ts and packages/core/src/worker/interaction/registry.ts, make `Worker.#settleInteractions` async, and change worker.ts:882 / :973 / :1951 and `daemon.stop()` to `await` it. Update §5.8.8 and §19.8 to show the awaited signature.

### R2 [major] `docs/CONTRACTS.md`

The prompt-containment gate — self-described as "the single most dangerous hunk in M2" (§11.9) — has two contradictory call sites and a guard that cannot catch its failure. §26.2 (line 6788), H28 (line 169) and the §27.4 guard (line 6883) all say the gate runs in `WorkerRegistry.prompt()`; M2-PLAN §1.2 hunk 9 and the landed code put it in `Worker.prompt()` via an optional `validateContent` dep (worker.ts:744), and packages/daemon/src/registry.ts:1017's `prompt` never mentions it. Worse, worker.ts:315 defines a LOCAL function also named `assertPromptContent` (M0's text-only whitelist) that is the default when the dep is absent, so a name-based `assert-prompt-content-is-called` guard passes even when WP-J never injects the real core `assertPromptContent` (packages/core/src/worker/prompt-content.ts) — the containment control would be silently absent while every guard is green. Ownership compounds it: the guard is WP-S's, the injection site is WP-J's registry/create-daemon.

**建议修法**：Pick one call site and make the guard structural. Recommended: keep the gate in `Worker.prompt()`, rename worker.ts's local fallback to `assertTextOnlyContent`, restate §26.2/H28/§27.4 to say `WorkerRegistry.prompt` (or `createWorker`) MUST inject `deps.validateContent` bound to the token's `cwdRoots` and the worker's `promptCapabilities`, and write the guard as "the daemon's worker-creation path passes `validateContent`" plus the existing integration test asserting 400 + zero `session/prompt` calls.

### R3 [major] `docs/CONTRACTS.md`

§22.1 (line 6523), §5.8.9's `viewConfigOptions` (line 4195), packages/protocol/src/worker.ts:94, packages/protocol/src/control-plane.ts:187 and M2-PLAN §2 WP-J acceptance 8 all specify a descriptor quirk named `configOptionIdField` (the spelling of the returned ENTRY's id key). No such field exists: `Quirks` in packages/protocol/src/runtime.ts:98 only has `configIdField: "configId" | "optionId"`, which F34 explicitly says is a DIFFERENT word (the request parameter). `runtime.ts` is Land-frozen and `known.ts`/`merge.ts` are WP-J's, so M2-A-WP-C — whose acceptance 6 depends on lifting `id` through that quirk — cannot land without reopening files it does not own.

**建议修法**：Decide which is meant. If the entry-key spelling is a real per-agent variable, add `configOptionIdField` to `Quirks` (protocol/src/runtime.ts), to `merge.ts`'s learnable set and to both `known.ts` rows in the Land step, with an `unverified` row for codex. If it is not, replace every `configOptionIdField` mention with `configIdField` and state in §22.1 that the entry key is assumed to be `id` until measured.

### R4 [major] `docs/M2-PLAN.md`

M2-A-WP-I acceptance 1 (line 257) requires the baseline strategy's envelopes to be "byte-identical to M1's (asserted with a checked-in golden)" and "every M1 permission test run unedited". That is impossible under ruling M2-R3: §19.10 stamps the auto-resolved `acp.interaction` at payloadVersion 2 with a mapped `request` plus new `kind`/`raw`/`toolCallId`/`answer.parkedMs`, whereas the landed baseline (worker.ts:1730) stamps payloadVersion 1 with the verbatim v1 request and `answer: {optionId, by}`. Concretely broken by the flip: packages/core/test/worker/permissions.test.ts:46 and :107 (`expect(ip.answer).toEqual({optionId, by})`), and the pinned goldens packages/core/test/normalizer/golden/{03,04,09,10}-*.envelopes.json plus their emitter packages/core/test/normalizer/support/emit.ts:182. §5 DoD 1 already concedes "the acp.interaction payload goldens" must change, so the plan contradicts itself. Ownership makes it worse: permissions.test.ts belongs to WP-P, and the normalizer goldens and emit.ts have no M2 owner at all, so WP-I's change lands in two other packages' files.

**建议修法**：Reword WP-I acceptance 1 to "identical to M1 modulo `payloadVersion` and the additive fields, asserted against a checked-in M2 golden", and in §3's ownership map transfer `packages/core/test/normalizer/golden/**` (the four permission goldens), `packages/core/test/normalizer/support/emit.ts` and `packages/core/test/worker/permissions.test.ts` to M2-A-WP-I, listing them in §5 DoD 1 as the tests the contract requires to change.

### R5 [minor] `docs/CONTRACTS.md`

`InteractionContext.failTurn` (line 3847) says `onUnresolved:"fail"` and `parkTimeoutAction:"fail"` "cancel the turn, do not close the worker". That follows D4 (`fail` → `session/cancel` 并标记 run 失败) but directly contradicts DESIGN §3.2's lifecycle row "任意 → `closed` | `DELETE` / `onUnresolved: fail` 触发". The two DESIGN statements disagree with each other and §11.8 records no ruling resolving it, so an implementer reading the binding document first will close the worker.

**建议修法**：Add a ruling (e.g. M2-R24) to §11.8: D4's text governs — `fail` answers the request, cancels the turn and marks any owning run `failed`, and the worker stays open; DESIGN §3.2's `onUnresolved: fail 触发` entry in the `任意 → closed` row is amended accordingly. Cite it from §19.1's diagram.

### R6 [minor] `docs/CONTRACTS.md`

`PolicyCeiling.park` (§5.8.7, line 3647) is enforced only against `onUnresolved:"park"` — §20.5 Layer 1's list ends with "`onUnresolved:"park"` refused when `park: false`". A preset or inline rule whose `action` is `park` (or whose `default` is `park`, as shipped `src-edit` has) is not refused when `ceiling.park === false` and `maxAction` is `allow`, so a token an operator meant to forbid parking can still drive workers into `requires_action` and hold a `maxWorkers` slot indefinitely.

**建议修法**：Extend §20.5 Layer 1 and `assertWithinCeiling`: when `ceiling.park === false`, any rule with `action: "park"` and a `default: "park"` is also `403 policy_exceeds_ceiling`, named in `body.policy.offending`; and add the corresponding `dominates`/clamp row so a runtime `park` verdict clamps to `deny`.

### R7 [minor] `docs/CONTRACTS.md`

`WatchdogConfig.action: z.enum(["cancel","close"])` (§5.8.7) documents `"close"` as "skips straight to it", but §21.5 only specifies the `"cancel"` ladder, and Land exit criterion 4 forbids adding a `WorkerCloseReason`. Nothing says what reason a direct close carries; `cancel_timeout` would be a false statement (no cancel was sent and no timeout elapsed), and any other value violates the no-new-reason rule.

**建议修法**：Either drop `action` from `WatchdogConfig` for M2 (nothing in §21 or the acceptance script uses `"close"`), or state in §21.5 that `action:"close"` closes with the existing `cancel_timeout` reason while still appending `omni.error{agent_timeout}` and `worker_state{reason:"watchdog_idle"}` first, and add the row to the §21.5 ladder.

### R8 [minor] `docs/CONTRACTS.md`

`WEBHOOK_EVENTS` includes `worker.requires_action` and `worker.closed` (§5.8.6) and §24.3 specifies the `worker.requires_action` payload, but a webhook target can only be supplied via `CreateRunRequest.webhook` — `CreateWorkerRequest` has no `webhook` field. So DESIGN §3.2's and D4's "park → 发 webhook" is satisfied only for run-owned workers, and the two worker-scoped events are unreachable for a plain `POST /v1/workers` worker. The gap is not recorded in §2.3's deferral table.

**建议修法**：Either add a row to §2.3 deferring worker-scoped webhook targets to M3/M4 and say explicitly that in M2 D4's park webhook fires only for run-owned workers, or add `webhook: WebhookTarget.optional()` to `CreateWorkerRequest` with the same §24.6 create-time SSRF gate.

### R9 [minor] `docs/M2-PLAN.md`

Two files fall outside the ownership map. (a) `tests/compat/src/cases/support.ts` was created by the Land step (116 lines: `CompatCase`, `CompatContext` and the shared assertions) and is imported by every per-work-package case file, but it appears in neither §1.4's list nor §3's map — so any work package needing a new shared helper or a widened `CompatContext` edits an unowned file that all six touch, which is the exact collision the cases/ split exists to prevent. (b) `packages/daemon/test/http/lease.test.ts` is excluded from WP-J's owns block in §2 but is included by §3's row "`packages/daemon/test/**` (minus the rows above)", since it is not one of the rows above — the two sections disagree.

**建议修法**：Add `tests/compat/src/cases/support.ts` to §1.1's permanently Land-owned (frozen) list and to §3's Land row, with the note that a widening of `CompatContext` is a request to the Land owner; and delete `lease` from WP-J's MINUS list in §2 so §2 and §3 agree that `daemon/test/http/lease.test.ts` is WP-J's.

## 审查结论：fail（9 条）

### R10 [blocker] `packages/core/src/normalizer/turn-lifecycle.ts`

Seam D is declared but not implemented. `TurnInput.prompt_result.meta` exists in protocol/src/contracts.ts:474, worker.ts:822 feeds it, and protocol/src/turn.ts:441 reads `_meta["omni/patch"]` — but `turn-lifecycle.ts` never touches `input.meta`: the `prompt_result` case (line 235) does not carry it onto `TurnLifecycleState`, and `idle()` (line 122-124) builds `_meta` from `warnings` and `vendorPatch` only. The chain is broken exactly at the file §1.1 and §3 freeze to Land, so `TurnResult.patch` is permanently null. This blocks M2-A-WP-W acceptance 9 and M2-WP-J acceptance 4/6, and neither package owns the file. The Land commit message claims this hunk landed.

**建议修法**：Add the one hunk before freezing: give `TurnLifecycleState` a `readonly meta: Readonly<Record<string, unknown>> | null` field, set it from `input.meta ?? state.meta` in the `prompt_result` case (both the settle-now and settling branches, and the `rung > 0` branch), and in `idle()` spread it into the local `meta` record BEFORE the two reducer-owned keys — `Object.assign(meta, state.meta ?? {})` first, then `WARNINGS_META`/`VENDOR_PATCH_META` — so a provider key can never overwrite a reducer key. Reset it to null on `IDLE`. Add a table test that a `prompt_result` with `meta:{"omni/patch":X}` produces `idle._meta["omni/patch"] === X` and that one with no meta emits byte-for-byte M0's payload.

### R11 [blocker] `packages/core/src/worker/worker.ts`

The interaction strategy seam drops the raw agent request on both arms, and `worker.ts` is frozen. `#onPermissionRequest` (line 1462) calls `strategy.permission(mapped, ctx)` and discards the `RequestPermissionRequest`; `#onElicitation` (line 1477) calls `strategy.elicitation(mapElicitationFallback(params), ctx)` and discards `params`. Neither `MappedPermissionRequest` (contracts.ts:535) nor `MappedElicitationRequest` (contracts.ts:594) has a `raw` field, and `InteractionContext` (contracts.ts:649) carries only turnId/emit/park/failTurn. But `InteractionRequest.raw` is contracted as "Verbatim params. NEVER reshaped" (contracts.ts:622), M1's `#baselinePermission` embeds `request: req` verbatim on the `acp.interaction` envelope (worker.ts:1735), and Land exit criterion 3 requires an `acp.interaction{kind:"elicitation", …, raw, toolCallId}` to round-trip. Separately, `mapElicitationFallback` is hard-wired, so M2-A-WP-I's real `mapElicitation` in its own file `normalizer/map/elicitation.ts` can never run — the strategy always receives `fields: []`, making WP-I acceptance 3, 4 and 10 unreachable without editing a frozen file.

**建议修法**：Widen both mapped types in the Land step with `readonly raw: Readonly<Record<string, unknown>>` and populate them: in `Normalizer.mapPermissionRequest` set `raw: req as unknown as Record<string, unknown>`, and in `mapElicitationFallback` set `raw: p`. WP-I's strategy then emits `payload.request = req.raw` verbatim and re-maps the elicitation itself with `mapElicitation(req.raw)`, leaving worker.ts frozen. (The alternative — `permission(mapped, raw, ctx)` / `elicitation(rawParams, ctx)` — also works but changes the interface WP-I is already coding against.)

### R12 [blocker] `packages/core/src/worker/worker.ts`

Hunk 6 landed as an unreachable stub. `Worker.setConfig` (line 1585) runs the lease/`worker_closed`/`worker_busy` gates and then unconditionally `throw new OmniError("internal", "unimplemented: M2-A-WP-C")`. M2-PLAN §1.2 hunk 6 specifies the full body here (auto-wake, `#configOptions` replaced wholesale from the method result) with `agent_error` (-32601) as the absent-dep default, and `worker.ts` is frozen afterwards. There is no seam for M2-A-WP-C to reach in: `CreateWorkerDeps`' six M2 fields (line 172-195) are interactions/watchdog/diff/validateContent/clientCapabilities/mcpServers — none of them is a config-options hook. WP-C owns `core/src/worker/config-options.ts` but nothing can call it, so acceptance 1-4, 6 and 8 all require editing a frozen file. Two further gaps in the same stub: `hibernated` falls through to the `internal` throw instead of auto-waking (registry.ts:1096 only re-runs the ACL, it does not wake), and the absent-dep code is `internal` rather than the specified `agent_error`/-32601.

**建议修法**：Before freezing, either (a) land hunk 6's real body — `mapRequest("session/set_config_option", …)` through the injected normalizer, auto-wake on `hibernated` exactly as `prompt()` does, replace `#configOptions` wholesale from the result, and throw `agent_error` with -32601 when the descriptor advertises no spelling — with WP-C owning only the pure `viewConfigOptions`/delta helpers in `config-options.ts`; or (b) add a seventh optional dep `readonly configOptions?: ConfigOptionsStrategy` to `CreateWorkerDeps` and have `setConfig` delegate to it, defaulting to the -32601 `agent_error` when absent. Option (b) matches the other five seams and keeps worker.ts genuinely frozen.

### R13 [blocker] `packages/testkit/src/scripted-agent.ts`

The file is unchanged by the Land commit, but M2-PLAN §1.1 lists it as Land-frozen with "+1 generic client-request hook", and that hook is what M2-A-WP-I's fixtures need. `ScriptedAgent` (line 16-38) exposes only `requestPermission(options)`; there is no verb that issues an arbitrary agent-to-client JSON-RPC request. `packages/testkit/src/scripts/elicitation.ts` takes a `ScriptedAgent` and is supposed to issue `elicitation/create` with transcript 12's exact shape, and it cannot. WP-I acceptance 3, 4, 5, 6, 7 and 9 (and the `elicit-*` fixtures behind them) are all blocked on a Land-frozen file.

**建议修法**：Add one member to `ScriptedAgent` and its factory before freezing: `request(method: string, params: Record<string, unknown>): Promise<unknown>`, implemented as `cx.request(method, params)` using the same untyped overload `requestPermission` already selects at line 155, with the same `hanging`/`dead` guards and the same -32800 settle-on-cancel path. Re-export nothing new (`index.ts` already exports `ScriptedAgent`).

### R14 [major] `packages/core/src/worker/worker.ts`

`#endPatch` (line 1651) awaits `provider.end(handle)` with no bound — no timeout, no `AbortSignal`, even though `DiffProvider.end(h, o?: {signal?})` accepts one and CONTRACTS §25.1 states "`worker.ts` awaits `provider.end(handle)` bounded by `diff.timeoutMs`". `CreateWorkerDeps.limits` gained only `parkTimeoutMs`, so the worker has no access to `diff.timeoutMs` at all. A provider that hangs deadlocks the turn: `prompt_result` is never fed, `idle` is never emitted, `TurnResult` never settles. That makes M2-A-WP-W acceptance 9 ("a hung provider still yields `idle` with `patch: null` and a `patch_timeout` warning") unsatisfiable, since `testkit/src/fake-diff-provider.ts` is precisely where WP-W will write the hanging provider — and worker.ts is frozen.

**建议修法**：Add `readonly diffTimeoutMs?: number` to `CreateWorkerDeps.limits` and race `provider.end` in `#endPatch` against a `this.#deps.clock.setTimer(diffTimeoutMs)`, passing an `AbortController`'s signal to `end`. On expiry return a `PatchResult` with `text: null`, `quality: "unavailable"` and a `TurnWarning{code:"patch_timeout"}` rather than null, so the warning still reaches `idle._meta` through seam D. Apply the same bound to `begin` at line 800.

### R15 [major] `packages/core/src/worker/worker.ts`

Two teardown members of the M2 contracts are never called from the frozen worker: `InteractionStrategy.close()` (contracts.ts:695) and `Watchdog.cancel()` (contracts.ts:810) appear nowhere in worker.ts. `#doClose` (line 1949) calls `#settleInteractions("close")` and cancels `#tickTimer`/`#cancelTimer`/`#exitGraceTimer`, and `#doHibernate` (line 972) does the same, but neither disposes the strategy or the watchdog. WP-I's park-timeout timer and WP-W's `Clock.setTimer` therefore stay armed past close — the exact bug commit 7c80f15 fixed for the lease TTL timer ("its TTL timer kept the process alive"), which will resurface as a hung suite and violate M2 DoD 6. A watchdog surviving a close can also fire `onFire -> cancelInternal()` on a dead worker. Neither WP owns worker.ts, so neither can fix it.

**建议修法**：In the Land step add `this.#deps.watchdog?.cancel()` and `this.#deps.interactions?.close()` to `#doClose` and `#doHibernate`, in the same block as the three existing timer cancels, each wrapped in the try/catch `#settleInteractions` already uses so a throwing dependency cannot break a close. Both members are contracted idempotent, so calling them blindly on every teardown path is safe.

### R16 [major] `docs/M2-PLAN.md`

The §4 acceptance script's Step 4 cannot pass against its own defaults. `webhooks.denyCidrs` defaults to `["127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10", "10.0.0.0/8", …]` (protocol/src/config.ts:3735 per CONTRACTS), and CONTRACTS §24.6 says "Every resolved address is checked against `denyCidrs` … before the connect" with no exemption for an explicitly allowlisted origin. But §4's Setup config passes only `webhooks: {enabled:true, mode:"allowlist", allow:[<the local receiver's origin>], secrets:{…}}`, and Step 4 runs `fakeWebhookReceiver()` on loopback. Every webhook run in the acceptance script — and in `run-webhook.itest.ts` and the hermetic CI matrix — will be 403 at create. M2-B-WP-R acceptance 9 ("a hostname resolving into `denyCidrs` is `403`") and acceptance 3/8/10 (a loopback receiver that must succeed) contradict each other as written.

**建议修法**：Settle the precedence now, before WP-R codes the guard, and state it in CONTRACTS §24.6: either (a) an origin named explicitly in `allow` bypasses the CIDR check (document it as the operator's deliberate override, and keep the CIDR check authoritative under `mode:"any"`), or (b) keep the CIDR check absolute and add `denyCidrs: []` to §4's Setup config block, to `run-webhook.itest.ts`, and to the CI matrix's daemon config. Option (b) is the smaller change and keeps the SSRF gate honest; whichever is chosen, WP-R acceptance 9's fixture must then use a non-loopback deny address such as 169.254.169.254.

### R17 [minor] `tests/compat/src/cases/support.ts`

Two shared files the Land step created or edited have no owner in §3's map, and the map's rule is that an unlisted path "keeps its M1 owner" — which does not exist for a new file. `tests/compat/src/cases/support.ts` (new, 116 lines) holds `CompatCase`, `CompatContext` and the shared assertions, and all seven per-WP case files plus `m1.ts` import it; §3 lists `tests/compat/src/{harness,runner,config}.ts` as Land-frozen and each `cases/*.ts` individually, but never `support.ts`. `packages/testkit/src/stub-daemon.ts` (modified, +65) is likewise unlisted while §1.1 freezes only `testkit/src/{index,scripted-agent}.ts`, and WP-I, WP-C and WP-R all build their route tests on `stubDaemon()`. The split was supposed to make it impossible for six packages to meet in one file; these two are where they still can.

**建议修法**：Add both paths to the Land (frozen) row of §3 and to §1.1's permanently Land-owned list, and state the rule the plan already applies elsewhere: a work package that needs a new shared helper puts it in its own case/test file, or files a request to the Land owner. `stubDaemon` already takes `Partial<Daemon>`, so no WP needs to edit it for overrides.

### R18 [minor] `docs/M2-PLAN.md`

M2 DoD §5.1 requires that each M1 test whose shape the contract changed be "listed in the M2 Land commit's message with the section that requires it". The Land commit message documents H28 and F42 but lists none of the seventeen: `core/test/event-log/m1-acceptance.test.ts`, `core/test/normalizer/corpus.test.ts`, `core/test/normalizer/support/corpus-facts.ts`, `core/test/worker/handshake.test.ts`, `core/test/worker/permissions.test.ts`, and twelve `protocol/test/transcripts/*.expected.json` goldens. Each edit is individually justified in an inline comment and none is a weakening, but the commit message is the artifact the DoD names and the record M2's reviewers will read.

**建议修法**：Amend the Land commit message (or record it in M2-PLAN §5) with a short table: file, what changed, and the section requiring it — the `InteractionRecord` widening (§5.8.5) for `permissions.test.ts` and the twelve goldens, `clientCapabilities` on the handshake snapshot (§5.8.4) for `handshake.test.ts`, and the corpus growing 11 -> 18 transcripts for the two normalizer files.

## Land agent 的备注

S1. AMBIGUITY — `cases/index.ts` ownership. M2-PLAN §1.1 lists it as permanently Land-owned; §3's table gives `cases/{index,patch}.ts` to WP-J. Resolved in favour of §1.1 AND made the conflict moot: `index.ts` already imports all eight case files, including the seven empty ones, so no work package ever has to edit the registry to add its cases. WP-J still owns `patch.ts`.

S2. NEW FILE not in the ownership map — `/home/qiufuyu/Plurics-Lab/omni-acp/tests/compat/src/cases/support.ts`. The split needed somewhere for `CompatCase`/`CompatContext` and the five shared helpers (`assert`, `deepEqual`, `allEnvelopes`, `updateKind`, `V1_ONLY_KINDS`). Putting them in `index.ts` would make every case file import the registry that imports it. It is Land-owned and frozen; content is verbatim from the old `cases.ts` apart from an `export` keyword and two `../` in import paths.

S3. The seven per-WP compat case files return `[]` rather than throwing, against the Land convention. `runner.ts` enumerates every case at LOAD, so a factory that threw would take M1's thirteen green cases with it. An empty list is the honest 'this package has recorded no case yet', and `OMNI_COMPAT_REQUIRE=1` still turns an empty selection into a failure. Each file says so in its header.

S4. OPTIONALITY — every M2 row on `WorkerSnapshot`, `WorkerRow` and `AgentCapabilitiesSnapshot.clientCapabilities` is `?`, where CONTRACTS §5.8.4/§5.8.8 writes them required. Reason is M1-PLAN §1.2's, restated in each doc comment: these objects are built in `worker.ts`, `rehydrated.ts`, `boot-recovery.ts` and a dozen test doubles, and a required field whose only producer throws takes the M1 suite with it. Each work package fills its own rows; M2-WP-J tightens at the join. `clientCapabilities` is the exception that is now REAL — the handshake fills it (see below).

S5. OPTIONALITY, the load-bearing one — `InteractionPayload.kind`/`raw`/`toolCallId`/`answer.parkedMs` and `PolicyDecisionPayload.kind`/`method`/`by`/`ruleSource`/`parkedMs` are optional in the TYPE, not just the schema. Land exit criterion 3 requires a checked-in M1 `events.db` to parse under the M2 schema, and an M1-written envelope carries none of them. `reduceTurn` supplies the M1 reading for each (`permission`, `session/request_permission`, `baseline`, `0`) — every one a truth about an M1 daemon, not a guess.

S6. `CreateWorkerRequest`'s exported TS type is `z.input`, not `z.infer`. `onUnresolved` gained `.default("deny")` per §5.8.6, which makes the OUTPUT field required; `WorkerRegistry.create` is D15's in-process entry and is called by `client/src/server.ts`, `OmniACP.local()` and a dozen tests that should not have to spell a field whose point is that it defaults. The parsed body is still assignable to the input type, so the route is unchanged and the wire default still fires at `parse`.

S7. `PolicySelection` lives in `control-plane.ts`, not `config.ts`. CONTRACTS puts it under §5.8.6 (a wire body) but the `PolicyRule`/`POLICY_ACTIONS` it is built from are §5.8.7 (config). Defining it in both produced a duplicate barrel export; it is defined once beside `CreateWorkerRequest`, with a pointer comment left in `config.ts`.

S8. ADDITION beyond §5.8.8 — `Watchdog` gained `readonly config: ResolvedWatchdogConfig` (a fourth member). `WorkerSnapshot.watchdog` must report `{silentMs, toolMs, cancelTimeoutMs}` 'so an operator reads them without re-deriving config', `worker.ts` is frozen after this commit, and a worker handed the numbers a second time can disagree with its own watchdog. The reason is written at the declaration.

S9. `TurnResult.strandedToolCalls` is declared and STUBBED to `[]` — the field exists, the computation does not. Computing it at Land would change `permission-deny` and `tool-call-upsert` from `ok` to `partial`, i.e. implement behaviour, which the Land step must not; and WP-W's acceptance bullet 8 says no M1 golden changes its verdict. The precedent is M1's `patch: null`. The full M2-R8 rule is spelled out at the stub so WP-W is implementing a written rule, not inferring one. `pendingInteractions` IS folded (the §5.8.5 `Set` on `acp.interaction`) because it is provably `[]` on every M1 golden.

S10. HUNK 9 placement differs from M2-PLAN §1.2's literal reading. The plan says `await (validateContent ?? assertPromptContent)(content)` 'in `prompt()`'; the M1 call sat BEFORE the check-and-set, and an `await` there would reopen the 50-concurrent-callers race the admission exists to close. It runs immediately AFTER `#state = "running"` and rolls the admission back on rejection, exactly as the existing `#step` failure does — so the `400` still comes from `prompt()` (H8's status unmoved) and F37/F38's 'zero `session/prompt` calls' holds by construction.

S11. `mapElicitation` is a free function on `@omni-acp/core` (§5.8.9), NOT a `Normalizer` member — it is pure, total and holds no descriptor, so there is nothing per-runtime to branch on. `worker.ts` therefore carries a small `mapElicitationFallback` returning the honest unparseable shape (`fields: []`, every property in `unmodelled`) until WP-I injects the real mapper through the strategy.

S12. `seqIds().request()` changed prefix `r_` → `q_` (and `seq-ids.test.ts` with it, the only assertion on the value). `r_` is now `RunId`, and a fake whose opaque request ids look exactly like real run ids is a collision an `assertRunId` test would pass for the wrong reason.

S13. PRE-EXISTING RED ON MAIN, fixed here. `07e1086` added seven M2 research transcripts to `docs/research/transcripts/claude-acp-0.73.0/` without updating the M1 corpus counts, so `core/test/normalizer/corpus.test.ts` (11/216, the kind distribution, properties 4/5/6) and `core/test/event-log/m1-acceptance.test.ts` (F13's 23 `available_commands_update`) were already failing at HEAD — confirmed by stashing my work and re-running. Fixed by NAMING the M1 set rather than globbing: `M1_TRANSCRIPTS` in `core/test/normalizer/support/corpus-facts.ts` and `M1_CORPUS_FILES` in the event-log acceptance (which also throws if an M1 file goes missing). `corpus.test.ts` now asserts BOTH numbers — 11 M1 and 18 on disk — so a transcript nobody uses is still visible.

S14. TEST ADAPTATIONS, each a contract-required shape change and each carrying a comment saying why: 12 `protocol/test/transcripts/*.expected.json` (additive `patchInfo`/`strandedToolCalls`/`pendingInteractions`; `permission-deny` also gains the widened `InteractionRecord` fields); `protocol/test/config.test.ts` (M2 defaults, `CreateWorkerRequest` now ACCEPTS mcp/policy/env/park and still refuses a command object, `PromptRequestBody` no longer decides types); `protocol/test/errors.test.ts` (two codes); `protocol/test/events-schema.test.ts` (`omni.run` arm, plus two NEW tests: an M1-era envelope still parses, and M2's widened arms parse); `core/test/worker/permissions.test.ts` and `client/test/prompt.test.ts` (widened `InteractionRecord`); `core/test/worker/handshake.test.ts` (`clientCapabilities: {}` on the snapshot); `daemon/test/registry.test.ts` + `daemon/test/http/routes.test.ts` (H28 — the block-TYPE decision moved out of the schema, so those two tests now assert the SHAPE boundary the route still owns and that types are forwarded); `daemon/test/create-daemon.test.ts` + `testkit/test/stub-daemon.test.ts` (whoami's three new fields); `daemon/test/arch/http-has-no-logic.test.ts` (four new route files, all still covered); `testkit/test/seq-ids.test.ts` (`q_` prefix); `tests/integration/src/exports-are-stable.itest.ts` (records the new runtime AND type surface — WP-J acceptance 12). No test was deleted and none had an assertion weakened.

S15. F42 is left UNFIXED in `session-open.ts`'s reopen path, deliberately and with a comment saying so. `SessionOpenOptions` now carries `clientCapabilities` and `open()` threads it; `handshake.ts` takes it as a parameter, sends it, and records it on `AgentCapabilitiesSnapshot` AS SENT (§5.8.4, F28). The wake path still hard-codes `{}` — that is the line WP-I's acceptance bullet 2 says a regression test must be written against FIRST, and landing the fix would leave that test passing on arrival.

S16. NOT created, and why: the seven fixture agents (`elicit-*.mjs`, `stall-*.mjs`, `permission-allow-always-only.mjs`) — they are behaviour, not `src/**/*.ts` signatures, and each encodes a recorded wire shape its owning package must get right. Likewise the named guard tests (`no-elicitation-schema-parse`, `policy-never-names-an-option`, `webhook-body-is-thin`, `client-never-sends-a-command`, `patch-runs-no-shell`, `env-deny-is-one-table`, `assert-prompt-content-is-called`, `no-unbounded-outbound`): M2-PLAN §3 says 'guard tests live with their owner', and several are specified as having to be demonstrated FAILING on a planted violation, which is not something a stub can do.

S17. `Daemon.runs` and `Daemon.deliveries` are REQUIRED members (per §5.8.8) filled by `unimplementedRuns()` / `unimplementedDeliveries()` in `create-daemon.ts` and by refusing doubles in `stubDaemon()`. Every verb answers `bad_request` naming M2-B-WP-R — D29's honest 'not implemented yet' and the M1 Land precedent S8. A `list()` returning `[]` would say there are no runs, which is a different and worse lie, so only the two list-shaped reads return empty.

S18. `AuthContext.assertEnv(undefined)` and `assertMcp(undefined)` answer honestly (`{env:{},keys:[],persist:true}` and `[]`) instead of throwing: a request that asked for no env and no MCP is every M1 request, and refusing it would refuse the whole existing suite. Every non-empty case throws naming M2-B-WP-S. `assertPolicy` always throws — there is no 'asked for nothing' reading of a policy question.

S19. `docs/CONTRACTS.md` (rewritten to M2) and `docs/M2-PLAN.md` were uncommitted working-tree files at session start; both are in this commit, since a Land commit that cites documents absent from the repository is not reviewable.

S20. Not done, out of scope for Land and named in M2-PLAN as somebody's: `tests/compat/agents.{ci,local}.yaml` are explicitly NOT frozen and stay WP-J's; `runtime/known.ts`'s new descriptor rows and `unverified` entries are WP-J's; the M2-PLAN §5 real-agent record is WP-J's; `persist/schema.ts` still says `SCHEMA_VERSION = 1` because the v2 CREATE-only migration is WP-R's (the file was transferred, not edited).

---

## 处理记录（2026-09-09，Land 修订提交）

`pnpm -r build && pnpm test` 绿：**2175 passed / 53 skipped / 134 todo**（Land 提交时 2170 passed；新增 5 条
seam D 表驱动测试）。`eslint .` 与 `prettier --check .` 干净。以下逐条对应，未处理的写明理由。

### 审查结论 pass-with-issues（R1–R9）

| # | 处置 | 做了什么 |
| - | ---- | -------- |
| **R1** | **applied** | `InteractionStrategy.settleAll` 与 `PendingInteractions.settleAll` 均改为 `Promise<void>`（`protocol/src/contracts.ts`、`core/src/worker/interaction/registry.ts`）；`Worker.#settleInteractions` 改为 `async`；`cancel()`（`session/cancel` 之前）、`#doClose`、`#doHibernate` 与崩溃休眠路径全部 `await`。`daemon.stop()` 经由 worker close 到达它，而 close 现在是 awaited 的。CONTRACTS §5.8.8 与 §19.8 写上 awaited 签名并解释为什么 `void` 表达不了那条顺序保证；M2-PLAN §1.3 seam A 的示例改为 `async settleAll() {}`。 |
| **R2** | **amended** | 采纳建议：门留在 `Worker.prompt()`，`worker.ts` 里的本地兜底改名为 **`assertTextOnlyContent`**——与注入的 `assertPromptContent` **故意不同名**，这样按名字匹配的 guard 不可能在注入缺失时通过。CONTRACTS §26.2 / H28 / §27.4 改写为“daemon 的 worker 创建路径 **必须** 注入 `deps.validateContent`（绑定 token 的 `cwdRoots` 与 worker 的 `promptCapabilities`）”，guard 定义为**结构性**的；M2-PLAN WP-S 验收 8 同步。另外修掉了 `daemon/src/registry.ts` 里 `prompt` 上那句已经不成立的注释（“The M0 content pre-check IS this schema”——H28 删掉 refine 之后 schema 只管形状）。guard 测试本身仍是 WP-S 的（见 S16）。 |
| **R3** | **amended** | 选了“不是 quirk”这一支，并且是**量过的**而不是假设的：条目键在 claude `15` 与 codex `07` 里都是 `id`。因此删掉了全部 `configOptionIdField` 提及（`protocol/src/worker.ts`、`protocol/src/control-plane.ts`、`core/src/worker/config-options.ts`、`daemon/src/http/routes/config.ts`、CONTRACTS §22.1 与 §5.8.9、M2-PLAN WP-J 验收 8、`m2-acceptance.itest.ts` 的 todo 文案），`Quirks.configIdField`（**请求**参数拼写，F34）原样保留，`runtime.ts` 未动。§22.1 陷阱 3 现在写明“只有一个 quirk”，并说明将来真有 agent 换拼法时才加，附上逼出它的 transcript。 |
| **R4** | **applied** | WP-I 验收 1 改写为“identical to M1 **modulo `payloadVersion` 与新增字段**，对着 checked-in 的 **M2** golden 断言”，并点名它会改的文件；§3 与 WP-I 的 owns 块把 `core/test/normalizer/golden/{03,04,09,10}-*.envelopes.json`、`core/test/normalizer/support/emit.ts`、`core/test/worker/permissions.test.ts` 转给 WP-I（同时从 WP-P 的两处移除 `permissions.test.ts`）；CONTRACTS §19.10 里“every M1 permission test run unedited”那句一并改正；完整清单落在 M2-PLAN §5.1。 |
| **R5** | **applied** | 新增裁决 **M2-R24**：D4 的文本作准——`fail` 回答请求、取消**这一轮**、把拥有它的 run 标 `failed`，**worker 保持打开**；DESIGN §3.2 `任意 → closed` 行里的 `onUnresolved: fail 触发` 相应修订。§19.1 的流程图下方与 `InteractionContext.failTurn` 的两处注释（CONTRACTS §5.8.8 与 `contracts.ts`）都引用了它。 |
| **R6** | **applied** | §20.5 Layer 1 扩成：`park: false` 时 `onUnresolved:"park"`、任何 `action: "park"` 的规则、以及 `default: "park"` **三者都** 403 并逐条进 `body.policy.offending`（`src-edit` 预设正是 `default:"park"`，这就是那个洞）；另加运行期一行——`park` 判决 clamp 到 `deny`。`core/src/policy/ceiling.ts` 两个 stub 的文档同步。 |
| **R7** | **amended** | 选了“说清楚”而不是“删掉”：`WatchdogConfig.action` 保留（`config.test.ts` 已断言其默认值），§21.5 加了一行阶梯——`action:"close"` 仍**先**追加 `omni.error{agent_timeout}` 与 `worker_state{reason:"watchdog_idle"}`，然后以 **`cancel_timeout`**（M1 既有 reason，Land 出口条件 4 不许新增）关闭，不等 `cancelTimeoutMs`。`config.ts` 的字段注释写上同一句，并注明“这个 reason 是被选定的，不是留白”。 |
| **R8** | **applied** | §2.3 增加一行 deferral：M2 里 D4/DESIGN §3.2 的 “park ⇒ 发 webhook” **只对 run 所有的 worker 生效**；`worker.requires_action` / `worker.closed` 两个事件是规格齐备且可达的，缺的是 per-worker 的 target，推到 M3/M4 (D9)。 |
| **R9** | **applied** | (a) `tests/compat/src/cases/support.ts` 进 §1.1 永久 Land 冻结清单与 §3 的 Land 行，并写下规则：需要新共享 helper 的 WP 放进自己的 case/test 文件，加宽 `CompatContext` 是**向 Land owner 提请求**。(b) WP-J 的 MINUS 列表删掉 `lease`，§2 与 §3 现在一致。 |

### 审查结论 fail（R10–R18）

| # | 处置 | 做了什么 |
| - | ---- | -------- |
| **R10** | **applied（blocker）** | seam D 真正写进 `core/src/normalizer/turn-lifecycle.ts`：`TurnLifecycleState` 加 `meta`，`prompt_result` 的**三条分支**（settle-now / settling / `rung > 0`）都从 `input.meta ?? state.meta` 带上，`IDLE` 复位，`idle()` 里 `Object.assign(meta, state.meta ?? {})` **先**执行、两个 reducer 自有键**后**盖——provider 键永远盖不掉 reducer 键。新增 `turn-lifecycle.test.ts` 的 “seam D” 五条：键逐字（by identity）到达、无 meta 时逐字节等于 M0 的 payload、跨 quiet window 仍带、reducer 键胜出（用真有 warning 的一轮断言）、上一轮的 meta 不会漏到下一轮。 |
| **R11** | **applied（blocker）** | 采纳“加宽 mapped 类型”那一支，`worker.ts` 保持冻结：`MappedPermissionRequest` 与 `MappedElicitationRequest` 各加 `readonly raw`。`mapPermissionRequest` 写 `raw: record(r["raw"]) ?? r`——第二次映射保留第一次的 `raw`，`map(map(x)) === map(x)` 的既有幂等测试因此仍然成立；`mapElicitationFallback` 写 `raw: p`。WP-I 的策略从此可以 `mapElicitation(req.raw)` 自行重映射并逐字发出 `payload.raw`。 |
| **R12** | **applied（blocker，选 (a)）** | `Worker.setConfig` 落成真身：lease/closed/busy 门 → **auto-wake**（与 `prompt` 同）→ `mapRequest("session/set_config_option", …)` 的拼写循环（`-32601` ⇒ `noteUnsupported` ⇒ 下一个拼写；全部耗尽 ⇒ `agent_error` 携 `-32601`）→ `link.request` → `viewConfigOptions` **整体替换** `#configOptions`（返回 `null` ⇒ `stale:true` 且**保留**旧表）→ `configOptionsDelta` 出 `removed/added` → 把合成的 `config_option_update`（带 `_meta["omni/source"]`）作为 **`agent_update`** 喂进 reducer，好让**描述符**决定它是否落盘（§14.6 的 `keep`）。`#configOptions` 在握手与每次 wake 时由 `viewConfigOptions` 播种（§22.2），播种被 try/catch 包住并注明理由。`config-options.ts` 只留 WP-C 的纯函数：`viewConfigOptions` 与新的 `configOptionsDelta`；`setConfigOption` 从 §5.8.9、`core` barrel、`exports-are-stable.itest.ts` 一并移除（它的函数体就是 hunk 6）。 |
| **R13** | **applied（blocker）** | `ScriptedAgent` 增加 `request(method, params): Promise<{result} | {error}>`，用的是 `requestPermission` 同一个 untyped 重载与同样的 `dead` 守卫，`AcpRequestError` 转成 `{error: code}`（取消即 `-32800`）。`index.ts` 无需新导出。 |
| **R14** | **applied** | `CreateWorkerDeps.limits` 增加 `diffTimeoutMs?`（缺省常量 `DEFAULT_DIFF_TIMEOUT_MS = 15_000`，即 `DiffConfig.timeoutMs` 的默认值）；新增 `#withDiffBudget`，把 `#withDeadline` 与一个 `AbortController` 合起来，**`begin` 与 `end` 都** 走它。超时时 abort signal，并回一个真的 `PatchResult{text:null, quality:"unavailable", warnings:[patch_timeout(source:"patch")]}` 而不是 `null`——warning 必须经 seam D 到 `idle._meta`，那是纯 fold 唯一读得到它的通道。CONTRACTS §25.1 与 M2-PLAN hunk 8 同步。 |
| **R15** | **applied** | 新增 `Worker.#disposeSeams()`：`watchdog.cancel()` + `interactions.close()`，各自 try/catch，与既有三个 timer cancel 放在同一块；在 `#doClose`、`#doHibernate` **和** `#hibernateAfterCrash` 三条 teardown 路径上调用（崩溃休眠路径同时补上 `settleAll("hibernate")`——进程已经死了，把 agent 的请求挂在死管道上正是 F1 的教训）。CONTRACTS §5.8.8 的 `Watchdog.cancel` / `InteractionStrategy.close` 注释说明它们从哪里被调。 |
| **R16** | **amended（选 (b)）** | CIDR 检查**绝对优先**：`allow` 里的条目**不**豁免 `denyCidrs`。§24.6 与 `core/src/webhook/guard.ts` 写明两个控制回答的是不同问题，以及“允许清单豁免 SSRF 门”会让 `webhooks.allow` 变成通往元数据端点的代理。随之把 `denyCidrs: []` 写进 M2-PLAN §4 的 Setup 配置块并在 Step 4 点名原因；WP-R 验收 9 的 fixture 改用 **`169.254.169.254`** 而非 loopback，并要求它自己的 daemon 配置也设 `denyCidrs: []`。 |
| **R17** | **applied** | 与 R9 一并：`tests/compat/src/cases/support.ts` 与 `packages/testkit/src/stub-daemon.ts` 都进 §1.1 的永久 Land 冻结清单与 §3 的 Land 行，并写下“需要加宽就向 Land owner 提请求；`stubDaemon` 本来就收 `Partial<Daemon>`，没有 WP 需要为覆盖一个 verb 去改它”。 |
| **R18** | **amended** | 不去改一条不可修订的 commit message：新增 **M2-PLAN §5.1**「The M1 tests the contract required to change」表——文件、改了什么、哪一节要求的，覆盖十二个 transcript golden、`permissions.test.ts`、`client/test/prompt.test.ts`、`handshake.test.ts`、语料三件套、`config/errors/events-schema` 三个 protocol 测试、两个 daemon 测试、`whoami` 两处、arch guard、`seq-ids`、`exports-are-stable`，外加本次评审自身引入的两行。DoD 1 改为指向该表，并说明为什么记录搬了家。 |

### Land agent 备注 S1–S20

| # | 处置 | 说明 |
| - | ---- | ---- |
| S1 | **applied** | 按 §1.1 定案：`cases/index.ts` 是 Land 的，§3 与 WP-J 的 owns 块都改成只给 `cases/patch.ts`。记入 M2-PLAN §1.6 第 1 行。 |
| S2 | **applied** | 见 R9/R17：`support.ts` 正式入册并冻结。 |
| S3 | **documented** | 七个空 case 工厂返回 `[]` 而不抛——`runner.ts` 在 LOAD 期枚举，抛出会连带 M1 的十三个绿 case。记入 §1.6 第 3 行。 |
| S4 | **documented** | M2 快照行全部可选。写进 CONTRACTS §5.8 前言（四条与文档写法不同的拼写，逐条给理由）与 §1.6 第 4 行。 |
| S5 | **documented** | `InteractionPayload` / `PolicyDecisionPayload` 的新字段在**类型**上也可选——Land 出口条件 3 要求 M1 的 `events.db` 能在 M2 schema 下解析。同上两处。 |
| S6 | **documented** | `CreateWorkerRequest` 导出 `z.input`。同上。 |
| S7 | **documented** | `PolicySelection` 定义在 `control-plane.ts`。同上。 |
| S8 | **documented** | `Watchdog.config` 第四成员写进 CONTRACTS §5.8.8 的接口块与 §1.6 第 5 行。 |
| S9 | **kept, documented** | `strandedToolCalls` 保持 stub 成 `[]`，明确**是 M2-A-WP-W 要算的**：`turn.ts` 的 stub 处已写全 M2-R8 的规则，§1.6 第 6 行复述“Land 步骤不实现行为”的理由与 M1 `patch: null` 的先例。 |
| S10 | **documented** | hunk 9 的位置（`#state = "running"` **之后**）写进 hunk 表与 §1.6 第 7 行；R2 的改名让这条更硬。 |
| S11 | **documented** | `mapElicitation` 是自由函数、`worker.ts` 带 fallback；§1.6 第 8 行，并补上“R11 之后 fallback 也带 `raw`，所以真 mapper 不用重开冻结文件”。 |
| S12 | **documented** | `q_` 前缀记入 §5.1 表与 §1.6 第 9 行。 |
| S13 | **documented** | `main` 上的既有红（`07e1086` 加了七个 transcript 没更新计数）与“具名而非 glob”的修法记入 §5.1 表与 §1.6 第 10 行。 |
| S14 | **documented** | 全部测试适配逐行进 §5.1 的表。 |
| S15 | **documented** | F42 故意不修，记入 §1.6 第 11 行（WP-I 验收 2 要求回归测试先写）。 |
| S16 | **documented** | 七个 fixture agent 与八个具名 guard 未创建，记入 §1.6 第 12 行；R2 的结构性 guard 依然是 WP-S 的。 |
| S17 | **documented** | `Daemon.runs` / `deliveries` 的 `unimplemented*` 处理记入 §1.6 第 13 行。 |
| S18 | **documented** | `assertEnv(undefined)` / `assertMcp(undefined)` 的诚实回答记入 §1.6 第 14 行。 |
| S19 | **skipped(no action)** | 两份文档已在 Land 提交里；没有可做的事。 |
| S20 | **documented** | `schema.ts`、`agents.*.yaml`、`known.ts` 的新行仍属各自 WP，记入 §1.6 第 15 行。 |

**范围**：本次只补 seam 与文档一致性，不实现任何工作包的行为。`viewConfigOptions`、`configOptionsDelta`、
`assertPromptContent`、`assertWithinCeiling`、`clampVerdict`、`assertWebhookUrl`、`strandedToolCalls` 等仍是
签名齐备、body 抛 `unimplemented` 的 stub，归属不变。

---

## 处理记录 · 复审跟进 round 1（2026-09-09）

对上表的复审提出十条（2 major + 1 major stub + 7 minor），全部处理。`pnpm -r build && pnpm test` 绿：
**2175 passed / 53 skipped / 134 todo**（与上一轮同数——本轮只加了一个抛 `unimplemented` 的 stub 与一行
导出断言，没有新增行为）。`eslint .` 与 `prettier --check .` 干净。

| # | 处置 | 做了什么 |
| - | ---- | -------- |
| **1** | **applied** | R5 只落了一半：裁决 M2-R24 写进了 CONTRACTS，DESIGN 却没动，而 DESIGN 在约束文档里优先级最高——按顺序读的实现者仍会得到“`fail` 关闭 worker”。`docs/DESIGN.md` §3.2 的 `任意 → closed` 行删掉 `onUnresolved: fail 触发`（只留 `DELETE` 与不可 resume 的崩溃），并在同一行点名“`onUnresolved: fail` **不在**此行，它取消本轮、worker 保持打开（裁决 M2-R24）”；D4 §231 的 `fail` 分句改为“`session/cancel` 取消本轮并标记 run 失败，**worker 保持打开**（裁决 M2-R24：`fail` 是对一个请求的策略判决，不是对 session 的判决；§3.2 的 `任意 → closed` 行相应修订）”。两处都写了裁决号，可追溯。 |
| **2** | **amended（加宽 Land 面）** | 确认这是真洞：`startCompatHarness` 的 `config()` **就是** M2-R16 处置里点名的“CI matrix 的 daemon 配置”，而它一个 `webhooks` / `diff` 块都不发——`WebhookConfig` 默认 `enabled:false` + `mode:"allowlist"` + 空 `allow` + 含 loopback 的 `denyCidrs`，三重拒绝掉 `cases/webhook-run.ts` 的每一次投递；`diff.provider` 默认 `"none"`，`cases/patch.ts` 只可能看到 `patch: null`。两个 case 文件各有主人，它们需要的配置却在冻结文件里。按建议的第一支加宽，三个成员一次到位：`HarnessOptions.config?: (base: DaemonConfig) => DaemonConfig`（在 `config()` **内部**应用，因此 `restart()` 会复现而不是悄悄回退）、`CompatHarness.reconfigure(overlay \| null)`（换 overlay 并在**同一个 `dataDir`** 上重启——运行期这条路是必须的：receiver 的 origin 要等它绑到临时端口才知道）、`CompatContext.withDaemonConfig`（per-case 句柄，转发给 `reconfigure`，注明它会重启所以要在 `ctx.worker()` **之前**调）。`runner.ts` 把可选的 `HarnessOptions` 从 `runCompatSuite` 透到每个 agent 的 harness。**`denyCidrs: []` 放在 webhook case 自己的 overlay 里，不放进 base config**：base 若默认关掉 CIDR 门，compat 矩阵就成了 §24.6 那条 SSRF 控制唯一不被执行的地方——理由写在 `HarnessOptions.config` 与 `withDaemonConfig` 的注释里。记入 M2-PLAN §1.1（“Land owner 批准的加宽”，附三成员表）、§1.6 第 17 行与 §4 Step 4。 |
| **3** | **applied** | `docs/CONTRACTS.md` §5.8.4 里 `ConfigOptionView` 的文档块换成 `protocol/src/worker.ts:93-97` 的措辞：条目自己的键是 `id`，**请求**参数才是 `configId`；只有请求那个词是 quirk（`Quirks.configIdField`，§17.3）；条目键在两个 agent 上都是 `id`，claude `15` 与 codex `07` 量过（review R3），所以 `viewConfigOptions` 读 `id`，没有第二个 quirk 要同步。这条重要是因为 CONTRACTS 压过源码注释：按旧文本实现 `viewConfigOptions` 的 WP-C 会用 `quirks.configIdField` 去读条目键，两个 agent 上都拿到 `configId`。 |
| **4** | **applied** | R2 的“唯一调用点”在三处文档注释里还是旧的。`packages/protocol/src/control-plane.ts` 的 `PromptRequestBody` 块、它在 `docs/CONTRACTS.md` §5.8.6 的副本、以及 `packages/protocol/test/config.test.ts` 的注释，全部改写成 H28 现行文本：门进 **`Worker.prompt()`**，是注入的 `deps.validateContent` → `@omni-acp/core` 的 `assertPromptContent`，daemon 的 worker 创建路径**必须**把它绑到 token 的 `cwdRoots` 与 worker 的 `promptCapabilities`；没有注入时兜底是**故意不同名**的 `assertTextOnlyContent`；`assert-prompt-content-is-called` 是**结构性**的——断言注入，不是断言名字。`PromptRequestBody` 的自带注释是 H28 的自然入口，指错函数、指错包的代价最大。 |
| **5** | **applied** | R9(b) 只修了 daemon 那半行。`docs/M2-PLAN.md` §2 WP-J owns 块里 `packages/client/test/** MINUS {lease,interactions,config,runs}.test.ts` 删掉 `lease`，与 §3 的 `packages/client/test/**`（减去上面各行）一致——`client/test/lease.test.ts` 确实存在且上面没有任何行认领它。 |
| **6** | **applied** | §3 自称“no path appears twice”且是各 WP 动手前查的表，却漏了 Land 自己写/改的四个文件。§3 的 Land 行扩成 `tests/compat/src/cases/{support,index,m1}.ts` 并加上 `packages/testkit/test/{stub-daemon,seq-ids}.test.ts`；§1.1 的冻结清单同步补上 `cases/m1.ts` 与那两个 testkit 测试，两节现在逐条对得上。 |
| **7** | **amended（选“改措辞、守卫保持绝对”）** | M2-R16 把 guard 定义成“`core/src/policy/**` 只要含 `optionId` 字符串就红”，而 Land 自己在 `engine.ts` 的文件头里写了两次（第 8 行与第 12 行），还写了一次 `allow_always`——WP-P 写 guard 那天要么看到红，要么悄悄把“绝对”削成“忽略注释”，后者才是真正的损失。**在裁决里定案**而不是留给 WP-P：字面读法保留，**不做注释剥离**（一个跳过注释的 guard 会让下一位作者把选项规则写成散文再照着实现，而真需要那五个词的注释本来就该待在 `permission-responder.ts`），改的是 `engine.ts` 的措辞——“never WHICH option id”、“a persisted \"always\" grant”，并在文件头写明这就是它不拼那五个词的原因。CONTRACTS §11.8 的 M2-R16 单元格与 §27.4 的 guard 行都记下了这个选择，WP-P 从一个已经是绿的目录开始。 |
| **8** | **applied（Land 补写 stub）** | `selectOption` 是 §5.8.9 里 Land 唯一漏产的符号（其余 44 个都有声明+导出+`exports-are-stable` 行）。按 sibling 的做法补齐三处：`packages/core/src/worker/permission-responder.ts` 声明 `selectOption(action, offered, cfg): OptionChoice`，body 抛 `new OmniError("internal", "unimplemented: M2-B-WP-P (option selection)")`；`packages/core/src/index.ts` 在 `createBaselineResponder` 旁边一并导出；`tests/integration/src/exports-are-stable.itest.ts` 加一行。`createBaselineResponder` 的 body **一个字没动**，M1 套件照旧绿。文档注释写明 `cfg.allowSessionGrants` 是 D4 规则 2 排序的旋钮而规则 3 **不是**旋钮，`optionId === null` 是规则 4 而不是 cancel（规则 5），以及“声明归 Land 是因为 `core/src/index.ts` 对所有 WP 冻结”。记入 M2-PLAN §1.6 第 18 行。 |
| **9** | **applied** | `packages/daemon/src/create-daemon.ts` 的 `unimplementedRuns()` 里 `list: () => []` 改成 `list: no,`——`registerRunRoutes` 无条件注册 `GET /v1/runs`，空数组会让今天的 build 回 `200 {"runs":[]}`，客户端分不清“这个 daemon 没有 run 支持”和“你没有 run”，正是它自己的注释禁止的谎。`recover: () => ({ abandoned: 0 })` 保留并在注释里说明理由（启动路径，必须 total，“没有被遗弃的 run”对一个从没有过 run 的 daemon 为真）。`unimplementedDeliveries().list` 保持 total 是**可辩护的**：`registerWebhookRoutes` 的路由自己就先抛 `unimplemented`，那个空列表从 HTTP 到不了。M2-PLAN §1.6 第 13 行改写。 |
| **10** | **applied（删分支）** | `packages/daemon/src/auth.ts` 的 `assertPolicy` 删掉 `sel === undefined && entry.policyCeiling === null` 那个抛出逐字节相同错误的死分支，只留一条无条件 throw，并补注释说明**为什么这里没有** `assertEnv`/`assertMcp` 那种“问了个空问题”的豁免：空的 `env` map 或空的 preset 名单确实解析成空，但缺省的 policy selection 仍然要解析成一个**引擎**（daemon 之后每次权限请求都要问它），而那正是 M2-B-WP-P 还没写的东西。M2-PLAN §1.6 第 14 行的“`assertPolicy` always throws”现在字面为真。 |

**范围**：与上一轮相同——只补 seam 与文档一致性。本轮新增的唯一代码符号 `selectOption` 是签名齐备、
body 抛 `unimplemented` 的 stub，归属 M2-B-WP-P 不变；compat harness 的三个新成员是 Land 面的加宽，
没有任何 case 使用它们（`cases/{webhook-run,patch}.ts` 仍返回 `[]`）。
