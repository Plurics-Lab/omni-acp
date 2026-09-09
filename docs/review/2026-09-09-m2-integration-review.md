# M2 集成后审查（2026-09-09）

来源：workflow `m2-implement-integrate`（wf_85f6a843-1fb）合并 + WP-J 之后的三路审查。修复轮当时未能执行，本文件是修复轮的输入。**每一条都要处理**：修代码并加测试，或写明不改的理由。

## 审查结论：pass-with-issues（4 条）

### V1 [major] `packages/daemon/src/http/routes/webhooks.ts`

H26 redeliver bypasses the SSRF re-check. The route at line 74 calls the delivery STORE's `redeliver` (`daemon.deliveries as OwnerScopedDeliveryStore`), which only flips the row back to `pending`; the background dispatcher's 1s poll then picks it up and POSTs it. `WebhookDispatcher.redeliver` (packages/core/src/webhook/dispatcher.ts:335) is the only code that re-runs `assertWebhookUrl(existing.url, cfg, resolve)` before a replay, and nothing in the shipped daemon ever calls it — grep shows the only caller is tests/integration/src/run-webhook.itest.ts:385, which invokes `rig.dispatcher.redeliver` directly, so the guard is tested but not wired. That makes the dispatcher's own stated rationale false in production: an operator replaying a dead letter hours or days later re-sends to a host whose name may now resolve into `denyCidrs` (169.254.169.254 / RFC1918), with no allowlist or CIDR re-evaluation. The create-time check is the only one that ever runs.

**建议修法**：Route the replay through the dispatcher so the gate runs. Widen `WebhookDispatcher.redeliver(id)` to `redeliver(id, tokenId?)` so it can apply the admin-or-owner scope, keep its `await assertWebhookUrl(existing.url, o.config, o.resolve)` before `store.redeliver`, expose it on the `Daemon` object beside `deliveries`, and change the route body to a single `await daemon.dispatcher.redeliver(assertDeliveryId(...), who.role === 'admin' ? undefined : who.tokenId)` (still parse -> ONE daemon call -> serialize). If the dispatcher seam must stay frozen, the equivalent is to add an `await assertWebhookUrl(row.url, config.webhooks, resolve)` step in a daemon-level redeliver method that the route calls, never a bare store write.

### V2 [major] `packages/daemon/src/registry.ts`

The policy engine is not reinstalled on the rehydrate/wake path, so a worker's policy stops being enforced after a daemon restart while the snapshot still advertises it. `create()` builds `const engine = o.policyFor?.(req.policy, auth, req.onUnresolved)` (line 1003) and threads `decide: (subject) => engine.decide(subject)` into the interaction strategy (line 1045). `rehydrate()` builds its strategy at line 582 with `onUnresolved`, `parkTimeoutMs`, `toSubject` and log — but no `decide`. `policyFor` appears in exactly two places in the repo (registry.ts:156 declaration, registry.ts:1003 call), so a worker adopted from a previous boot and then woken runs with `verdictFor`'s `DEFAULT_VERDICT[onUnresolved]` fallback and no rules and no `clampVerdict`. `WorkerRow.policyRef` is persisted specifically for this (contracts.ts:394 "a wake must reproduce the environment") and `viewRowsOf` reads it into `policyId` (registry.ts:1701), but it is only ever written back out to the row — never used to rebuild an engine. Meanwhile `viewRowsOf` keeps `policy: row.snapshot.policy`, so `GET /v1/workers/{wid}` continues to report `{sources, default, ruleCount, ceiling}` for an engine that no longer exists. Concretely: a worker created with `onUnresolved:"park"` and a policy whose rules deny `edit`/`delete` has those requests auto-denied before the restart; after the restart every one of them parks instead, and the lease holder can approve exactly the actions the policy was written to refuse. No test covers policy behaviour across a restart (restart-survives.itest.ts never mentions policy).

**建议修法**：Persist the policy SELECTION (the `PolicySelection` from `CreateWorkerRequest.policy`) on `WorkerRow` alongside `policyRef`, and in `rehydrate()` rebuild the engine with the same `o.policyFor(selection, authContextFor(row.snapshot.ownerTokenId), rows.onUnresolved)` the create path uses, passing `decide` into the strategy at registry.ts:582 exactly as line 1045 does. If the engine cannot be rebuilt (preset removed, ceiling now narrower, token gone), fail closed rather than degrade silently: refuse the wake with `not_resumable`, and in any case do not report `policy` on a snapshot whose strategy has no `decide`.

### V3 [minor] `packages/daemon/src/registry.ts`

`cwdRootsOf` (line 1817) binds the prompt-containment gate on the rehydrate path to the RAW config value: `config.tokens.find(t => t.id === tokenId)?.cwdRoots ?? []`. `TokenConfig.cwdRoots` is `z.array(z.string()).default([])` (packages/protocol/src/config.ts:110) — unexpanded and unresolved. The authoritative resolution lives in packages/daemon/src/auth.ts `toEntry`, which does `const roots = token.cwdRoots.length === 0 ? [homedir()] : token.cwdRoots` then `roots.map(resolvePath)`. So the create path (registry.ts:1200, `cwdRoots: auth.cwdRoots`) and the wake path use two different root sets. With the common `cwdRoots: []` (meaning homedir), the woken worker's gate gets `[]` and `assertPromptContent` throws `internal` "prompt containment is mis-bound: no cwdRoots" — a 500 on every path-bearing prompt block. With `cwdRoots: ["~/work"]`, the unexpanded `~` makes the cwd-inside-roots assertion fail and throws the second `internal`. Both directions fail closed (never more permissive), but the one containment root list in the daemon has two spellings, and a legitimate in-root `resource_link` becomes a 500 after a restart.

**建议修法**：Delete the second spelling: have `cwdRootsOf` go through the token store (`o.tokens.contextFor(tokenId).cwdRoots`, the same `AuthContext` the create path uses) so the homedir default and `resolvePath` apply once, in `auth.ts`, for both paths. Add a rehydrate-path case to packages/core/test/worker/prompt-content.test.ts's structural audit so a future divergence fails the build the way `creationPathInjects` does.

### V4 [minor] `packages/core/src/worker/worker.ts`

D4 rule 1 / rule 5's backstop at the emit point does not cover the default path. `#baselinePermission` re-checks the responder's answer against `mapped.options` and folds a forged id into rule 4's `-32603` (lines 1988-1999), and §12.6's comment explains why the check must be "at the one place that emits the answer, and not only inside the responder that happens to be wired today... `DaemonDeps.responder` is a public injection point". But `#onPermission` returns `await strategy.permission(mapped, this.#interactionContext())` (line 1556) straight to the ACP link with no such re-check, and `DaemonDeps.interactions` is a public injection seam of exactly the same kind — it is the seam M2's strategy lands on and the one an embedder replaces. CONTRACTS §19.7 rule 1 claims three independent checks including "worker.ts's existing forge guard"; on the shipped M2 path only two run, and there is nothing at the emit point that would catch a strategy returning an un-offered `optionId` or `outcome:"cancelled"`. Not currently exploitable — `selectOption`/`selectGrant`/`allowOf` all pick from the stored `req.options` — but the stated invariant is a property of the current strategy rather than of the emit point.

**建议修法**：Apply the same guard to the strategy's return value in `#onPermission`: after `const res = await strategy.permission(mapped, ctx)`, verify `res.outcome.outcome === 'selected'` and that `res.outcome.optionId` is in `new Set(mapped.options.map(o => o.optionId))`; on a violation log the same `error` line and throw `AcpRequestError.internalError({ offered: mapped.options }, 'the selected permission option was not offered')` — the identical rule-4 answer `#baselinePermission` already produces — so rule 1 and rule 5 are enforced where the answer reaches the wire, whichever strategy is injected.

## 审查结论：pass-with-issues（2 条）

### V5 [major] `packages/core/src/webhook/guard.ts`

webhooks.denyCidrs is bypassable by spelling a denied IPv4 address as an IPv4-mapped IPv6 literal. assertWebhookUrl derives the host from `new URL(raw).hostname`, and WHATWG URL ALWAYS re-serializes an IPv4-mapped host to the compressed hex form (`http://[::ffff:127.0.0.1]/` -> hostname `[::ffff:7f00:1]`). toBytes only folds the mapped prefix via the dotted-quad regex at line 156, so on the URL path that branch is dead: the address becomes 16 bytes, cidrContains rejects the length mismatch against every IPv4 rule, and firstDenying returns null. Proven end-to-end against the shipped daemon: with the DEFAULT denyCidrs (127.0.0.0/8 present) and webhooks.mode:"any", a run whose webhook is `http://127.0.0.1:P/hook` is refused at create ('resolves to 127.0.0.1, which is inside denied 127.0.0.0/8') while `http://[::ffff:7f00:1]:P/hook` — the SAME loopback socket — is accepted and the delivery lands ('delivered', receiver host header `[::ffff:7f00:1]:P`). The same spelling reaches 169.254.169.254 as `[::ffff:a9fe:a9fe]`. The DNS arm is unaffected (c-ares renders AAAA IPv4-mapped records in the dotted form, which toBytes already folds), so this is the IP-literal arm only; exposure needs mode:"any" (documented for closed networks) or an operator who allowlisted that literal origin. It contradicts the file's own stated invariant that the CIDR check is ABSOLUTE, and packages/core/test/webhook/guard.test.ts:193 already asserts the intent ('`::ffff:127.0.0.1` IS 127.0.0.1, and must not be a way around an IPv4 deny rule') — but only through cidrContains directly, never through assertWebhookUrl, which is why the production path defeats it unnoticed.

**建议修法**：Fold the IPv4-mapped prefix NUMERICALLY in toBytes rather than by the dotted-quad spelling. Replace the final return at line 170 with: `if (!(bytes.length === 16 && bytes.every((b) => Number.isInteger(b)))) return null; if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12); return bytes;` (the regex branch at 156-157 can stay as a fast path). Verified in isolation: ::ffff:127.0.0.1, ::ffff:7f00:1 and 0:0:0:0:0:ffff:7f00:1 all match 127.0.0.0/8; ::ffff:a9fe:a9fe matches 169.254.0.0/16; ::1, fe80::1, fd00::1 keep their existing matches and 8.8.8.8, 2001:4860:4860::8888, ::ffff:8.8.8.8 and ::ffff:808:808 still match nothing. Add the missing regression at the assertWebhookUrl level (not only cidrContains), since that is the layer where new URL()'s re-serialization is applied.

### V6 [minor] `packages/daemon/src/create-daemon.ts`

After daemon.stop() the run and delivery read verbs throw raw node:sqlite errors instead of a typed OmniError. Reproduced by stopping a daemon while a run was live and then reading its final state: `daemon.runs.get(runId, auth)` throws `Error: statement has been finalized` and `daemon.deliveries.list({runId, limit})` throws `Error: database is not open`. stop() closes persistence last (correctly), but nothing marks the daemon as stopped, so these verbs are still callable and fail below the error-classification layer. Under D15 ('the library IS the product') an embedder reading a run's terminal state after shutdown gets an unclassified crash rather than a typed refusal, and the HTTP adapter would map it to a 500 rather than to a named code. Not a data-integrity problem — probe 7 confirms the run row and its delivery are committed before the store closes and are read back correctly by the next boot.

**建议修法**：Set a `stopped = true` flag inside the stop() closure before `persistence?.close()`, and have the `runs`, `deliveries`, `workers` and `catalog` accessors on the returned `Daemon` object throw `new OmniError("internal", "the daemon has stopped")` when it is set — the same shape every other refusal on this object already uses. Alternatively guard only the two run/delivery read paths if a wider gate risks breaking existing shutdown-ordering tests.

## 审查结论：pass-with-issues（6 条）

### V7 [major] `packages/core/src/webhook/guard.ts`

denyCidrs is bypassed by the hex spelling of an IPv4-mapped IPv6 address. toBytes() only unwraps the dotted `::ffff:a.b.c.d` form (line ~155 regex), but the two producers that actually feed assertWebhookUrl never emit that form: Node's WHATWG URL normalises `http://[::ffff:169.254.169.254]/` to hostname `[::ffff:a9fe:a9fe]`, and dns.resolve6 returns the same compressed hex. Verified against the shipped dist: cidrContains("169.254.0.0/16", "::ffff:169.254.169.254") === true but cidrContains("169.254.0.0/16", "::ffff:a9fe:a9fe") === false, and assertWebhookUrl ALLOWED http://[::ffff:127.0.0.1]:9/hook under the default denyCidrs. §24.6 calls the CIDR check ABSOLUTE and the file's own comment promises the mapped form "must not be a way around an IPv4 deny rule" — the promise is dead for every input path that exists. Reachable with webhooks.mode:"any", and via an AAAA record on an allowlisted host, which is precisely the DNS-rebinding-to-metadata attack §24.6 exists for. Separately, 0.0.0.0 (a standard localhost alias on Linux) is not in the default denyCidrs and was ALLOWED.

**建议修法**：In toBytes(), after parsing 16 bytes, detect the mapped prefix structurally rather than lexically: if bytes[0..9] are all 0 and bytes[10]===0xff and bytes[11]===0xff, return bytes.slice(12) so the address is compared as the IPv4 address it is. Keep the dotted-form regex as a fast path. Add `::ffff:a9fe:a9fe` / `::ffff:7f00:1` rows to guard.test.ts beside the existing `::ffff:127.0.0.1` row, and add `0.0.0.0/8` to WebhookConfig.denyCidrs' default in packages/protocol/src/config.ts.

### V8 [major] `packages/daemon/src/registry.ts`

The rehydrate path builds an InteractionStrategy with no policy engine and no MCP servers, so a worker woken after a daemon restart silently stops enforcing its policy. At line 582 `o.interactions?.({...})` passes workerId/clock/ids/config/onUnresolved/parkTimeout*/log/workerState/toSubject but NO `decide` — unlike the create path at line 1045, which passes `decide: engine.decide`. viewRowsOf (line 1695) restores `policy: row.snapshot.policy` and `policyId` for REPORTING, and nothing rebuilds a PolicyEngine. Consequences after a restart + wake: (a) every request falls to DEFAULT_VERDICT[onUnresolved], so a preset's deny rules never fire and, under onUnresolved:"park", a request the rule file denies is instead offered to a human to allow; (b) §20.5 layer 2 — the per-subject policyCeiling clamp, which lives inside createPolicyEngine — stops running entirely, and it is the half that is documented as recovering the precision the static check provably cannot; (c) WorkerSnapshot.policy keeps advertising sources and a ceiling that nothing enforces. The same block also omits `mcpServers` (only line 1191 on the create path injects it), so a woken worker reopens its session with `mcpServers: []`, and §23.1's "a preset that vanished from config between hibernate and wake ⇒ acl_revoked" is unimplemented (`acl_revoked` appears nowhere in registry.ts). No test covers policy or MCP across a restart.

**建议修法**：Persist the worker's PolicySelection and mcp names on WorkerRow (mcpNames already exists; policyRef only stores the engine id), then in the rehydrate block re-resolve both from the CURRENT config exactly as create() does: call o.policyFor(selection, auth-equivalent, rows.onUnresolved) and pass `decide`, and resolve the presets to `mcpServers`. A preset or ceiling that no longer resolves should close the worker with acl_revoked, as §23.1 specifies, rather than waking it unenforced. Add an integration test that creates a worker under `src-edit`, restarts the daemon, wakes it, and asserts a `delete` still hits the preset's deny rule.

### V9 [major] `packages/core/src/policy/ceiling.ts`

Four M2 TurnWarning codes and one snapshot flag are specified but never produced, so several "it is never silent" guarantees are silent. `policyClampWarning` (ceiling.ts:271) and `unpolicedToolCalls` (policy/alert.ts:23) have unit tests and ZERO production callers — grep for their names outside test/ returns only their own definitions. reduceTurn assembles TurnResult.warnings at protocol/src/turn.ts:720 from streamWarnings + tool_denied + tool_failed only, so `policy_clamped` (§20.5), `unpoliced_tool_call` (§20.6) and §19.9's two materialize advisories `interaction_declined` / `interaction_expired` never reach a turn — the last two exist nowhere in the repository outside CONTRACTS.md. `alertOnUnpoliced` is therefore a config key that does nothing. Related, in the same silence: a verdict clamped from allow to park is recorded nowhere at all — createPolicyEngine returns `clamped:{from:"allow",...}` (I reproduced this: allow on `src*/**` under pathRoots:["src"] against /repo/src-secrets/a.ts clamps to park), but route() then parks, and the settlement records built by answerOf/expire/settleAllOf hard-code `clamped: null`, so the one clamp that changes an auto-allow into a human decision leaves no `clamped` on omni.policy_decision. Also unimplemented: M2-R19's loudness for `interaction.allowAlways:"human"` — strategy.ts:571-598 stamps `blindsPolicy` on the decision, but `WorkerSnapshot.policyBlinded` (protocol/src/worker.ts:242) is declared and never assigned anywhere, and no `TurnWarning{code:"policy_blinded"}` is ever built, so two of the three announcements that justify allowing the opt-in are missing.

**建议修法**：Derive the interaction-side warnings in reduceTurn from the omni.policy_decision envelopes it already folds (the payload carries `clamped`, `blindsPolicy`, `status` and `action`): emit policy_clamped from `clamped`, policy_blinded from `blindsPolicy`, interaction_declined when an elicitation settles decline/cancel, interaction_expired when status is "expired". Carry the verdict's `clamped` through the park path by storing it on the HeldInteraction and merging it into the settlement record in answerOf/expire/settleAllOf. Call unpolicedToolCalls() where the daemon materializes the turn, passing the resolved policy's alertOnUnpoliced. Make Worker set a sticky #policyBlinded when a settlement record has blindsPolicy and surface it as WorkerSnapshot.policyBlinded.

### V10 [minor] `packages/core/src/worker/worker.ts`

§19.6's "fixed and table-tested" check order for POST /v1/workers/{wid}/interactions/{reqId} is not the order the code runs, and no test pins it. The contract is visibility -> worker state -> interaction existence -> lease -> body shape -> semantics. Actually: registry.answer (registry.ts:1441) does visibility via get(), then InteractionAnswerBody.parse, then Worker.answerInteraction (worker.ts:1647) which calls lease.assertHolder FIRST and only then strategy.answer, which is where interaction_not_found comes from. So a non-holder answering a stale reqId gets 423 lease_held instead of 404 interaction_not_found — exactly the inversion the contract calls out ("a stale request id does not report a lease problem it does not have") — and a malformed body from a non-holder gets 400 instead of 423. Neither answerInteraction nor get() checks `closed`, so the table's 410 worker_closed row is unreachable on this route. daemon/test/http/interactions.test.ts only maps pre-thrown OmniErrors to statuses; it never exercises the order.

**建议修法**：In registry.answer, move the InteractionAnswerBody.parse below the handle lookup and after the lease is checked. In Worker.answerInteraction, throw worker_closed when #state === "closed", then look the interaction up (strategy.get(id) === null => interaction_not_found) BEFORE lease.assertHolder — existence is already public through the ungated GET /interactions, so this leaks nothing. Add a table test that drives all four orderings through one assembled worker.

### V11 [minor] `packages/daemon/src/create-daemon.ts`

daemon.stop() omits the first rung of §24.4 rule 5 / §19.8's four callers: "interactions settled -> dispatcher.drain(bounded) -> workers closed -> socket". The implementation (create-daemon.ts:556) goes dispatcher.drain -> dispatcher.stop -> workers.closeAll -> supervisor -> socket, and interactions are only settled later, inside each Worker.close, with reason "close". The "shutdown" arm of InteractionStrategy.settleAll is consequently unreachable in shipped code — grep shows it is passed only from tests. Because the dispatcher is already stopped by then, any terminal run.* delivery enqueued while those turns terminalize (run/registry.ts fire() -> dispatch() -> queueMicrotask(pump), which no-ops once `stopped`) is never attempted this boot; under eventLog.driver:"memory" there is no next boot to recover it. create-daemon-m2.test.ts:160 encodes the current order rather than the contract's.

**建议修法**：Add an explicit settle step at the top of the stop ladder — iterate the registry's live handles and await settleAll("shutdown") (or expose workers.settleAllInteractions()) — before dispatcher.drain, and update the test's expected order to ["interactions settled", "dispatcher.drain", "dispatcher.stop", "worker closed"]. Consider draining once more after closeAll so a terminal run.* enqueued by the close still gets one attempt.

### V12 [minor] `packages/core/src/diff/git-provider.ts`

diff.mode:"on_write" is the documented default and behaves identically to "always". §25.4 says on_write "runs git only when the turn had a write-ish tool call or any changes", and §11.9 lists it as the mitigation for "patch costs a subprocess pair per turn, and git add -A is O(worktree)". The only place cfg.mode is read is git-provider.ts:208 (`if (cfg.mode === "off") return null`); nothing in worker.ts's #drivePrompt/#endPatch or the registry consults it, so every turn on a git worker pays two `git add -A` + `write-tree` pairs whether or not it wrote anything. The existing test (git-provider.test.ts:326) asserts the two modes agree, which is true but does not exercise the cost difference the mode exists for.

**建议修法**：Either implement the gate — in Worker.#drivePrompt, when the resolved mode is "on_write", skip the `end` call and stamp a PatchResult of {text:"", quality:"exact"} when the turn recorded no write-ish tool call and no `changes` (the reducer already tracks both) — or drop the enum member and the §25.4/§11.9 claims that rest on it, so an operator does not plan around a knob that does nothing.

---

## 复核（2026-09-09，`02090a5` + 工作树）

对 V1–V12 逐条按“读代码 + 跑相关测试 + 亲手复现”重新核对。基线是 `02090a5`，加上工作树里尚未提交的
`guard.ts` / `config.ts` 改动（见下 V5/V7）。全量 `pnpm -r build && pnpm test` 绿：**215 files / 3252
passed / 157 skipped**；`tests/compat` 的 hermetic 套件单独跑一次也绿：**2 files / 117 passed / 151
skipped**。所有行为复现都是 `mkdtemp` 起的一次性脚本，`listen: null`（零端口），全部走 `daemon.fetch`。

**已解决：V5、V7。其余十条仍然开着**，代码与本文件写下时逐字一致。

### 已解决

**V5 / V7 — IPv4-mapped 绕过 `denyCidrs`，以及 `0.0.0.0`**。`toBytes` 现在在解析出 16 字节之后按
**结构**（前十字节为 0，随后 `ff ff`）折叠 `::ffff:0:0/96`，点分十进制正则退化为快路径；
`WebhookConfig.denyCidrs` 的默认值加了 `0.0.0.0/8`。端到端复现（默认 `denyCidrs`、`webhooks.mode:"any"`、
`POST /v1/runs`）：

| webhook url | 结果 |
|---|---|
| `http://127.0.0.1:P/hook` | 403 `forbidden` … inside denied `127.0.0.0/8` |
| `http://[::ffff:7f00:1]:P/hook` | 403 `forbidden` … inside denied `127.0.0.0/8` |
| `http://[::ffff:127.0.0.1]:P/hook` | 403（`new URL` 已重写成 `[::ffff:7f00:1]`） |
| `http://[0:0:0:0:0:ffff:7f00:1]:P/hook` | 403 |
| `http://0.0.0.0:P/hook` | 403 … inside denied `0.0.0.0/8` |
| `http://[::ffff:a9fe:a9fe]/hook` | 403 … inside denied `169.254.0.0/16` |

接收端一条投递都没收到。回归测试落在 `assertWebhookUrl` 这一层（不只是 `cidrContains`），公共默认值的
变化也在 `packages/protocol/test/config.test.ts` 里钉住了。**注意：这两条的修复目前只在工作树里，尚未
提交**——本次 build / test / compat 都是在包含它的工作树上跑的。

### 仍然开着

**V1 [major] — redeliver 仍然绕过 SSRF 复检。** `packages/daemon/src/http/routes/webhooks.ts:78` 依旧直接
调 store 的 `redeliver`；`WebhookDispatcher.redeliver`（`dispatcher.ts:335`，唯一会重跑
`assertWebhookUrl` 的地方）在整个 `packages/` 里仍然没有生产调用方，`grep` 只命中它自己的定义、
`contracts.ts` 的声明、以及两处测试。**复现**（同一个 `dataDir`、同一个接收器进程、两次启动）：
boot 1 `denyCidrs: []` 建 run → 投递落库；`stop()`；boot 2 把 `denyCidrs` 改成 `["127.0.0.0/8","::1/128"]`。
同一个 URL 上新建 run 被 `403 forbidden … inside denied 127.0.0.0/8` 挡住，但
`POST /v1/webhooks/deliveries/{id}/redeliver` 返回 **200**，接收器随即收到一条新的 POST（1 → 2）。
运维几天后重放死信，仍然打到一个现在被拒绝的地址。缺的还是原来那句：把重放走 dispatcher，或在
daemon 层的 redeliver 里补一次 `assertWebhookUrl`。

**V2 / V8 [major] — 唤醒路径没有策略引擎（而且比报告写的更糟）。** `registry.ts:582` 的
`o.interactions?.({…})` 依旧不传 `decide`，`policyFor` 全仓只出现在 `registry.ts:156`（声明）和
`registry.ts:1003`（create 路径）；rehydrate 块也依旧不注入 `mcpServers`，`acl_revoked` 在
`registry.ts` 里仍然一次都没出现。**复现**（`policy: {default:"deny"}` + `onUnresolved:"park"`，
一个会 `session/request_permission` 且 `loadSession:true` 的临时 fixture，hibernate → `stop()` →
同 `dataDir` 重启 → wake → 再 prompt），两条 `omni.policy_decision` 并排：

- 重启前：`"decision":"deny","by":"policy","rule":"deny-all+inline#default"` —— 引擎判的。
- 重启后：`"decision":"deny","by":"policy","rule":"m2:onUnresolved","ruleSource":"default"` ——
  `DEFAULT_VERDICT` 兜的，没有规则、没有 `clampVerdict`。

同一次复现还暴露出一层报告里没写到的问题：**`WorkerRow` 上所有 M2 字段根本没有落盘**。
`packages/core/src/persist/worker-store.ts` 的 `upsert` 没有为 `onUnresolved` / `parkTimeoutMs` /
`parkTimeoutAction` / `mcpNames` / `policyRef` / `env` / `watchdog` / `patchMode` 写任何列，`toRow`
也不读回来，而 `viewRowsOf`（`registry.ts:1694`）读的正是 `row.onUnresolved` 这些行字段。于是唤醒后
`onUnresolved` 从 `park` 退成 `M1_VIEW` 的 `deny`（实测：快照 `onUnresolved: "park"` → `"deny"`，
`capabilities.clientCapabilities` 从 `{"elicitation":{"form":{}}}` → `{}`），F28 说的“park 再也不会
发生”当场发生；`decorate()` 随后把退化值写回 `snapshot_json`，第二次启动就把磁盘上原本正确的
`"park"` 覆盖掉了（boot 1 落盘为 `park`，boot 2 之后为 `deny`）。`rowOf` 那段“persisted BECAUSE OF
THE WAKE PATH”的注释目前是不成立的。修 V2/V8 之前得先让这些行真的写进去、并从行字段而不是
`snapshot_json` 之外的地方读回来。

**V3 [minor] — `cwdRootsOf` 仍绑在原始 config 上。** `registry.ts:1817` 一字未动
（`config.tokens.find(...)?.cwdRoots ?? []`）。**复现**（token 不写 `cwdRoots`，即 `[]` ⇒ homedir，
cwd 建在 `homedir()` 下，prompt 带一个根内的 `resource_link`）：create 路径 `202`；hibernate → 重启 →
wake 之后，同一个 prompt 得到 **`500 {"code":"internal","message":"prompt containment is mis-bound: no
cwdRoots"}`**。`packages/core/test/worker/prompt-content.test.ts` 的结构审计仍只覆盖 create 路径。

**V4 [minor] — 出口点没有守卫。** `worker.ts:1556` 仍是
`return await strategy.permission(mapped, this.#interactionContext())`，没有对返回值做
`mapped.options` 复检；`#baselinePermission`（1988-1999）的那份检查依然只在没有 strategy 时生效。
§19.7 rule 1 说的“三重独立检查”在出厂路径上仍然只有两重。

**V6 [major] — `stop()` 之后的读动词仍抛裸 sqlite 错。** `create-daemon.ts` 的 stop 闭包里没有任何
`stopped` 标记。**复现**：跑完一个带 webhook 的 run，`await daemon.stop()`，然后
`daemon.runs.list(...)` 与 `daemon.deliveries.list(...)` 都抛
`Error{code:"ERR_INVALID_STATE", message:"database is not open"}`（不是 `OmniError`），
同一时刻 `daemon.fetch(GET /v1/runs/{id})` 返回 **500**——正是报告预期的未分类崩溃。

**V9 [major] — 四个 `TurnWarning` 码与一个快照标志仍然只存在于文档里。** `reduceTurn`
（`protocol/src/turn.ts:720`）的 `warnings` 依旧只由 `streamWarnings` + `tool_denied` + `tool_failed`
组成。`policyClampWarning`（`ceiling.ts:271`）与 `unpolicedToolCalls`（`policy/alert.ts:23`）在
`test/` 之外仍然零调用方；`interaction_declined` / `interaction_expired` 在仓库里除 CONTRACTS.md 外
不存在；`WorkerSnapshot.policyBlinded`（`protocol/src/worker.ts:242`）在 `packages/core/src` 里一次都
没被赋值；`strategy.ts` 的结算记录（448、625）仍硬编码 `clamped: null`。`alertOnUnpoliced` 依旧是一个
什么都不做的配置键。

**V10 [minor] — §19.6 的检查顺序仍然是反的，四行全中。** `registry.answer`（`registry.ts:1441`）仍在
拿到 handle 之后、进 handle 之前 `InteractionAnswerBody.parse`，`Worker.answerInteraction`
（`worker.ts:1647`）仍先 `lease.assertHolder`。**复现**（A 持租约，B 为观察者）：

| 场景 | 契约 | 实测 |
|---|---|---|
| 非持有者 + 陈旧 reqId | 404 `interaction_not_found` | **423 `lease_held`** |
| 非持有者 + 畸形 body | 423 `lease_held` | **400 `bad_request`** |
| 持有者 + 陈旧 reqId | 404 | 404 ✓（对照组） |
| 已关闭 worker 上作答 | 410 `worker_closed` | **404 `interaction_not_found`**（410 那行仍不可达） |

**V11 [minor] — stop 阶梯少了第一级。** `create-daemon.ts:556` 仍是
drain → dispatcher.stop → closeAll → supervisor → socket，没有显式的
`settleAll("shutdown")`；`settleAll` 的 `"shutdown"` 分支在生产代码里仍然不可达。
`packages/daemon/test/create-daemon-m2.test.ts` 的用例名依旧写着
`"stops dispatcher.drain → dispatcher.stop → workers → socket"`，钉的是现状而不是契约。

**V12 [minor] — `diff.mode:"on_write"` 与 `"always"` 仍然完全等价。** `cfg.mode` 唯一的读点还是
`git-provider.ts:208` 的 `=== "off"`。**复现**（把 `git` 换成记账 shim，跑一个 `echo` fixture 的
turn——它不写任何文件、也不报告任何 write-ish tool call）：

```
mode=on_write: 6 git commands   rev-parse --show-toplevel / add -A -- / write-tree ×2
mode=always  : 6 git commands   （逐字相同）
```

§11.9 拿来当缓解措施的那个开关，今天一次 `git add -A` 都没省下。

---

## 处理记录（2026-09-09，修复轮第二次）

十二条全部处理完毕。**每一条都配了一个在 revert 掉生产改动后会红的测试**，下表最后一列写的就是那个测试，
以及它在缺少修复时实际报出来的断言。全量 `pnpm -r build && pnpm test` 绿：**222 files / 3305 passed /
157 skipped**；`pnpm lint` 与 `prettier --check` 干净。

`docs/CONTRACTS.md` 与 `docs/M2-PLAN.md` 已随之更新：契约改动写在它们各自的段落里（§19.6 的检查顺序、
§19.7 rule 1/5、§19.8 的调用方、§19.9 的两条 advisory、§20.5/§20.6、§23.1 的唤醒重解析、§24.2 的
schema v3、§24.4 rule 5 的停机阶梯、§24.6 的 redeliver 复检与数值折叠、§25.4 的 `on_write`、§26.2 的
两个注入点），M2-PLAN 新增 §5.3 汇总，并修订了 §5.2 里被本轮推翻的第 3、5 两行。

### 逐条

| # | 结论 | 落点 | 回归测试（revert 后报什么） |
| - | ---- | ---- | ---- |
| V1 | 修 | `POST …/redeliver` 改走 `Daemon.dispatcher`；`WebhookDispatcher.redeliver(id, tokenId?)` | `daemon/test/http/webhooks.test.ts` "a REDELIVERY re-runs the SSRF gate…"：revert 后 `expected 200 to be 403` |
| V2 / V8 | 修 | 唤醒路径重建引擎与 MCP；`WorkerRow` 的 M2 字段真正落盘（schema v3） | `tests/integration/src/restart-policy.itest.ts`（3 例）+ `daemon/test/registry-wake.test.ts`（3 例）：revert `decide` 后 `expected 'deny' to be 'allow'`，revert 落盘后再多一条 `expected 'deny' to be 'park'` |
| V3 | 修 | `cwdRootsOf` 走 token store | `daemon/test/registry-wake.test.ts` "binds it to the RESOLVED cwdRoots…"：revert 后 `'…: no cwdRoots'` ≠ `'…: cwd is outside cwdRoots'`；`core/test/worker/prompt-content.test.ts` 的结构审计同时转红 |
| V4 | 修 | `#assertOffered` 也作用于注入的 strategy | `core/test/worker/interaction/emit-guard.test.ts`：revert 后伪造的 `optionId` 与 `cancelled` 都原样上线 |
| V5 / V7 | 修（本轮之前已在工作树里，本次一并提交） | `toBytes` 数值折叠 `::ffff:0:0/96`；默认 `denyCidrs` 加 `0.0.0.0/8` | `core/test/webhook/guard.test.ts` 在 `assertWebhookUrl` 这一层的三个新用例 |
| V6 | 修 | `stop()` 后 `runs`/`deliveries`/`dispatcher` 抛 typed `OmniError` | `daemon/test/create-daemon.test.ts` "refuses the run and delivery verbs with a TYPED error…"：revert 后 `expected Error: database is not open to be an instance of OmniError` |
| V9 | 修 | 五个 advisory 全部产出；park 路径带上 clamp；`policyBlinded` 置位 | `protocol/test/turn.test.ts`（5 例）+ `core/test/worker/interaction/policy-announcements.test.ts`（8 例）：revert 后共 10 条红 |
| V10 | 修 | §19.6 顺序落到 `Worker.answerInteraction`，路由不再预先 parse | `core/test/worker/interaction/answer-order.test.ts`：revert 后 `'lease_held'` ≠ `'interaction_not_found'`、`'interaction_settled'` ≠ `'worker_closed'` |
| V11 | 修 | stop 阶梯补上 `settleAllInteractions()`，并在 `closeAll` 之后再 drain 一次 | `daemon/test/create-daemon-m2.test.ts` 的停机顺序用例：revert 后少了 `"interactions settled"` |
| V12 | 修（选“实现 gate”，见下） | `DiffProvider.end(h, {wroteFiles})`，provider 侧按 `cfg.mode` 决定 | `core/test/diff/git-provider.test.ts` 的 `on_write` 四例 + `core/test/worker/patch-on-write.test.ts` 五例 |

### 两处“二选一”的取舍

**V1 —— 选“把重放走 dispatcher”，不选“在 daemon 层补一次 `assertWebhookUrl`”。**
第二个方案要在 `create-daemon.ts` 里再写一遍 SSRF 门，于是同一条规则有两处实现，而它们唯一的区别正是
“谁记得调用它”——这就是这条 finding 本身的形状。走 dispatcher 让「重放」和「首投」共用同一段代码，
`tokenId` 作为可选参数挂在同一个动词上，也让 D13 的 “不能 LIST 的行就不能 REPLAY” 变成一条规则而不是两条。
代价是 `Daemon` 多了一个成员 `dispatcher`；它和 `runs` / `deliveries` 一样恒在，`webhooks.enabled:false`
时是 `unimplementedDispatcher()`，每个动词 `bad_request` 并点名工作包（D29 的“尚未实现”，M1 Land 先例 S8）。

**V2 —— 引擎重建不了时选 `acl_revoked`（V8 的说法），不选 `not_resumable`（V2 的说法）。**
`not_resumable` 是 agent 说“我恢复不了这个会话”（§15.5 的 422，带 `ResumeReport`）；这里 agent 没有任何
问题，是**当前配置**不再允许这个 worker——那正是 M1-R23 造 `acl_revoked` 的场景，§15.5 也已经为它准备了
403 `forbidden` 那一行。§23.1 的表格本来就写着 “a preset that vanished from config between hibernate and
wake ⇒ `acl_revoked`”，所以这是实现一条已经写好的契约，而不是新开一个语义。worker 被 CLOSE 掉而不是留在
`hibernated`：在这份配置下它永远醒不来，留着只会让运维手工收尸。

**V12 —— 选“实现 gate”，不选“删掉 enum 成员”。**
删 `on_write` 要动 `diff.mode` 的默认值、`CreateWorkerRequest.patch` 的枚举、`WorkerRow.patchMode`、
`M1_VIEW`，以及 §25.4 / §11.9 两处文档，波及面比实现更大；而且 §11.9 把它列为“每回合一对子进程”的
缓解措施，删掉等于承认那条成本没有对策。实现的方式是把两半分给各自知道答案的一方：`worker.ts` 只报告
「这一回合写没写」（从**归一化后**的信封上折出来，因此不含任何 per-agent 分支），`git-provider.ts` 持有
`cfg.mode`，自己决定要不要省掉第二对 `git add -A` + `write-tree`。`begin` 省不掉——F39 说“在不在仓库里”
必须每回合问一次——所以省下的是一半，这也正是 review 建议里写的那一半。缺席的 `wroteFiles` 一律当成
`true`：拿不到的观测不能用来压掉一个补丁。

### 附带修掉、但十二条里没有写到的两件事

1. **`WorkerRow` 的 M2 字段从来没有落过盘**（复核那一节发现的）。这是 V2/V8 的前置条件：不修它，
   重建引擎也没有 `PolicySelection` 可读，而且 `onUnresolved` 会在第一次唤醒时从 `park` 退成 `deny`，
   `decorate()` 再把退化值写回 `snapshot_json`，第二次启动就把磁盘上正确的值覆盖掉。
   `SCHEMA_VERSION` 2 → 3 加了一列 `workers.m2_json`（唯一一次 `alter table`，用 `pragma_table_info`
   守卫所以每次 open 都安全），`WorkerRow` 同时新增 `policy: PolicySelection | null`。
2. **`RehydrateDeps` 没有转发 `alertOnUnpoliced`**，于是 V9 的 `unpoliced_tool_call` 在唤醒后的 worker 上
   会静默消失。一并补上。

### 一处刻意的“不做”

`daemon.stop()` 之后 **`workers` 与 `catalog` 没有加门**（V6 建议里的第二个选项）。
`daemon.workers.turn(id, auth, tid)` 在 stop 之后从 ring 里答 `worker_closed` 是 M1 已经断言过的行为
（"still answers a turn query for a worker closed by shutdown — the log outlives it"），
`daemon.workers.size === 0` 则是停机测试证明整队都走了的方式；这两个调用今天是对的，而且都不碰任何已经
关闭的 statement。加门的三个动词恰好就是 `stop()` 会关掉其后端存储的那三个。

---

## 复核（2026-09-09，修复轮之后，`1370d5b`）

对 V1–V12 逐条重新核对：读当前代码 + 跑该条自己的回归测试 + **亲手复现**。所有行为复现都是 `mkdtemp`
起的一次性脚本，`listen: null`（零端口），全部走 `daemon.fetch`，跑完即删。

全量 `pnpm -r build && pnpm test` 绿：**222 files / 3305 passed / 157 skipped**；`tests/compat` 的
hermetic 套件单独跑一次也绿：**2 files / 117 passed / 151 skipped**。

**结论：十二条全部关闭，没有仍然开着的条目。** 上一轮 复核 里那十条“仍然开着”的，这次逐条打在真实
daemon 上都翻了过来。

### 逐条复核

| # | 怎么核的 | 实测 |
| - | -------- | ---- |
| V1 | 同一 `dataDir` 两次启动：boot 1 `denyCidrs: []` 建 run→投递落地；boot 2 改成 `["127.0.0.0/8","::1/128"]` 后重放同一条 | 新建 run `403`，`POST …/{id}/redeliver` 也 **`403 forbidden … inside denied 127.0.0.0/8`**；接收器命中数 `1 → 1`（上一轮是 200 且 `1 → 2`） |
| V2 / V8 | `policy: {presets:["notes-only"]}`（`default: allow`）+ `onUnresolved:"park"`，`hybrid`(`HYBRID_ASK=1`) 真实 resume，hibernate→`stop()`→同 `dataDir` 重启→唤醒→再 prompt；再跑第三、第四次启动 | 重启前后两条 `omni.policy_decision` 都是 `"by":"policy","rule":"notes-only#default"`（引擎判的，不再是 `m2:onUnresolved`）；`onUnresolved/parkTimeoutMs/parkTimeoutAction/patchMode` 三次启动都还在（`park / 60000 / fail / off`），`clientCapabilities` 仍是 `{"elicitation":{"form":{}}}`；boot 4 删掉 preset 后 prompt `403`，快照 `state: closed / closeReason: acl_revoked`（§23.1） |
| V3 | token 不写 `cwdRoots`（⇒ homedir），cwd 是 `homedir()` 下的 `mkdtemp`，prompt 带一个根内 `resource_link`；create 路径与 hibernate→重启→wake 路径各打一次 | 两次都是 **`202`**（上一轮 wake 路径是 `500 … no cwdRoots`） |
| V4 | 出口点守卫是对**注入的 strategy** 的复检，出厂 strategy 不会伪造，所以只能在 `Worker` 这一层证；跑 `core/test/worker/interaction/emit-guard.test.ts` | `worker.ts:1658` 现在是 `#assertOffered(await strategy.permission(...), mapped)`，3 例绿 |
| V5 / V7 | 默认 `denyCidrs` + `webhooks.mode:"any"`，七种拼法各建一次 run | `127.0.0.1` / `[::ffff:7f00:1]` / `[::ffff:127.0.0.1]` / `[0:0:0:0:0:ffff:7f00:1]` / `0.0.0.0` / `[::ffff:a9fe:a9fe]` / `[::1]` 全是 **403**，接收器 0 命中；`WebhookConfig` 默认值含 `0.0.0.0/8` |
| V6 | 跑完一个 run 后 `await daemon.stop()`，再调三个读动词与 HTTP | `runs.get` / `runs.list` / `deliveries.list` / `dispatcher.redeliver` 全部 **`OmniError(internal) "the daemon has stopped"`**（不再是裸 `database is not open`），`GET /v1/runs/{id}` 是 `500 {"code":"internal",…}`——有名字的分类错误；`workers.size` 仍按“刻意不做”那节返回 `0` |
| V9 | 五个 advisory 各跑一条真回合 | `interaction_declined`（人拒答 elicitation）、`interaction_expired`（`parkTimeoutMs:1500` 到期）、`unpoliced_tool_call`（preset 的 `alertOnUnpoliced:["read"]` + hybrid 的 `kind:"read"` 调用）、`policy_blinded`（`interaction.allowAlways:"human"` + 人选 `allow-always`，且快照 `policyBlinded: true`）、`policy_clamped`（ceiling `pathRoots:[<cwd>/note]` + 规则 `path:[<cwd>/note*]`，静态可过、运行期落在根外）——五条都出现在 `TurnResult.warnings` 里 |
| V10 | A 持租约、B 为观察者；陈旧 reqId 与**真实 parked** reqId 各打一遍，外加已关闭 worker | 非持有者+陈旧 `404 interaction_not_found`；非持有者+畸形 body（真实 reqId）`423 lease_held`；持有者+畸形 body `400 bad_request`；已关闭 worker `410 worker_closed`——四行全部与 §19.6 的顺序一致 |
| V11 | 停机时留一个 parked elicitation（`elicit-never-answers`），`stop()` 后由下一次启动读日志 | 结算信封 `{"status":"cancelled","answer":{"by":"daemon","action":"decline"}}`——`settleAll` 的 `"shutdown"` 臂在生产代码里终于走到了；`create-daemon-m2.test.ts` 的顺序用例已改成契约顺序 |
| V12 | 把 `git` 换成记账 shim，同一个 `echo` 回合（不写盘）跑 `on_write` 与 `always` 各一次；再用 `patch-writer` 跑一个真写盘的回合 | `on_write` **3** 条 git 命令（`rev-parse` / `add -A` / `write-tree`），`always` **6** 条——省掉的正是第二对；写盘的回合在 `on_write` 下照样拿到完整 patch（`diff --git a/hello.txt …`，7 条命令） |

### 一处措辞上的小瑕疵（不构成开着的条目）

`policyClampWarning` 的 `to` 取的是**结算时的最终 decision**，不是被夹到的那个动作。于是“allow 被夹成
park、人再答 allow”这条路径上，警告读作 `"allow" was narrowed to "allow" by token:local:pathRoots`——
两端同字，字面上自相矛盾（`detail.rule` 是 `human:local`，看得出中间进过人手）。announcement 本身按
§20.5 出了，`from` / `by` / `rule` 都对，所以 V9 是关闭的；只是这句话对运维不够直白，值得以后顺手改成
把「夹到的动作」和「最终动作」分开写。
