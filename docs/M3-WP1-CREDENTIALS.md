# M3-WP1 — 凭据仓库、Home 隔离、动态换凭据、worker 重启

> 2026-09-12 · 范围小、直接在 main 上做。上位文档：docs/DESIGN.md（D13 多用户、§8 安全）、docs/CONTRACTS.md（M2）。

## 实测事实（2026-09-12，本机）

| # | 事实 |
|---|---|
| E1 | claude-acp 只需 `CLAUDE_CONFIG_DIR=<dir>` 且 dir 里有 `.credentials.json`（`{claudeAiOauth:{accessToken,refreshToken,expiresAt,subscriptionType,…}}`）即可完整跑一个 turn；它会在该 dir 里创建 `.claude.json`、`projects/`、`sessions/`、`backups/` |
| E2 | codex-acp 只需 `CODEX_HOME=<dir>` 且 dir 里有 `auth.json`（`{auth_mode:"chatgpt"|…, OPENAI_API_KEY, tokens:{access_token,refresh_token,…}, last_refresh}`）即可；它会创建 `sessions/`、`thread_history_1.sqlite`、`cache/`、`skills/` 等 |
| E3 | 复制件跑过一轮后 token 未轮换，但 token 有过期时间，刷新迟早发生 → 复制件与源必然分叉。设计不得依赖"刷新不轮换" |
| E4 | 未登录：codex-acp `initialize.authMethods = [api-key, chat-gpt]`（`NO_BROWSER` 未设时）；claude-acp `authMethods: []`，`session/new` 成功，`session/prompt` 报 `-32000 Authentication required` |
| E5 | 无浏览器手段：`claude setup-token`（订阅，长效 token，环境变量 `CLAUDE_CODE_OAUTH_TOKEN`）；`codex login --with-access-token`（stdin）、`codex login status`。codex 0.153 无 device flow |
| E6 | 本机两个登录都是订阅登录（claude `subscriptionType:"max"`，codex `auth_mode:"chatgpt"`） |
| E7 | 会话文件在 home 里（claude `projects/`，codex `thread_history`）→ hibernate/wake/restart 必须复用同一个 home |

## 设计

### 凭据仓库（daemon）
- 路径 `<dataDir>/credentials/<tokenId>/<agentId>/<name>/`，目录 0700，文件 0600。`name` 默认 `default`。
- 三种输入：`{kind:"files", files:{"auth.json":…}}` / `{kind:"token", token}` / `{kind:"apiKey", apiKey}`。`token`/`apiKey` 形态落成描述符声明的环境变量（claude: `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY`；codex: `CODEX_API_KEY`），或描述符声明的文件形态。
- 按 `ownerTokenId` 归属；跨 token 引用 → `403 credential_forbidden`；admin 可 list 不可读内容。
- **secret 只上行**：任何响应/日志/快照/事件不含 secret；`fingerprint` = sha256 前 12 位。
- `PUT` 已存在的名字 = 原地更新，返回 `{workersAffected, restartRequired[]}`。
- `PUT`/内联凭据只接受 TLS 或 loopback 连接，否则 `403 insecure_transport`（M3 后续做 TLS，本包先按 `listen.host` 是否 loopback 判断，并留可配置开关 `credentials.allowInsecureTransport`）。

### Runtime 描述符新增
```ts
credentials?: {
  homeEnv: string;                       // "CLAUDE_CONFIG_DIR" | "CODEX_HOME"
  files: string[];                       // 凭据文件名，如 [".credentials.json"] / ["auth.json"]
  tokenEnv?: string;                     // "CLAUDE_CODE_OAUTH_TOKEN"
  apiKeyEnv?: string;                    // "ANTHROPIC_API_KEY" | "CODEX_API_KEY"
  reload: "file" | "restart";            // 换凭据后是否需要重启进程才生效（实测定）
  loginRequiredSignal: "authMethods" | "prompt_-32000";   // E4
}
```

### Home 隔离
- 每 worker `<dataDir>/homes/<workerId>/`（0700）；`catalog.toSpawnSpec` 设 `env[homeEnv]`。
- 凭据文件**软链**到仓库规范文件（POSIX）；Windows 硬链接，失败则复制 + 关闭时写回（fs.watch 可选）。刷新落回规范文件，所有 worker 共享最新 token。
- `createAgent({ home: "isolated" | "shared" })` 默认 `isolated`；home 随 worker 记录保留（E7），close + retention 后删除。
- `createAgent({ credential })`：省略 → 该 token 该 agent 的 `default`，没有则 `"inherit"`（M2 行为，继承 daemon 环境）；`"none"` → 空 home。
- 凭据环境变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`、`CODEX_API_KEY`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`）进 `createAgent({env})` 黑名单。
- `credentials.allowInherit`（daemon 配置，默认 true；M3 后续默认翻 false）。
- **创建时校验**：凭据缺失/过期 → `422 credential_required` / `credential_expired`，不要等第一个 prompt。

### 探测
- `ProbeSummary.login: {state:"ok"|"expired"|"required"|"unknown", method?, methods?, expiresAt?}`，按**当前 token** 计算；`GET /v1/agents` 暴露。
- 轻检查：文件存在 + `expiresAt`（claude）/ `codex login status`（codex）；`deep:true` 才发最小 prompt。

### worker.setCredential(cred, {apply})
- `apply: "auto"`（默认）：重指向链接（原子 rename）；描述符 `reload:"file"` → `immediate`；`"restart"` → 空闲立刻重启，`running`/`requires_action` 暂存本轮后重启 → `on-next-start`。`"restart"`：强制重启，running 且无 `force` → 409。`"defer"`：只重指向。
- 任何状态可调除 closed（410）；**lease 门控**；事件 `omni.credential{op:"set", fingerprint, applied, generation}`；快照 `credential{name,method,fingerprint}` + `stale`。
- 返回 `CredentialApplied{credential, applied, generation, previous}`。

### worker.restart(o)
- `{reason?, force?, resume?=true, fresh?, credential?, timeoutMs?}` → `RestartResult{generation, pid, resume: ResumeReport|{outcome:"fresh"}, sessionId, terminatedTurn, elapsedMs}`。
- 状态：`ready|requires_action → starting(reason:"restart") → ready`，`generation++`。**保留 lease、保留 home、计时器归零**。
- running 无 force → `409 worker_busy`；force → 该轮以 `omni.worker_state{starting, reason:"restart"}` 终止，**不合成 idle**，`TurnResult.stopReason:null, error.code:"restarted"`，在飞 tool call 进 `strandedToolCalls`。
- agent 不支持 resume 且未传 `fresh:true` → `422 not_resumable`；resume 失败按 M1 四态，`rejected_permanent` → 422，worker 留 `hibernated`。
- 复用 M1 的 reclaim + wake 路径，只加"保留 lease/home"两条例外。

### 线上协议
```
GET    /v1/credentials
PUT    /v1/credentials/{agent}/{name}         body CredentialInput → Summary(+workersAffected, restartRequired)
GET    /v1/credentials/{agent}/{name}
DELETE /v1/credentials/{agent}/{name}         inUseBy>0 → 409
POST   /v1/credentials/{agent}/{name}/check   {deep?} → LoginState
PUT    /v1/workers/{wid}/credential           {credential, apply?} → CredentialApplied
POST   /v1/workers/{wid}/restart              {…} → RestartResult
```
SDK：`server.credentials.{list,get,put,remove,check}`、`OmniACP.localCredential(agent)`（SDK 侧读本机 `~/.claude/.credentials.json` / `~/.codex/auth.json`）、`createAgent({credential, home})`、`worker.setCredential`、`worker.restart`、`server.agents()` 带 `login`。
CLI：`omni-acp credentials import|put|list|rm|check`。
错误码：`credential_required`(422)、`credential_expired`(422)、`credential_forbidden`(403)、`insecure_transport`(403)、turn error `restarted`。

### 验收
1. 隔离 home：两个 worker（claude-acp）各自 home，凭据软链同一规范文件；prompt 都成功；`homes/<wid>` 里出现 `projects/`，close+retention 后删除。
2. `credential:"none"` 的 claude worker 创建即 `422 credential_required`（不等 prompt）。
3. `server.credentials.put(localCredential)` → 新 worker 默认用它；`GET /v1/agents` 的 `login.state==="ok"`；响应体/日志/事件 grep 不到 token 字符串。
4. `worker.restart()`：claude-acp 与 codex-acp 各一次，`resume.outcome==="landed"`，重启后 prompt 能引用重启前的对话内容；`generation` +1；lease 持有者不变；SSE 订阅者 seq 连续。
5. `restart({force:true})` 打断 running turn：`TurnResult.error.code==="restarted"`，无合成 idle。
6. `setCredential`：`reload:"restart"` 的 agent 返回 `restarted`/`on-next-start`；跨 token 引用 403；事件不含 secret。
7. 仓库 PUT 更新 → `restartRequired` 列出链接到它的 worker。
8. 全套 `pnpm test` 绿；hermetic compat 绿；真机 compat（两个 agent）不退化。

---

## Real-agent record（2026-09-12，本机）

驱动脚本 `examples/m3-acceptance.mjs`（`node m3-acceptance.mjs claude|codex`）。它用
`createDaemon` 而不是 `OmniACP.local()` 起 daemon，只因为验收 6 需要两个脚本已知 secret 的 token，
而 `local()` 自己生成 secret 且只沿用第一个 token 的 ACL；其余全部走普通 SDK + 真 loopback HTTP。
prompt 都故意很短：每一条都是真订阅上的一个真 turn。

两个 agent 都是本机订阅登录（claude `subscriptionType:"max"`，codex `auth_mode:"chatgpt"`），
`~/.claude` 和 `~/.codex` 全程只读 —— 脚本通过 `OmniACP.localCredential()` 把内容复制进临时
`dataDir`，没有任何一条路径写回源。

### R1 — `credentials.reload`，实测（这是写进 `known.ts` 的那两个值）

实验：把凭据文件复制进私有 home，`homeEnv=<home>` 起进程，`initialize` + `session/new` + 一个
prompt 跑通（基线），然后**在进程活着的时候**把凭据文件覆盖成 `{"garbage":true}`，再发一个 prompt。
下一个 prompt 失败 ⇒ agent 每次请求都重读文件（`"file"`）；仍然成功 ⇒ 凭据在启动时被缓存进进程
（`"restart"`）。

| agent | 基线 | 换成 garbage 后的下一个 prompt | 判定 | 对照实验 |
|---|---|---|---|---|
| claude-acp 0.73.0 | `initialize` 1.21 s，`session/new` ok，prompt 1.59 s `end_turn` | **88 ms `-32000 Authentication required`** | **`reload: "file"`** | 不需要：失败本身就证明文件在被读 |
| codex-acp 1.8.0 | `initialize` 1.27 s，`session/new` ok，prompt 3.48 s `end_turn` | **2.06 s，仍然 `end_turn`** | **`reload: "restart"`** | **同一个 garbage 文件从一开始就在**：`session/new` 直接失败 `-32603 "plan type is required for chatgpt authentication"` —— 排除了"文件根本没被读"这个解释 |

对照实验是这张表里最重要的一行：没有它，codex 的"下一个 prompt 还是成功"可以被解释成凭据文件从来
没起作用。有了它，唯一剩下的解释就是进程缓存了凭据。

`setCredential` 的 `applied` 直接由这两个值决定，验收 6 实测到的正是这两条：claude `immediate`
（7–8 ms，不换进程），codex `restarted`（3.15 s，`generation 1→2`）。

### R2 — `loginRequiredSignal`：E4 被实测**推翻**了一半

同一轮实验，三种凭据状态各跑一次：

| agent | 无凭据文件 | garbage 凭据 | 正常凭据 |
|---|---|---|---|
| claude-acp | `authMethods: []`；`session/new` **成功**；`session/prompt` → `-32000` | 同左 | `authMethods: []`；全部成功 |
| codex-acp | `authMethods: [api-key]`；`session/new` → `-32000` | `authMethods: [api-key]`；`session/new` → `-32603 "plan type is required…"` | **`authMethods: [api-key]`**；全部成功 |

**E4 说 codex 未登录时 `authMethods = [api-key, chat-gpt]`，据此把非空 `authMethods` 当成"未登录"
信号。这条是错的**：codex 在**完全登录**的状态下（`NO_BROWSER=1`）依然回 `[api-key]`，所以这个数组
对登录状态一无所知，按它判断会把每一个健康的登录报成 `required`。

所以 `RuntimeCredentials.loginRequiredSignal` 的枚举从规范里的两个值变成三个：
`"prompt_-32000"`（claude：`session/new` 成功，只有 prompt 会拒）、`"session_new"`（codex：
`session/new` 自己就拒）、`"authMethods"`（保留了这个值但**没有任何 agent 在用**，理由写在
`runtime.ts` 那一行上）。这也是"轻检查读文件、不 handshake"的直接理由：在一个 agent 上证明登录要花
一个进程，在另一个上要花一个 prompt。

### R3 — 验收逐条（两个 agent，各跑两遍，第二遍就是下表）

| # | 项 | claude-acp | codex-acp |
|---|---|---|---|
| 1 | 隔离 home + 软链同一规范文件 + 都能 prompt | **pass**：create 1.80 s / 2.04 s，两个 home 各自 0700，两条软链都 → `<dataDir>/credentials/local/claude-acp/default/files/.credentials.json`，turn `ok`(1.49 s)/`ok`(1.62 s)。home 里出现 `projects/`、`sessions/`、`.claude.json`、`backups/`（E1 原话） | **pass**：create 1.47 s / 1.90 s，软链 → `…/codex-acp/default/files/auth.json`，turn `ok`(2.10 s)/`ok`(2.07 s)。home 里出现 `sessions/`、`thread_history_1.sqlite`、`cache/`、`skills/` 等 28 项（E2 原话） |
| 1b | close 后经 retention sweep 删除 | **pass**（`homeRetentionDays: 0` + 1.5 s sweep） | **pass** |
| 1c | close 时**保留**，post-mortem 还读得到 agent 自己的文件 | **pass**（`homeRetentionDays: 1`，跑满 3 个 sweep 周期后仍在：`.claude.json`/`.credentials.json`/`backups`/`sessions`） | **pass**（11 项仍在） |
| 2 | `credential:"none"` 创建即 422 | **pass**：`credential_required`，**9 ms**，`<dataDir>/homes` 全程为空 —— 没起进程 | **pass**：10 ms，同上 |
| 3 | `put(localCredential)` → 新 worker 默认用它；`login.state==="ok"`；grep 不到 token | **pass**：`login` `unknown → ok`，`method: files`，`fingerprint af939a95b112`，`expiresAt 2026-09-12T21:28:48.482Z`（put 17 ms）。`agents()` ⊕ `credentials.list()` ⊕ `get()` ⊕ `check()` 的 JSON 里 grep 509 字节的凭据原文：0 命中 | **pass**：`fingerprint 94d82959b9a3`，`expiresAt` 为 `null`（codex 的 `auth.json` 根本没有过期字段，只有 `last_refresh` —— 通用抽取器如实答 null 而不是猜）。grep 3883 字节原文：0 命中 |
| 4 | `restart()` resume 落地、能引用重启前内容、`generation+1`、lease 不变、seq 连续 | **pass**：`outcome landed` / `rule7:landed` / `session/resume`，restart **2.75 s**，pid 82561→83039，`generation 1→2`，lease holder 不变，sessionId 不变，seq `1..36` 无洞；重启后问"我让你记的词是什么" → **"lighthouse"** | **pass**：`landed`/`rule7`/`session/resume`，restart **3.17 s**，pid 67654→70127，seq `1..34` 无洞，回答 **"lighthouse"** |
| 5 | `restart({force:true})` 打断 running turn：`error.code==="restarted"`，无合成 idle | **pass**：不带 force 先拿到 `worker_busy`；force 后 2.04 s 返回，`TurnResult.stopReason: null`、`error.code: "restarted"`、`verdict: failed`，该 turn 的 `state_update{idle}` envelope **0 个**，`terminatedTurn` 与 `TurnResult.turnId` 一致，重启前已产出的 50 字节文本仍在投影里 | **pass**：force 1.15 s，同样 `restarted` / 无合成 idle。文本 0 字节（codex 在被打断前还没吐出内容），`strandedToolCalls` 两个 agent 都是 `[]` —— 这两个 prompt 都没开工具 |
| 5b | 重启后 worker 还能接 prompt | **pass**：`ok` / `end_turn` | **pass** |
| 6 | `setCredential` 的 `applied` 诚实；跨 token 403；事件里没有 secret | **pass**：`applied: "immediate"`（7 ms，不换进程，`generation` 停在 1）—— 正是 R1 测出的 `reload:"file"`；跨 token 引用 → `403 credential_forbidden`（"credential \"theirs\" is not available to this token"）；`omni.credential` envelope 恰好 1 条，整条 SSE 流 grep 凭据原文 0 命中 | **pass**：`applied: "restarted"`（3.15 s，`generation 1→2`）—— 正是 `reload:"restart"`；403 与 grep 同上 |
| 7 | 仓库 PUT 更新 → `restartRequired` 列出链到它的 worker | **pass**：`workersAffected: 1`，`restartRequired: []` —— 对这个 runtime 这是**正确答案**而不是缺口：`reload:"file"`，软链已经指向刚改的文件，下一个请求就生效，重启它纯属白付一次冷启动 | **pass**：`workersAffected: 1`，`restartRequired: [w_01M2BESK32MJJB5KRZFWH5KTKQ]` —— `reload:"restart"`，那个进程会一直用旧凭据直到被换掉 |
| 8 | 全套 `pnpm test` 绿；hermetic compat 绿；真机 compat 不退化 | 见下 | 见下 |

两处如实记录的弱点，都在脚本可控范围之外：

- **验收 6 的 `fingerprint` 前后相同**（`af939a95b112` → `af939a95b112`）。`rotated` 存的是**同一份**
  本机登录，而 fingerprint 是内容的 sha256，所以两者本该相等。指纹**变化**的证据在
  `store.test.ts`（"different content ⇒ different fingerprint"）和 itest 验收 6（两份不同内容的凭据，
  软链真的挪了、`readFile` 读到的是新内容）。这里能证明的是 `applied` 与 `reload` 相符、审计线恰好一条、
  以及流里没有 secret —— 而那三条才是这一项的主题。
- **1c 的 codex home 里没有 `sessions/`**。这一项故意不发 prompt（handshake 就足以让 agent 写自己的
  文件，而一个 turn 要花 token 换不到新证据），而 codex 是在第一个 thread 之后才写 `sessions/`。
  断言是"close 后 home 非空且 agent 自己的文件还在"，11 项都在。

### R4 — 这一轮真机跑出来的两个 bug

都不是测试脚本的问题，都已修并带回归：

1. **home retention sweep 会回收正在创建的 worker 的 home**（commit `b01d088`）。home 在 spawn
   **之前**建好，而 worker 要到 handshake 返回才进 registry —— 于是在整个 ~7 s `npx` 冷启动期间，磁盘上
   有一个没有任何 row 的 home，和一个孤儿在检查上无法区分。第一版 sweep 把"没有 row"读成"孤儿"，
   于是删掉了一个**活着**的 worker 的凭据软链；从外面看就是一个 claude-acp worker 认证成功一次之后
   再也认证不了，日志上没有任何东西把两件事连起来。修法是把孤儿集合在 `createDaemon` 里**只取一次**
   （boot adoption 之后、`start()` 之前，也就是唯一一个不可能有 worker 正在创建的时刻），而不是加一个
   宽限期 —— 这两个 agent 的冷启动本身就从 1.5 s 抖到 >90 s，任何时间常数都是猜。
   顺带修掉同一处的第二个洞：sweep 的 `keep` 现在是**活 fleet ∪ 持久化 row** 的并集，因为
   `eventLog.driver:"memory"`（`createDaemon()` 的默认）下根本没有 row，只读 store 会得到空 `keep`，
   于是每一个运行中的 worker 的 home 都是可删的。
2. **`home:"shared"` + `files` 凭据会静默继承 daemon 自己的环境**（commit `c9c98d6`）。file 凭据只能
   通过 home 到达 agent（E1/E2），所以这个请求要求"用这份凭据"同时要求"唯一能送到的通道不存在"。
   静默回退等于交还一个**以别人身份认证**的 worker 且什么都不说 —— 正是 M2-R12 对 env key 已经拒绝过的
   静默降级。现在是 `bad_request`，消息指向 `home:"isolated"`。
   同一个 commit 还改了 `credential:"none"`：它原先会真的起一个空 home 的 worker，而验收 2 要的是
   **创建即 422**；拒绝放在创建时校验里而不是 store 里，`"none"` 因此仍然是"空 home"的意思，这也是它
   还能通过 `setCredential` 吊销一个活 worker 凭据的原因。

### R5 — 套件计数（8 的那三行）

| 套件 | 结果 |
|---|---|
| `pnpm test`（全仓库，含 unit + itest + hermetic compat） | **229 files / 3403 passed / 166 skipped，0 failed** |
| 其中 M3-WP1 新增 unit | daemon `test/credentials/` **63**（store 25 · home 16 · env 组合 7 · secret-never-leaks 2，以及既有套件里的增量）、core `test/worker/restart.test.ts` **23**、cli `test/m3-commands.test.ts` **13** |
| 其中 M3-WP1 新增 itest | `tests/integration/src/credentials.itest.ts` **10**（验收 1·2·3·4·5·6·7 + `home:"shared"`/inherit 的 M2 兼容性） |
| hermetic compat | **118 passed / 160 skipped**。新 case `restart-resumes` 在 9 个 hermetic agent 上是**带出处的 `capability` skip**（`reason: "the probe reports no resume spelling for this runtime"`），在 `fixture-hybrid` 上 **passed**(920 ms) —— 那是唯一实现了真 resume 的 fixture |
| 真机 compat（两个 agent） | 见 R6 |

### R6 — 真机 compat（`OMNI_COMPAT_CONFIG=agents.local.yaml OMNI_COMPAT_REAL=1`）

`restart-resumes` 是这一包新增的那一个 case，其余全部是 M1/M2 的 case，跑在这里就是为了证明**不退化**。

```
OMNI_COMPAT_CONFIG=agents.local.yaml OMNI_COMPAT_REAL=1 OMNI_COMPAT_REQUIRE=1 vitest run
→ 2 files · 56 passed · 10 skipped · 0 failed · 335 s
```

| agent | passed | skipped | failed | `restart-resumes` |
|---|---|---|---|---|
| claude-acp 0.73.0 | **27** | 4 | **0** | **passed**（12.39 s） |
| codex-acp 1.8.0 | **21** | 6 | **0** | **passed**（15.54 s） |

十个 skip 全部带出处和理由，而且**全部是 M1/M2 已有的语料缺口，没有一个来自这一包**：

| agent | case | source | 理由 |
|---|---|---|---|
| claude | `plan-update` | config | 这个 build 没有 todo/plan 工具；两次刻意尝试都没产出 `plan`（语料 05/05b） |
| claude | `agent-thought` | config | 默认 effort 下不发（语料） |
| claude | `current-mode-update` | config | `session/set_mode` 回的是 v2 `config_option_update`（语料 08） |
| claude | `git-patch-from-diff-blocks` | config | v1 `diff` 块是被放宽的片段，从它重建 patch 属于厂商扩展（F19）；D8 的 provider 读磁盘，那一项由 `patch-git` 断言（它 passed） |
| codex | `permission-deny` | config | codex-acp 1.8.0 在任何模式下（含 read-only、含工作区外路径）都自动批准文件写入，从不发 `request_permission`（2026-09-04 探测） |
| codex | `elicitation-gated` / `elicitation-answer` / `interaction-park-timeout` | capability | `elicitation` 在这个 runtime 的 `unverified` 里（§17.2） |
| codex | `permission-hard-rules` / `permission-allow` | capability | `permission` 在这个 runtime 的 `unverified` 里（§17.2） |

`restart-resumes` 在 hermetic 套件里的表现是同一条规则的另一半：9 个 hermetic agent 上是带出处的
`capability` skip（`"the probe reports no resume spelling for this runtime"`），只有
`fixture-hybrid`（唯一实现了真 resume 的 fixture）passed。skip 的**来源是 probe 测出来的
`resumeMethod`**，不是 YAML 里的一句声明 —— 这也是为什么它对一个从没声称过这个能力的 runtime 不是失败。

### R7 — 规范里没能按原文做到的两处

1. **`RuntimeCredentials.loginRequiredSignal` 的枚举多了一个值。** 规范钉的是
   `"authMethods" | "prompt_-32000"` 两个；实测（R2）证明 codex 在**完全登录**时也回非空
   `authMethods`，按 E4 那条判断会把每一个健康登录报成 `required`。所以加了第三个值
   `"session_new"`，`"authMethods"` 保留在枚举里但**没有任何 agent 在用**，理由写在 `runtime.ts`
   的那一行上。这是规范的**事实前提**被实测推翻，不是设计取舍。
2. **`home:"shared"` 配 `files` 凭据被拒绝，规范没有这一条。** 规范只说 `home: "isolated" |
   "shared"`，没说两者与三种凭据形态的组合。file 凭据只能经 home 到达 agent（E1/E2），所以
   `shared` + `files` 是一个自相矛盾的请求；itest 第一版按规范字面实现（静默回退到继承环境），
   于是交还了一个**以 daemon 自己的身份认证**的 worker 且什么都不说 —— 正是 M2-R12 对 env key
   已经拒掉的静默降级。现在是 `bad_request` 并指向 `home:"isolated"`；`token`/`apiKey` 形态在
   shared home 上照常工作，因为它们落在环境变量里、不需要目录。
