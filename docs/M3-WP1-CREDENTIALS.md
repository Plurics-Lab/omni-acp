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
