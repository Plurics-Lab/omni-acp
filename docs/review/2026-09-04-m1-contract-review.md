# M1 契约 + Land 评审（2026-09-04）

来源：workflow `m1-contracts`（wf_17eabba1-05d）的两个对抗审查 agent 与 Land agent 的备注。**每一条都要处理**：改文档/桩，或写明不改的理由。

## 审查结论：pass-with-issues（10 条）

### R1 [major] `docs/M1-PLAN.md`

File-disjointness is violated for packages/daemon/src/types.ts. §1.1 lists it as "Permanently Land-owned — frozen for the whole of M1 (nobody else ever edits these)", while §2's M1-WP-E block and §3's ownership row both claim `packages/daemon/src/**` minus only `index.ts` and `http/routes/{index,workers,lease}.ts` — which includes `types.ts`. §3's table is headed "no path appears twice", and this is precisely the class of collision the Land step exists to prevent. WP-E's own acceptance bullets (5, 7, 9: the PersistenceHandle/SessionStrategy wiring, lazy rehydration, the new /v1/info fields) will need the daemon-internal types that live there.

**建议修法**：Extend WP-E's exclusion in both §2 and §3 to `packages/daemon/src/** MINUS index.ts, types.ts and http/routes/{index,workers,lease}.ts`; or, if WP-E genuinely needs to grow `types.ts`, drop it from §1.1's frozen list and transfer it to WP-E the same way `registry.ts` / `create-daemon.ts` / `catalog.ts` are transferred.

### R2 [major] `packages/protocol/src/runtime.ts`

The Runtime descriptor cannot express DESIGN §6.2's vendor-extension rule for `session/set_options`. `MethodPreferences` is four fixed arrays (`resume`, `setConfig`, `list`, `close`) with no `setOptions` slot, and `RuntimeDescriptor` has no `onFailure` field anywhere — yet CONTRACTS §17.3 states as binding that "`onFailure` is per capability: `set_model` failing is `fail`, `set_options` failing is `warn` (DESIGN §6.2)". CONTRACTS §12.3's method table likewise has rows for `session/set_mode` (25) and `session/set_model` (26) but no row for `session/set_options`, which the corpus did observe (transcript 08, answered -32601). Because `runtime.ts` and `config.ts` are Land-frozen for all of M1, WP-E cannot add either field without renegotiating the contract mid-flight — the exact cost §1 says the Land step exists to avoid.

**建议修法**：Before any work package starts, change `MethodPreferences` from four fixed arrays to `Readonly<Record<string, { readonly spellings: readonly string[]; readonly onFailure: "fail" | "warn" }>>` (keys `resume` / `setConfig` / `setOptions` / `list` / `close`), mirror the shape in `RuntimeOverlay.prefer` in `packages/protocol/src/config.ts`, add `setOptions: { spellings: ["session/set_options"], onFailure: "warn" }` and `setConfig: {…, onFailure: "fail"}` to `DEFAULT_V1_PROFILE`/the claude-acp builtin, and add a §12.3 row for `session/set_options` naming the warn-on-failure rule.

### R3 [major] `tests/compat/src/config.ts`

Two of CONTRACTS §18.3's three skip sources are unimplementable as landed. `CompatAgentConfig` has only `{id, source, fixture, command, args, env, budgets, unverified, expect}` — no `enabled`, no `requires`, no `windows`, no `skip`. But §18.2 defines selection as "`OMNI_COMPAT_CONFIG` ⊕ `OMNI_COMPAT_AGENTS` filter ⊕ each entry's `enabled`" and shows `requires: {login: "claude-code"}` and `skip: [{case, reason}]` entries; §18.3 makes `config` (an explicit YAML `skip`) and `precondition` (`requires.login`/`requires.env`) two of the three legal sources, and "a skip with no source is a failure". As landed, a machine without a Claude login produces a hard failure rather than the mandated `precondition` skip, and WP-F's acceptance bullet 3 cannot be met for those two sources. §18.2's `windows: {command: "${execPath}", …}` override is also absent, so the one real entry (`command: npx`) can only fail on Windows per §6.3's .cmd-shim refusal. `agents.ci.yaml` and `agents.local.yaml` are Land-frozen (§1.1, §3), so WP-F cannot repair the data even after widening the interface.

**建议修法**：Add `enabled?: boolean`, `requires?: { login?: string; env?: string[] }`, `windows?: { command: string; args: string[] }` and `skip?: readonly { case: string; reason: string }[]` (reason min length 10) to `CompatAgentConfig`, populate them in both YAMLs per §18.2's example, and move `tests/compat/agents.{ci,local}.yaml` out of §1.1's frozen list into WP-F's ownership — WP-F is the only package that reads them, so freezing them buys no disjointness.

### R4 [minor] `docs/CONTRACTS.md`

`session/notification` as an inbound alias for `session/update` has no home in the descriptor. DESIGN §1.3 names it as one of the non-standard methods multica must support ("作为 session/update 别名") and §6.2 requires such vendor extensions to be registered in the Runtime descriptor and handled by the Normalizer. §12.3 has no row for it, and `RuntimeDescriptor` has no inbound method-alias field — `updates` is keyed on the `sessionUpdate` kind, not on the JSON-RPC method. Combined with §7.6's still-binding "unknown agent→client requests answer -32601", an agent that uses that spelling would have every one of its updates silently dropped. §18.2 lists `session/notification` under `unsupportedMethods`, but that is the outbound probe direction, which is a different fact. No agent reachable on this machine needs it, so this is a forward-compat gap rather than a live bug — but the type is Land-frozen.

**建议修法**：Add `readonly inboundAliases: Readonly<Record<string, string>>` to `RuntimeDescriptor` (default `{}`; claude-acp `{}`), mirror it in `RuntimeOverlay`, and add a §12.3 row: an agent→client notification whose method matches a registered alias is normalized to `session/update` before mapping; unregistered methods keep §7.6's -32601 behaviour.

### R5 [minor] `docs/CONTRACTS.md`

§15.4 rule 1 classifies rate limit / quota / 429 / auth / expired / 5xx / ECONN* as `rejected_transient`, but DESIGN D2 says of exactly that class "网络 / 限流 / 配额 / 5xx / auth 错误永不算 rejected". The document's own companion property test is stated more narrowly — "no network / timeout / auth / quota / 5xx error ever yields `rejected_permanent`" — so the intended reading of D2 is clearly "never *permanent*", and the pointer is kept either way. But that reinterpretation is never recorded, and it sits awkwardly beside ruling M1-R6, which rejects `rejected_transient` for the cwd mismatch on the grounds that "`transient` asserts a cause we have not verified" while `unknown` is the honest label.

**建议修法**：Add one sentence to §15.4 (or a row to §11.5) recording the reading: D2's "永不算 rejected" is read as "never `rejected_permanent`", because D2's own table defines `rejected_transient` as "现在不行但 session 健康" with the pointer kept — which is exactly a rate limit. Alternatively, for consistency with M1-R6, classify rule 1 as `unknown` with `hint: "rate_limited"`, since the action (keep the pointer, fail the prompt) is identical.

### R6 [minor] `docs/CONTRACTS.md`

§15.5's row "wake fails the CURRENT ACL ⇒ `closed(client_request)` ⇒ 403 forbidden" reuses the close reason `client_request`, which means "an operator issued DELETE". An ACL revoked between daemon runs (§15.3 step 2) is a different event, and conflating them makes the audit log lie about who closed the worker. `WORKER_STATE_REASONS` in `packages/protocol/src/events.ts` (Land-frozen) has no suitable value, and §15.1's state table has no row for this transition at all.

**建议修法**：Add `acl_revoked` to `WORKER_STATE_REASONS` in `packages/protocol/src/events.ts` now, while the file is still being landed, add the matching row to §15.1 (`hibernated`/`starting` → `closed`, trigger "wake fails the current ACL", reason `acl_revoked`, pointer dropped), and change §15.5's row to name it.

### R7 [minor] `docs/M1-PLAN.md`

Two exit criteria assert something the Land step already had to violate. §1.3 item 6 says "`pnpm-lock.yaml` is unchanged, and the `static` CI job's `git diff --exit-code pnpm-lock.yaml` proves it", and §5 item 6 repeats "`pnpm-lock.yaml` is **unchanged from M0**". The landed Land commit changes it, and must: `tests/compat` is a new pnpm workspace package, so the lockfile gains an importer entry. (The CI check itself is fine — it runs after `pnpm install --frozen-lockfile` against a committed lockfile — but a reviewer auditing the Land step against the literal criterion would reject a correct commit.)

**建议修法**：Reword both criteria to the property actually intended and actually checked: "no new external dependency — the only `pnpm-lock.yaml` delta is the new `tests/compat` workspace importer, and `pnpm install --frozen-lockfile` followed by `git diff --exit-code pnpm-lock.yaml` is clean."

### R8 [minor] `docs/M1-PLAN.md`

Four different enumerations of claude-acp's corpus gaps exist and none is designated the source of truth: CONTRACTS §17.2's builtin descriptor lists seven (`plan, agent_thought_chunk, current_mode_update, mcp, image_content, authenticate, tool_failure_on_merits`); CONTRACTS §18.2's example YAML `skip:` lists four (`plan-update, agent-thought, current-mode-update, git-patch`); M1-PLAN §5 item 4 names a fifth combination ("`plan`, `agent_thought_chunk`, `current_mode_update`, a tool that fails on its own merits") and makes it a definition-of-done assertion; and the landed `tests/compat/agents.local.yaml` declares only two (`authenticate, plan`). DoD item 4 therefore cannot pass against the file that is supposed to satisfy it.

**建议修法**：Make the descriptor's `unverified` list (§17.2) the single source, have §18.3's `capability` skip source derive from it, replace M1-PLAN §5 item 4's inline list with a reference to §17.2, and update `tests/compat/agents.local.yaml` so its `unverified` matches the descriptor rather than being a smaller hand-written subset.

### R9 [minor] `docs/CONTRACTS.md`

§14.6 calls the drop escape hatch "`dropUpdateKinds` in the descriptor overlay, empty by default", but no such field exists in `RuntimeDescriptor`, `RuntimeOverlay` or the landed `packages/protocol/src/{runtime,config}.ts`. The mechanism that actually ships is `UpdateRule.stream/store` both false, which the same paragraph describes two lines earlier. A reader implementing §14.6 will look for a field that is not there.

**建议修法**：Delete the `dropUpdateKinds` parenthetical in §14.6 and name the real mechanism: "the operator's escape hatch is an `updates.<kind>` overlay entry with `stream:false, store:false`; no kind carries one by default."

### R10 [minor] `docs/CONTRACTS.md`

DESIGN §3.2's worker lifecycle table gives the `hibernated → starting` trigger as "`prompt` / `attach`"; CONTRACTS §15.1 lists only "`prompt` / `POST …/wake`". Dropping `attach` is almost certainly the right call — §16.1 rule L2 makes attach and SSE ungated observer operations, and forcing a ~7 s npx cold start on a passive observer would contradict D5 — but the deviation from a binding DESIGN table is silent, and §11.5 has no ruling for it, so a reader comparing the two tables cannot tell an intentional correction from an omission.

**建议修法**：Add a row to §11.5: "`attach` never wakes a hibernated worker — observer mode (D5, §16.1 L2) must not pay a cold start, and `POST …/wake` is the explicit lever for an operator who wants to. DESIGN §3.2's `attach` trigger is superseded." Reference it from §15.1's `hibernated → starting` row.

## 审查结论：pass-with-issues（10 条）

### R11 [blocker] `docs/M1-PLAN.md`

M1 acceptance script §4 Step 2 is self-contradictory and cannot pass. It picks a prompt that 'forces ... at least one permission request' and then asserts `changes` mentions `report.txt`. M1 has exactly one wired permission responder and it is auto-DENY: create-daemon.ts:81 hard-defaults `createBaselineResponder("deny", clock)`, `CreateWorkerRequest.onUnresolved` (control-plane.ts:20) accepts only the literal "deny", and CONTRACTS §2.3 defers the policy engine and `onUnresolved: park|fail` to M2. Corpus 04 records the exact outcome: the write is refused, the workspace stays empty, the tool call ends `status:"failed"` with `rawOutput:"User refused permission to run tool"`, and the turn still returns `end_turn`. So `changes` is empty and the 'read it back' half has no file to read. The suite cannot work around it either: tests/compat/package.json depends only on {client, daemon, protocol, testkit}, so it cannot import `createBaselineResponder` from @omni-acp/core to inject an allow responder through `DaemonDeps.responder`.

**建议修法**：Rewrite Step 2's assertions to the denial-visible shape CONTRACTS §18.4's `permission-deny` case already specifies — `verdict === "partial"`, `deniedToolCalls` non-empty, `changes` empty, `stopReason === "end_turn"` — and move the 'changes matches the workspace' assertion onto a read-only tool prompt (corpus 02 shows reads are auto-allowed, so a read turn needs no permission). If an allowed write is genuinely wanted for M1, add `@omni-acp/core` to tests/compat/package.json and have §4's setup pass `deps.responder = createBaselineResponder("allow", clock)` explicitly, labelled as a test-only seam.

### R12 [blocker] `docs/M1-PLAN.md`

The 'byte-identical' reconnect assertion is unachievable against the checksum-frozen sse.ts. It appears in §4 Step 2, §2 WP-F acceptance 5, CONTRACTS §2.3's acceptance paragraph and §18.4's `stream-resume` case. packages/daemon/src/http/sse.ts writes `retry: 2000\n\n` at the head of EVERY stream, so client A's second segment carries a preamble B's uninterrupted stream does not have at that offset; it writes `: hb\n\n` comment heartbeats on a `sseHeartbeatMs` interval (default 15_000) whose phase differs between two connections opened seconds apart, and a claude-acp step easily exceeds 15 s; and a reconnect whose `since < log.tail - 1` — the normal case mid-turn — prepends an out-of-band `omni.stream_truncated` control frame. Concatenating A's two raw byte segments therefore can never equal B's raw bytes. sse.ts is frozen by the `sse-is-unchanged` guard (packages/daemon/test/arch/sse-is-unchanged.test.ts), so this cannot be fixed on the implementation side.

**建议修法**：State the comparison over envelope frames only — the `id:`/`event:`/`data:` triples, with `: hb` comments and the `retry:`/`omni.stream_truncated`/`_overflow`/`_end` control frames excluded — which is exactly the idiom M0 already uses ('sequence identical to a reference full replay', packages/client/test/sse-resume.test.ts:18). Assert the control frames separately (segment 2 starts with `retry:` and may carry one `stream_truncated`). Apply the same edit to CONTRACTS §2.3 and §18.4 so the two documents do not disagree.

### R13 [blocker] `packages/core/src/worker/worker.ts`

Seam 2 does not hold, so WP-C cannot deliver without editing a Land-frozen file. §1.2 promises 'the Land step writes the delegation and the state widening ... then freezes worker.ts', and §3's ownership map gives WP-C `packages/core/src/worker/**` MINUS worker.ts. But the Land step wrote throwing stubs, not delegation: worker.ts:487 (`hibernate`) and worker.ts:498 (inside `wake`'s `#withReplayWindow`) both `throw new OmniError("internal", "unimplemented: M1-WP-C")`. CONTRACTS §15.2 and §15.3 place the whole hibernate ordering (synchronous `#hibernating` flag before the first await, stdin EOF plus the graceful ladder, lease release, envelope-then-persist) and the whole wake ladder (slot reservation, ACL recheck, supervisor.spawn, initialize, spelling choice, replay window, classify, single-flight, maxWakeFailures) inside the Worker, over private fields — `#state`, `#proc`, `#link`, `#sessionId`, `#generation`, `#deps.supervisor` — that no other file can reach. The handed-over helpers cannot absorb it: worker/hibernate.ts exports only `createHibernateTimer`, and worker/wake.ts's `performWake(strategy, who, o: SessionReopenOptions)` takes no `AcpLinkLike`, so it cannot even call `strategy.reopen(link, o)`. Note seams 1 and 3-on-worker.ts DO hold and need no change: `#perform(out.action)` is fully written at worker.ts:570 and `lease.assertHolder(who)` is already the first statement of `prompt` (:342) and `cancel` (:437).

**建议修法**：Pick one and record it in §3: either finish the Land edit now by writing the two delegating bodies (hibernate's ordered transition; wake calling `this.#deps.session.reopen(link, {...controls})` inside the existing replay window) so worker.ts is genuinely frozen, or transfer worker.ts to WP-C for the milestone the way protocol/src/turn.ts is transferred to WP-B and remove the MINUS clause. Either way give `performWake` a `link: AcpLinkLike` first parameter so its signature can actually reach `SessionStrategy.reopen`.

### R14 [major] `packages/daemon/src/registry.ts`

Seam 3's registry half does not hold, so WP-D and WP-E will collide on registry.ts. §1.2 says 'D5 enforcement is ... a change to the factory registry.ts passes in' and §2 says 'the registry's lease() façade row is Land-written and calls the injected factory'. There is no injected factory: registry.ts:216 calls `alwaysGrantedLease(auth.asClientRef())` literally inside `createWorker`, and `WorkerRegistryOptions` (registry.ts:34) has no lease field. Separately, WP-D acceptance 2 requires `423` on `DELETE`, but `registry.delete()` (registry.ts:278) never calls `assertHolder` and `WorkerHandle.close(reason)` takes no `ClientRef`, so that enforcement point has no home outside registry.ts either. WP-E meanwhile rewrites the same file extensively (persistence, boot adoption, lazy rehydration, hibernated counter, `list()` from the store), which puts both work packages in the same hunks.

**建议修法**：In the Land step, add `readonly leaseFactory?: (owner: ClientRef) => Lease` to `WorkerRegistryOptions` and to `DaemonDeps`, have registry.ts:216 call `o.leaseFactory?.(auth.asClientRef()) ?? alwaysGrantedLease(auth.asClientRef())`, and move an `assertHolder` call into `registry.delete()` guarded by the same factory. WP-D then only implements `createLease` in its own files and WP-E flips the default in create-daemon.ts — no shared hunk.

### R15 [major] `tests/compat/src/config.ts`

The landed compat schema cannot express three keys CONTRACTS §18.2 specifies, which breaks two of the plan's own guarantees. (a) `requires` is absent from `CompatAgentConfig` (config.ts:13-24) and from agents.local.yaml, yet §18.3 defines the `precondition` skip source as '`requires.login` / `requires.env` unsatisfied on this machine'. On a machine without a logged-in Claude Code the real-agent run will hard-fail rather than emit a sourced skip — the opposite of WP-F acceptance 3 and of the brief's 'honestly reports skips'. (b) §18.2's `skip: [{case, reason}]` list is absent, so the `config` skip source has no input; only `unverified` survives and §18.3 maps that to the `capability` source. agents.local.yaml lists two `unverified` entries (`authenticate`, `plan`) where §17.2 names seven and §18.2 names four skip cases, so DoD #4's 'four corpus gaps appear as config/capability skips' cannot be met as configured. (c) §18.2's `windows: {command, args}` override is absent, so the one real entry (`command: npx`) is unrunnable on Windows under CONTRACTS §6.3's `.cmd` shim refusal, and there is nowhere in the schema to put the fix — which breaks 'adding an agent is a YAML edit only' for every npx-launched agent, the exact promise the suite exists to keep. tests/compat/agents.*.yaml are Land-frozen per §3, so WP-F cannot repair this on its own.

**建议修法**：Extend `CompatAgentConfig` with `enabled?: boolean`, `requires?: { login?: string; env?: readonly string[] }`, `windows?: { command: string; args: readonly string[] }` and `skip?: readonly { case: string; reason: string }[]` (reason min length 10, per §18.3), add a `defaults` block to `CompatConfig`, and in the same Land amendment fill agents.local.yaml's claude-acp entry with `requires: { login: "claude-code" }`, the `windows:` spelling from §18.2, §18.2's four `skip` entries, and §17.2's seven `unverified` rows.

### R16 [minor] `docs/M1-PLAN.md`

§4 Step 3's wake-recall assertion targets a worker with no history. The step creates a SECOND worker with `idleTimeoutMs: 200`, waits for `hibernated` without ever prompting it, then wakes it with `A.prompt("What did I just ask you to create?")` and asserts 'The answer references report.txt — proof the agent's context, not just our log, survived.' That worker's session was opened by `session/new` and never prompted, so there is nothing in its transcript to recall; corpus 07 confirms replay carries only conversational content that this session never had. The `resume.outcome === "landed"` half is fine (corpus finding 10: matching cwd returns the session/new shape), only the content assertion is impossible.

**建议修法**：Send one small prompt to the second worker before waiting for hibernation (e.g. 'Remember the token OMNI-M1 and reply OK.'), then assert the woken answer echoes that token; or drop the second worker and lower Step 2's worker's idle timeout instead, so the recall assertion runs against the session that actually created report.txt.

### R17 [minor] `docs/M1-PLAN.md`

§4 Step 3's 'Assert the negative' — a third worker resumed against a foreign cwd classifying `unknown` with `hint: "cwd_mismatch"` — is not reachable through the public surface. A worker's cwd is fixed at creation and stored in its row; there is no API to resume an existing session pointer under a different cwd (`WakeRequestBody` carries only `timeoutMs`), so the suite would have to tamper with the sqlite row, and tests/compat depends on neither @omni-acp/core nor a sqlite handle. CONTRACTS §15.4 asks for this case ('a compat-suite case, resume-cwd-mismatch, that re-observes it live') without saying how it is driven.

**建议修法**：Split it in two, as §15.4's own first bullet already implies: keep the unit regression lock on the pure `classifyResume` with the README's recorded `-32002` shape (asserting `unknown`, pointer kept, and that `PERMANENT_TEXT` does not match 'Resource not found'), and drive the live re-observation at the probe layer — a second process that sends the descriptor's resume spelling with a deliberately foreign cwd, which is exactly what the corpus recorder did for transcripts 07/08 — rather than through `Worker.wake()`.

### R18 [minor] `packages/daemon/src/registry.ts`

Stub work-package tags contradict §3's ownership map on registry.ts. The file carries `unimplemented: M1-WP-D` on `lease()` (line 374) and `unimplemented: M1-WP-C` on `hibernate()`/`wake()` (lines 378, 382), while §3 assigns the whole of packages/daemon/src/** (minus index.ts and routes/{index,workers,lease}.ts) to WP-E, and the file's own comment at line 364 correctly says 'Owned by M1-WP-E'. Anyone assigned WP-C or WP-D who greps for their tag — the natural way to find their work given the plan's scaffold discipline — will open a file they must not edit.

**建议修法**：Retag those three bodies `unimplemented: M1-WP-E`, keeping the existing prose note about which feature each serves, so the tag and the owner agree.

### R19 [minor] `docs/M1-PLAN.md`

WP-F acceptance 2's guard — 'no .ts file in the repository contains a real agent's command string' — will collide with WP-E's mandated builtin. CONTRACTS §17.2 requires BUILTIN_RUNTIMES to ship exactly one non-default entry for claude-acp, and `BuiltinRuntime.matches` is documented as 'config agents[].id values this profile claims, plus a command-basename match' with the §17.2 matcher spelled `agentInfo.name /^claude-(code|agent)-acp$/`. So packages/core/src/runtime/known.ts will legitimately contain the substring `claude-agent-acp`. A guard grepping for that substring reddens work WP-E is required to do. (Verified clean today: no .ts file outside dist contains `claude-agent-acp`; known.ts's BUILTIN_RUNTIMES is still `[]`.)

**建议修法**：Scope the guard to the launch spelling rather than the agent's name: assert that no .ts file contains the argv triple from agents.local.yaml (`npx`, `-y`, `@…/claude-agent-acp@0.73.0` as one joined command line), and explicitly exempt a name/version matcher in packages/core/src/runtime/known.ts.

### R20 [minor] `docs/M1-PLAN.md`

Two DoD statements are literally false as landed, though nothing is broken. §1.3 exit criterion 6 and §5 DoD 6 say 'pnpm-lock.yaml is unchanged from M0'; it did change (53363 -> 53872 bytes), because tests/compat is a new workspace package and pnpm records an importer row for it. No external package was added — the diff is only the `tests/compat:` importer block, and `yaml@2.9.0` was already resolved for @omni-acp/cli — so the intent holds and CI's `git diff --exit-code pnpm-lock.yaml` (which checks post-install drift, not drift since M0) passes today. Separately, §2 WP-F acceptance 1 and §4's note both say agents.ci.yaml is 'the SDK example agent + the ten testkit fixtures'; the landed file lists eight (crash and orphan are excluded, correctly — neither completes a turn).

**建议修法**：Reword to 'pnpm-lock.yaml gains no new external package; the only diff from M0 is the tests/compat importer row, and CI's `git diff --exit-code pnpm-lock.yaml` proves no work package rewrites it', and change 'ten fixtures' to 'the eight turn-completing fixtures (crash and orphan are excluded)'.

## Land agent 的备注（有意偏离与占位决定，文档需与代码一致）

S1. AMBIGUITY: M1-PLAN §1.3 exit criterion 6 says `pnpm-lock.yaml` is unchanged, but criterion 5 requires a new `tests/compat` PRIVATE workspace package. Those cannot both hold — a new workspace member always adds an `importers:` entry. Resolved as: no new EXTERNAL dependency and no version bump (the lockfile diff is exactly one importer block, all `workspace:*` links plus `yaml@2.9.0`, which the tree already carried for `@omni-acp/cli`). The `static` CI job's `git diff --exit-code pnpm-lock.yaml` will need its baseline refreshed once, or it will fail on this commit.

S2. DEVIATION (documented, superset): `createNormalizer`'s M1 options — `drainGraceMs`, `cancelGraceMs`, `descriptor`, `ids` — are OPTIONAL, defaulting `descriptor` to `DEFAULT_V1_PROFILE`. CONTRACTS §5.7 types them required, which would break every M0 call site (registry.ts and three core test files) at the Land step. A caller written against the document still compiles; WP-B tightens the defaults away. Same pattern as M0's existing `CreateWorkerDeps.toSpawnSpec?`.

S3. DEVIATION: `CreateWorkerDeps.session?: SessionStrategy` is OPTIONAL and `worker.ts` still runs M0's inline `runHandshake` when it is absent. M1-PLAN §1.2 says the Land step writes the seam-2 delegation, but `createSessionStrategy` is a throwing stub — a required dependency would have taken all 978 M0 tests with it. The injection point is landed; WP-C fills it without editing the frozen file.

S4. BEHAVIOUR I DID IMPLEMENT (one row, and why): `normalizer/map/permission.ts`'s `mapPermissionRequest` is real, not a throwing stub, and `Normalizer.mapPermissionRequest` is wired to it. Ruling M1-R14 routes every permission request through the v2 map BEFORE the responder sees it, and F1's SDK example agent asks mid-turn and waits forever — a throwing stub there would HANG the acceptance fixture, not fail it. What landed is the v1 lift plus identity-on-already-v2; WP-B owns the descriptor's `permissionRequestShape` quirk, the golden cases and the idempotency property test. `/home/qiufuyu/Plurics-Lab/omni-acp/packages/core/src/normalizer/map/permission.ts`

S5. BEHAVIOUR I DID IMPLEMENT (values, not logic): `runtime/known.ts`'s `DEFAULT_V1_PROFILE` and `testkit/src/fake-runtime.ts`'s `fakeRuntime()` are real zero-quirk descriptors. `Catalog.descriptor()` is documented as NEVER throwing (falls back to the v1 profile), so a throwing constant would make the fallback path the one that cannot run — and nothing else in the repo would typecheck without an inhabited `RuntimeDescriptor`. `fakeRuntime` restates the table rather than importing core's, because `testkit -> core` would close the §3.1 DAG. `BUILTIN_RUNTIMES` is `[]`; WP-E lands the claude-acp entry.

S6. HONEST-PLACEHOLDER decisions, each commented in place: (a) `WorkerSnapshot.runtimeId` is `"<agentId>@unresolved"` — `DEFAULT_V1_PROFILE.fingerprint` is the literal sentinel `"unresolved"` rather than 12 invented hex digits, because `runtimeId` is a claim about which quirk table governed the worker; (b) `ProcessInfo.fingerprint` is `null` at spawn (WP-C captures it), and a null fingerprint is exactly the value that FORBIDS signalling the pid after a restart; (c) `AgentCapabilitiesSnapshot.resume.method` is `null` — "no spelling has been RESOLVED", which under the default `whenNotResumable:"keep"` means refuse-to-hibernate, the safe reading; (d) `DaemonInfo.persistence` reports the memory driver's real state, `bootId` is per-process.

S7. `PlatformOps.fingerprint` on win32 returns `null` as FINAL behaviour, not a stub — §15.7 fixes it, and WP-C acceptance 7 asserts it. The POSIX one throws `unimplemented: M1-WP-C`.

S8. `registerLeaseRoutes` and the probe half of `registerAgentRoutes` register NOTHING (documented empty bodies) rather than throwing: they are called by `createHttpApp()` on every daemon this repo builds, and a throwing route would answer 500 where the honest answer for an unimplemented route is today's `400 unknown route` (§9, D29). `GET /v1/agents` moved into `routes/agents.ts` unchanged so WP-E can add H16 beside it without touching a frozen file.

S9. `routes/workers.ts` imports `workerId` / `sinceOf` / `readJson` from `routes/index.ts`, which imports `workers.ts` — a module cycle in the graph sense only (every binding is a hoisted function declaration and registration happens inside a call). A fifth `params.ts` would have fallen under WP-E's ownership per the M1-PLAN §3 map, so the helpers stayed in the Land-owned index.

S10. M0 TESTS ADAPTED (all minimal, each with a comment saying why): `core/test/lease/always-granted.test.ts` (`acquire({steal:true})` no longer exists — `steal` is its own method; message now names M1-WP-D); `core/test/worker/permission-responder.test.ts` (its `request()` helper now builds a `MappedPermissionRequest`, per R14 — every asserted rule is unchanged); `core/test/worker/{handshake,cancel-and-close}.test.ts` (new `AgentCapabilitiesSnapshot` / `CloseResult.sessionClosed` fields); `core/test/normalizer/turn-lifecycle.test.ts` (`slice` is `"m1-full"`); `protocol/test/{config,events-schema,turn-golden}.test.ts` + all 12 `transcripts/*.expected.json` (new config defaults, the `omni.lease` fixture, `toolCallId`, and TurnResult's `vendorPatch`/`verdict`/`warnings`/`failedToolCalls`/`deniedToolCalls` + FileChange's `operation`/`fragment`); `daemon/test/{catalog,http/agents}.test.ts` (`runtimeId`); `client/test/support/wire-daemon.ts` (`toolCallId`); the test doubles in `core/test/worker/support/{harness,lifecycle-normalizer}.ts` and `testkit/src/{fake-supervisor,stub-daemon}.ts`.

S11. GUARD CHANGES: `no-message-id` is retired and replaced by `message-id-optional` (CONTRACTS §10.2 mandates the swap — M1's map passes `messageId` through, so the old guard would forbid the feature). The new guard allows the identifier in three files (SDK re-export, the types-only seam, `map/message-id.ts`) and carries an `it.todo` for the `?? null`-guard assertion WP-F writes once WP-B lands the reads. `http-has-no-logic` now scans `src/http/**` RECURSIVELY (a non-recursive scan would have gone silently vacuous after the routes split) with a widened import allowlist. New `daemon/test/arch/sse-is-unchanged.test.ts` pins sse.ts's sha256 (`c3cce04d…`) — the file is byte-identical to M0.

S12. `ProbeConfig.partial().prefault({})` from the contract does NOT do what its comment says: zod's `.partial()` only makes keys optional, so the inner `.default()`s still fire and `{}` would parse into the full block — an agent overlay would then silently beat the daemon-wide `probe` setting on every field the operator never wrote. Landed as an explicit undefaulted `ProbeOverrides` schema instead, spelled out with that reasoning in the source.

S13. JUDGEMENT CALL: `CLOSE_REASON_CODE` in `turn.ts` needed arms for M1's three new close reasons. `idle_timeout` and `orphaned` map to `worker_closed` (our decision to stop holding the worker); `wake_failed` maps to `agent_error` (a run of failed attempts against the agent). Worth a second opinion from WP-C.

S14. `turn.ts` was Land-written to its new signature and is TRANSFERRED to WP-B per M1-PLAN §1.1, though the task brief's file list did not name it. `TurnResult.verdict` is currently the only thing the M0 fold can honestly derive (`error === null ? "ok" : "failed"`); `warnings` / `failedToolCalls` / `deniedToolCalls` are `[]` and `vendorPatch` is `null`. §13.4's promotion rules (rate-limit `_meta`, tool status, the descriptor-gated stderr signal) are WP-B's.

---

## 处理记录（2026-09-04，commit `chore: apply M1 contract review findings; land seams 2 and 3`）

每一条 R1–R20 与 S1–S14 都在下面给出处置：**applied**（照建议改）/ **amended**（改了，但形状与建议不同，写明理由）/
**skipped**（不改，写明理由）。全仓 `pnpm -r build && pnpm test` 绿：**980 passed / 2 skipped / 74 todo**，
`pnpm lint` 与 `prettier --check` 干净。**没有实现任何 WP 行为**：所有 `unimplemented: M1-WP-x` 桩仍然抛错，
本次落地的只有 M1-PLAN §1.2 承诺由 Land 步骤书写的两个缝（seam 2 / seam 3）。

### 审查发现 R1–R20

| # | 处置 | 落在哪里 |
| - | ---- | -------- |
| R1 | **applied** | `packages/daemon/src/types.ts` 保持 Land 冻结（它是纯 re-export，和 barrel 同类）；M1-PLAN §2 的 WP‑E 归属与 §3 的表格都改成 `MINUS index.ts, types.ts and http/routes/{index,workers,lease}.ts`，§1.1 写明理由。 |
| R2 | **applied** | `MethodPreferences` 改为 `Readonly<Record<string, MethodPreference>>`（`MethodPreference = {spellings, onFailure}`），`RuntimeOverlay.prefer` 镜像同一形状（`onFailure` 默认 `fail`）；`DEFAULT_V1_PROFILE` 与 `fakeRuntime()` 补 `setOptions: {spellings:["session/set_options"], onFailure:"warn"}`；CONTRACTS §5.1 / §12.3（新增第 26b 行）/ §17.2 / §17.3 同步。 |
| R3 | **applied** | `CompatAgentConfig` 增加 `enabled` / `requires{login,env}` / `windows{command,args}` / `skip[{case,reason}]`，`CompatConfig` 增加 `defaults`；两个 YAML 都写满；两个 YAML 从 §1.1 冻结名单移到 **WP‑F** 所有（§3 表格同步）。 |
| R4 | **applied** | `RuntimeDescriptor.inboundAliases` + `RuntimeOverlay.inboundAliases`（默认 `{}`，claude-acp `{}`）；CONTRACTS §12.3 新增第 18b 行说明「先改方法名再走本表；未注册的方法保留 §7.6 的 -32601」。 |
| R5 | **amended** | 采纳第一个方案：§15.4 增加一段，明确记录 D2「永不算 rejected」的读法是「永不算 `rejected_permanent`」，理由用 D2 自己的表（`rejected_transient` = 现在不行但 session 健康、指针保留）。**没有**把 rule 1 改成 `unknown + hint:"rate_limited"`：限流是我们**观测得到**的原因，`unknown` 是「判断不出来」的标签，把已知原因降级为未知会让 `outcome` 比 `hint` 更贫乏；而 M1-R6 的 `unknown` 恰恰是因为 cwd mismatch **没有**被验证过。 |
| R6 | **applied** | 新增关闭原因 `acl_revoked`：`WorkerCloseReason` + `WORKER_STATE_REASONS` + `CLOSE_REASON_CODE`（映射到 `forbidden`，403）+ client 的 `IS_CLOSE_REASON` 穷尽表；CONTRACTS §15.1 增加一行、§15.5 那一行改名、§11.5 增加裁决 **M1-R23**。 |
| R7 | **applied** | M1-PLAN §1.3 准则 6 与 §5 DoD 6 都改成「无新增外部依赖；与 M0 的唯一 lockfile 差异是 `tests/compat` 这一个 importer 块；CI 的 `pnpm install --frozen-lockfile` + `git diff --exit-code` 是真正被检查的性质」。 |
| R8 | **applied** | CONTRACTS §17.2 明写「这份 `unverified` 是 claude-acp 语料缺口的**唯一真相源**」；§18.3 的 `capability` 源改为由它派生；M1-PLAN §5 DoD 4 改成引用 §17.2；`agents.local.yaml` 的 `unverified` 补齐为同样的七行。 |
| R9 | **applied** | §14.6 删掉 `dropUpdateKinds` 括注，改写为「escape hatch 就是 `updates.<kind>` 覆盖项写成 `stream:false, store:false`；默认没有任何 kind 带这个形状」。 |
| R10 | **applied** | §11.5 新增裁决 **M1-R22**（`attach` 永不唤醒，DESIGN §3.2 的 `attach` 触发被取代），§15.1 的 `hibernated → starting` 行引用它。 |
| R11 | **applied（amended）** | §4 Step 2 重写：拆成 **2a 只读回合**（语料 02：读自动放行 ⇒ `verdict:"ok"`、`changes` 与工作区一致=空）与 **2b 被拒的写回合**（`verdict:"partial"`、`deniedToolCalls` 非空、`changes` 为空、工作区没有 `report.txt`、`stopReason:"end_turn"`）。比「把一条断言挪走」更强：拒绝本身成为被断言的行为。允许写入的方案作为**明确标注的 test-only seam** 记在 Step 2 末尾，没有默认打开。CONTRACTS §18.4 的 `tool-turn` 行同步说明「prompt 是只读的」。 |
| R12 | **applied** | 四处统一改为「只比较 envelope 帧（`id:`/`event:`/`data:` 三元组），排除 `: hb` 与 `retry:` / `omni.stream_truncated` / `_overflow` / `_end` 控制帧，并单独断言控制帧」：CONTRACTS §2.3、§18.4 `stream-resume`、M1-PLAN §2 WP‑F 5、§4 Step 2。 |
| R13 | **applied（方案一：把 Land 编辑写完）** | `worker.ts` 落地：`hibernate()`（§15.2 的四步顺序、同步 `#hibernating`、stdin EOF + 优雅梯子、**不发 `session/close`**、`releaseForHibernate()`、先信封后持久化、不可 resume 时按 M1-R15 拒绝）、`wake()`（单飞入场、`#openProcess()`、在 replay window **内**调用注入的 `SessionStrategy.reopen`、按 §15.5 映射结果与 `maxWakeFailures`）、`start()` 在有 strategy 时改调 `strategy.open()`（无则仍走 M0 的 `runHandshake`）、`prompt()` 对 `hibernated` 自动唤醒、`#watchProcess` 加进程身份守卫（第二代进程不会被上一代的 `exited` 误判为崩溃）、`#crashed` 变粘性、`#setState` 支持 `resume`/`orphan`/`crashed`/`generation`。配套：`CreateWorkerDeps.runtime?`、`limits.wakeTimeoutMs?`、`limits.maxWakeFailures?`、`AcpLinkLike` 适配器；`performWake` 的第一个参数改成 `link: AcpLinkLike`。`worker.ts` 自此冻结。 |
| R14 | **applied** | `WorkerRegistryOptions.leaseFactory` 与 `DaemonDeps.leaseFactory`（`create-daemon.ts` 透传）；`registry.ts` 的构造点改为 `o.leaseFactory?.(owner, workerId) ?? alwaysGrantedLease(owner, workerId)`；`registry.delete()` 增加 `assertHolder`（`DELETE` 的 423 没有别的落点）；`lease()` façade 行由 Land 写成 parse → 一次调用的分发。默认 `alwaysGrantedLease` 下这些全是 M0 行为。 |
| R15 | **applied** | 与 R3 同一处修改；另加 `defaults` 块与 `budgets`，`agents.local.yaml` 补 `requires` / `windows` / `skip`(4) / `unverified`(7)。 |
| R16 | **applied** | §4 Step 3 改为：第二个 worker 先发一条 `"Remember the token OMNI-M1 and reply OK."`，再等 `hibernated`，唤醒后断言回答里有 `OMNI-M1`（并写明「没提示过的 session 无可回忆」这一理由，语料 07）。 |
| R17 | **applied** | §4 Step 3 的「negative」拆成两半：(1) 对纯函数 `classifyResume` 的单元回归锁（README 记录的 `-32002` 形状 ⇒ `unknown` + `cwd_mismatch` + 指针保留 + `PERMANENT_TEXT` 不匹配 `"Resource not found"`）；(2) 在**探针层**驱动的 compat case `resume-cwd-mismatch`（另起一个进程、用外来 cwd 发 resume 拼写），不再假装能经由 `Worker.wake()` 驱动。 |
| R18 | **applied** | `registry.ts` 的 `hibernate()` / `wake()` 桩改标 `unimplemented: M1-WP-E`（与文件注释和 §3 的归属一致）；`lease()` 不再是桩，已按 R14 写成 façade。 |
| R19 | **applied** | M1-PLAN §2 WP‑F 验收 2 改为「没有 `.ts` 文件包含 `agents.local.yaml` 的**启动 argv**（拼接后的 `npx -y @agentclientprotocol/claude-agent-acp@0.73.0`）」，并显式豁免 `packages/core/src/runtime/known.ts` 里 §17.2 要求的 name/version 匹配器。 |
| R20 | **applied** | lockfile 措辞同 R7；「十个 fixture」在三处（§2 WP‑F 1、§4 的说明框、CONTRACTS §18.2）改为「八个能跑完一个回合的 fixture，`crash` 与 `orphan` 被有意排除」，`agents.ci.yaml` 里也写下了这个理由。 |

### Land agent 备注 S1–S14

| # | 处置 | 落在哪里 |
| - | ---- | -------- |
| S1 | **applied（改文档）** | 见 R7：准则 6 改成「无新增外部依赖 + 唯一差异是 `tests/compat` importer」。 |
| S2 | **accepted（记入文档）** | CONTRACTS §5.7 的 `createNormalizer` 签名标注四个 M1 选项在 Land 阶段是可选的及其理由；M1-PLAN §1.4 第 1 条。理由成立：必需依赖 + 抛错实现会带走全部 M0 测试。 |
| S3 | **accepted，并补齐** | 可选 `session` 保留（同样理由），但**注入点现在真的被使用**：`start()` 有 strategy 时调 `strategy.open()`，无则走 M0 路径（R13）。文档：CONTRACTS §5.7 的 seam 块 + M1-PLAN §1.2 / §1.4。 |
| S4 | **accepted（记入文档）** | `mapPermissionRequest` 是真实现而非桩——M1-R14 让每个权限请求先过 v2 映射，抛错桩会让 SDK 示例 agent **挂住**而不是失败。M1-PLAN §1.4 第 2 条。 |
| S5 | **accepted（记入文档，并随 R2/R4 更新取值）** | `DEFAULT_V1_PROFILE` / `fakeRuntime()` 是真值（`Catalog.descriptor()` 文档承诺永不抛错）；两者的 `prefer` 已改成新形状并补 `inboundAliases: {}`；`BUILTIN_RUNTIMES` 仍是 `[]`。 |
| S6 | **accepted（记入文档）** | 四个诚实占位（`runtimeId` 的 `@unresolved`、spawn 时 `fingerprint: null`、`resume.method: null` ⇒ 默认拒绝 hibernate、`persistence` 报内存驱动的真实状态）写入 M1-PLAN §1.4 第 3 条。 |
| S7 | **accepted（已在契约里）** | win32 `fingerprint` 返回 `null` 是**终态**：CONTRACTS L18 / §15.7 / §5.1 都已如此写；M1-PLAN §1.4 第 4 条再点一次。 |
| S8 | **accepted（记入文档）** | 空注册器优于抛错路由（否则 `createHttpApp()` 的每个 daemon 都会把未实现路由变成 500，而 D29 的诚实答案是 `400 unknown route`）。M1-PLAN §1.4 第 5 条。 |
| S9 | **accepted（记入文档）** | `routes/workers.ts` 从 `routes/index.ts` 取 helper——图上的环、运行时没有环；第五个 `params.ts` 会落进 WP‑E 的归属。M1-PLAN §1.4 第 6 条。 |
| S10 | **accepted（记入文档）** | M0 测试的适配逐条记录，并明写**没有削弱任何测试**（每处都是契约要求的形状变化）。M1-PLAN §1.4 第 9 条。 |
| S11 | **accepted（记入文档）** | `no-message-id` → `message-id-optional`（§10.2 要求）、`http-has-no-logic` 改递归扫描、新增 `sse-is-unchanged`。M1-PLAN §1.4 第 10 条。 |
| S12 | **accepted（改文档）** | CONTRACTS §5.1 的 config diff 从 `ProbeConfig.partial().prefault({})` 改成 `ProbeOverrides.prefault({})`，并写明 `.partial()` 不去掉内层 `.default()` 这个真实原因。 |
| S13 | **accepted（改文档）+ 扩展** | `CLOSE_REASON_CODE` 的判据「这是谁的决定」写进 CONTRACTS §5.1 `src/turn.ts` 段；本次新增的 `acl_revoked` 按同一判据映射到 `forbidden`。WP‑C 若不同意，改的是这一行加它的理由。 |
| S14 | **accepted（记入文档）** | `turn.ts` 由 Land 写成新签名并**移交 WP‑B**（§1.1 已如此写，§1.4 第 8 条复述），`verdict` 之外的新字段目前是 `[]` / `null`，§13.4 的提升规则属于 WP‑B。 |
