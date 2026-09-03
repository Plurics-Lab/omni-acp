# 调研：multica 的 agent 适配层 & ACP registry 的 v2 覆盖率

> 2026-09-03 · 代码版本：multica `main`（shallow clone 当日）、`@agentclientprotocol/sdk` 1.4.0、registry.json v1.0.0（39 个 agent）

---

## 一、multica：核对 + 补充

原调研结论基本都能在代码里对上。下面只记录**核对到的关键行号**和**原调研没提、但对 omni-acp 有直接影响的点**。

### 1.1 核对结果

| 断言 | 结论 | 证据 |
|---|---|---|
| Backend 只有一个 `Execute` 方法 | ✓ | `agent.go:18` |
| ExecOptions「读不懂就跳过」契约 | ✓ | `agent.go` 注释：*"ExtraArgs is honoured only by backends that opt in by reading it; the rest ignore it."* |
| 11 个 ACP 后端共用 `hermesClient` | ✓ | `grep hermesClient` |
| `streamingCurrentTurn` 门 | ✓ | `hermes.go:366-405`，`649` 打开，`733` 关闭 |
| mcpCapabilities 过滤 | ✓ | `hermes.go:492`；另有 `acpRuntimesToleratingOmittedMcpCapabilities` 白名单容忍不声明的 runtime（hermes 0.18.2） |
| set_model 失败 fail task / set_options 失败只 warn | ✓ | `hermes.go:595`, `acp_effort.go` |
| 进程构造单一入口 | ✓ | `launch.go:112` `Command.exec` → `newRuntimeCmd`，测试 `TestOnlyLaunchGoSpawnsRuntimeProcesses` |
| Windows 用 Job Object | ✓ | `proc_windows.go` `ownedProcessTree{job windows.Handle}` |
| 500ms 批量 flush / seq 调用方持有 | ✓ | `daemon.go:8785` |
| idle watchdog 双预算 | ✓ | `daemon.go:9073 runIdleWatchdog`：tool in flight 时切 `toolWindow`，且要求 `len(messages)==0` |

### 1.2 原调研没提、但很重要的事实

**(a) multica 对所有 ACP agent 说的是 v1，且 `clientCapabilities: {}`。**

```go
// hermes.go:472
"protocolVersion": 1,
"clientCapabilities": map[string]any{},
```

只有 `kimi.go:228` 声明了 `"terminal": true`。**整个代码库没有任何 `fs/read_text_file` / `fs/write_text_file` 实现**——11 个 ACP runtime 在没有 client fs 能力的情况下全部正常工作（agent 自己读写磁盘）。

**(b) 现实中的 ACP = v1 + 厂商扩展方法。** multica 必须支持的非标准方法：

| 方法 | 在 v1 schema | 在 v2 schema | 谁用 |
|---|---|---|---|
| `session/set_model` | ✗ | ✗ | hermes / kimi / kiro / grok / dim / qoder / reasonix / traecli（8 个） |
| `session/set_options` | ✗ | ✗ | hermes |
| `session/notification` | ✗ | ✗ | 作为 `session/update` 的别名被接受（`hermes.go:1568`） |
| `_meta.hermes.sessionProvenance` | — | — | 判断 resume 是否落到了请求的 session |

标准方法里 `session/set_config_option`（v1 已稳定）只有 dim / kimi 和 effort 辅助在用。

**(c) 权限自动选择的规则**（`selectACPPermissionOption`，`hermes.go:1310`）——是踩坑后的产物（GH #5300）：

1. 已知的 session 级 grant id（`allow_session` / `approve_for_session`）且 kind 是 grant 类 → 选它
2. 任意 `kind == allow_once` → 选它（单次授权与 optionId 无关，天然安全）
3. 没有安全 grant → 选 offered 的 `reject_once`（只拒这一个动作）
4. 都没有 → 返回 JSON-RPC error `-32603`

三条硬规则：**永不选 `allow_always`**（在 Hermes 上会持久化到 runtime 所有者的磁盘 allowlist，寿命超过任务）；**永不回 `cancelled`**（会取消整个 prompt turn，不是这一个动作）；**永不编造 optionId**；未知 kind 一律视为非 grant（fail closed）。

**(d) 未知的 agent→client 方法回 `-32601 method not found`**，而不是沉默——否则 agent 会一直等。

**(e) `acp_terminal.go`（298 行）是一份完整的 terminal/* 参考实现**：
- 默认 `outputByteLimit = 50_000`；用 Writer 做尾部环形截断，截断点向前推到 `utf8.RuneStart`
- `snapshot()` 额外隐藏末尾未完整的多字节 rune，并 `ToValidUTF8`
- `kill()` = SIGKILL 进程组 + `waitProcessGroupGone(2s)`，超时返回 error（不假装成功）
- `release()` 只在 kill 确认成功后才从 map 删除——失败可重试
- exitStatus 二选一：`{exitCode}` 或 `{signal}`
- 无 args 时 POSIX 走 `/bin/sh -c`，Windows 走 `cmd.exe /d /s /c`

**(f) resume 失败的三态判定**（`agent.go:208-243`）：
- `ResumeRejected`：确证永久不可用（transcript 没了 / 属于别的账号 / 历史无法重放）
- `ResumeRejectedTransient`：现在不行但 session 健康，本轮用新 session，**不要**把旧指针作废
- 两者都 false：对 `ResumeRejectionUndetectable` 名单里的后端 = 测不出来；其他 = 检查过不是拒绝
- **禁止**把网络 / 限流 / 配额 / 5xx / auth 错误标成 rejected

判定手段：`isACPSessionNotFound`（错误码 -32603/-32602/-32002/-32000 + 文本含 "session not found|no session found|unknown session"）；`hermesResumeSessionLost = resumeSessionID != "" && stopReason == "refusal" && turnActivity == 0`。Hermes 对未知 session 的 resume 会**静默新建**，只能读 `_meta` 才知道。

**(g) v1 的 turn 边界是模糊的**：`session/prompt` 返回后还会有 `session/update` 到达（`waitForHermesNotificationQuiescence`，`hermes.go:817`）。他们的收尾顺序是：等静默窗口 → 先关 stdin 让 agent 看到 EOF → 带 grace 等 stdout/stderr 排空 → 才 cancel。直接在 prompt 响应处 cancel 会丢最后一段回答。

**(h) stopReason=end_turn 不等于成功**：上游 429 / token 过期时 Hermes 仍报 end_turn，靠 stderr sniffer 把状态提升为 failed（`promoteACPResultOnProviderError`）。

### 1.3 对 omni-acp 设计的影响

| # | 影响 | 落到哪个决策 |
|---|---|---|
| L1 | Normalizer 必须**透传未知方法和 `_meta`**（proxy-chains 规则），且 Agent Catalog 需要一张「runtime 特性表」承载 `set_model` 之类的厂商扩展和 quirk（对应 multica 的 BuiltinRuntime 描述符） | D3 / §7 |
| L2 | **Client Host 默认只做 terminal，fs/* 做成按 agent opt-in**。multica 的实证：不实现 fs/* 完全可用。M1 工作量砍掉一半 | D3 / M1 |
| L3 | D4 的 `deny` 实现细节照抄 1.2(c)：只选 offered 的 optionId、优先 `reject_once`、永不 `allow_always`、永不 `cancelled`、兜底 `-32603` | D4 |
| L4 | v1 `session/load` 会全量重放历史为 `session/update`。daemon 用 D6 的 Event Log 已有历史 → 重放期间的 update **打 `replay: true` 标记或直接丢弃**，不能当成当前 turn | D6 / Normalizer |
| L5 | 合成 v2 `state_update{idle}` 的时机不是 prompt 响应返回，而是响应后 + 静默窗口 + 管道排空 | Normalizer |
| L6 | D2 补充 resume 结果枚举：`landed / rejected_permanent / rejected_transient / unknown`；网络 / auth / 429 永不算 rejected | D2 |
| L7 | Supervisor：单一 spawn 入口（用测试强制）、构造时就设进程组 / Job Object、Cancel = 杀整组、优雅退出（SIGTERM → grace → SIGKILL）作为可覆盖项 | §7 |
| L8 | Run 层加 idle watchdog，且 tool in flight 时切更大预算。ACP 的 `tool_call_update.status` 让 in-flight 计数比 multica 更精确 | L3 API |
| L9 | 不要归一化 effort / model 值；v2 `configOptions` 原样透出 | SDK L2 |
| L10 | preset 解析成真实 mcpServers 之后，还要按 `initialize` 返回的 mcpCapabilities 过滤 http/sse 条目，否则 `session/new` 整个被拒 | §8 |
| L11 | 「稳定上下文写文件 + 每轮 prompt 走 RPC」的双通道值得作为 Run 层可选功能（`contextFiles` + marker 块 + 逐字节还原） | L3 API（可选） |

---

## 二、ACP registry 的 v2 覆盖率

### 2.1 方法

registry.json（`cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，v1.0.0，39 个 agent，`extensions: []`）**不声明协议版本**。所以做了静态扫描：

- **npx 分发（19 个）**：从 npm 拉 tarball，grep 所有 js/ts/json
- **uvx 分发（2 个）**：PyPI
- **binary 分发（18 个）**：下载 linux-x86_64 归档（共约 1.3 GB），对解包后的字节流做正则

**判定标记的校准**——先用 SDK 1.4.0 自带的两份 schema 算出哪些 token 是 v2 独有的：

| token | v1 schema | v2 schema | 结论 |
|---|---|---|---|
| `tool_call_content_chunk` | 0 | 2 | **v2 独有** |
| `terminal_output_chunk` | 0 | 2 | **v2 独有** |
| `state_update` | 0 | 2 | v2 独有，但作为普通单词噪声大（OpenAI Assistants 也有 `requires_action`） |
| `auth/login` | 0 | 2 | v2 词汇，**但** Rust SDK 有独立的 `unstable_auth_methods` 特性，v1 agent 也可能带 |
| `session/fork` `plan_removed` `compaction_summary_chunk` `session/resume` | 有 | 有 | 噪声，v1 unstable 就有 |
| `agentCapabilities` `clientCapabilities` `loadSession` `session/load` `"authenticate"` `session/set_mode` | 有 | **0** | **v1 独有** |

所以决定性证据是：`PROTOCOL_VERSION = 1/2` 字面量、v1 独有词汇的存在、以及 `tool_call_content_chunk` / `terminal_output_chunk` 的存在。

### 2.2 结果：**0 / 39 有 v2 证据**

`tool_call_content_chunk` 和 `terminal_output_chunk` 在**全部**可读的包和二进制里命中次数为 **0**。每一个能读到字符串的 agent 都带 v1 独有词汇。

**可判定为 v1（28 个）**

| agent | 分发 | 决定性证据 |
|---|---|---|
| claude-acp 0.73.0（Zed 官方） | npx，sdk 1.4.0 | 源码硬编码 `protocolVersion: 1` |
| codex-acp 1.8.0（Zed 官方） | npx，sdk ^1.4.0 | bundle 内 `var PROTOCOL_VERSION = 1`（SDK v1 入口的常量；v2 入口是 `= 2`） |
| gemini 0.58.0 | npx | `var PROTOCOL_VERSION = 1` |
| qwen-code 0.23.0 | npx | `var ACP_PROTOCOL_VERSION = 1` |
| codebuddy-code 2.143.1 | npx | `protocolVersion:1`、`PROTOCOL_VERSION=1` |
| auggie 0.36.0 | npx | `session/load` `authenticate` `agentCapabilities` `session/set_mode` |
| dirac 0.5.5 | npx，sdk 1.3.0 | `protocolVersion: 1` + `agentCapabilities.loadSession` |
| nova、qoder、agoragentic-acp | npx | v1 独有词汇 |
| pi-acp、autohand、deepagents、glm-acp-agent | npx | 依赖 sdk 0.26 / 0.12 / 0.17 / 0.20（v2 入口自 0.27 才有） |
| amp-acp | binary（ts-sdk 1.2.1） | `protocolVersion: 1` + v1 词汇 |
| opencode | binary | `clientCapabilities: {fs:{readTextFile, writeTextFile}, terminal}` 的 v1 形状 + `authenticate` |
| kilo、cortex-code、goose、harn | binary | v1 词汇完整；`state_update`/`requires_action` 命中是通用词 |
| cursor、poolside、junie | binary | v1 词汇 + `auth/login`（unstable auth-methods RFD，非 v2） |
| devin、sigit、corust-agent、stakpak、vtcode | binary（Rust） | 嵌入 crate 版本 1.0.0 / 1.3.0 / 0.9.5 / 0.9.3 / 0.10.4，v2 仅在 crate 2.0.0 的 `unstable_protocol_v2` 特性里 |

**无法静态判定（11 个）**

| agent | 原因 |
|---|---|
| kimi、crow-cli、mistral-vibe | 二进制被压缩/打包（PyInstaller 类），字符串不可见。kimi 由 multica 以 v1 实测可用 |
| antigravity-acp | 518 MB，跳过 |
| cline、dimcode、factory-droid、github-copilot-cli、grok-build | npm 包是安装时下载二进制的空壳 |
| fast-agent、minion-code | Python；Python SDK 0.12.1 的 `PROTOCOL_VERSION = 1`，无 v2 → 事实上 v1 |

### 2.3 SDK 侧的 v2 状态

| SDK | 版本 | v2 |
|---|---|---|
| TypeScript `@agentclientprotocol/sdk` | 1.4.0 | `./experimental/v2` 入口（`PROTOCOL_VERSION = 2`），`schema/v2/schema.unstable.json` 随包发布 |
| Rust `agent-client-protocol` | 2.0.0（2026-07-23） | feature `unstable_protocol_v2`，默认关闭 |
| Python `agent-client-protocol` | 0.12.1（2026-08-16） | 无，`PROTOCOL_VERSION = 1` |

v2 草案公告日期 2026-07-20，官方原话：*"gate your implementation behind the version negotiation AND feature flags. Don't ship it by default in production until we are closer to stabilization"*。六周后 registry 里没有任何 agent 这么做，符合预期。

### 2.4 顺带发现

**(a) TS SDK 1.4.0 已经带了官方的远程传输实现。** `package.json` exports：

```
./experimental/http-client   createHttpStream(serverUrl, {headers, cookies, cookieStore})
./experimental/ws-client     createWebSocketStream(serverUrl, ...)
./experimental/server        class AcpServer { handleRequest(req: Request); prepareWebSocketUpgrade(); close() }
./experimental/node          createNodeHttpHandler(server) / createNodeWebSocketUpgradeHandler(server, wss)
```

`AcpServer`（`dist/server.js`，385 行）实现的就是 streamable-HTTP RFD：`Acp-Connection-Id` / `Acp-Session-Id` header、非 initialize 的 POST 回 202、GET `text/event-stream` 分 connection-scoped / session-scoped 流、batch 回 501、`initialize` 同步返回 200 + header。构造参数是一个 `AgentConnector { connect(stream) }`——任何能接一条 `WireStream` 的东西都能挂上，包括「把流泵到子进程 stdio」的 connector。

它**没有**的东西正好是 omni-acp 的增值面：每条流只允许一个接收者（第二个 GET 回 409）、没有重放、连接注册表纯内存、没有认证、路由里仍按 v1 的 `session/load` 分流。

**(b) codebuddy-code 自带一个 HTTP ACP bridge**（`POST /api/v1/acp` + SSE，返回 connectionId）。是「远程 ACP」的一个先行实现，可作对照。

### 2.5 对 omni-acp 设计的影响

| # | 影响 | 落到哪 |
|---|---|---|
| R1 | **M0「只支持 v2 agent」不可行——没有 v2 agent 可测。** 应改为 M0 先接 v1 agent（claude-acp / codex-acp / gemini 三个最主流），v2 适配放到有真实 v2 agent 出现之后，或用 SDK 自带的 v2 example agent 做合成测试 | M0 / M1 顺序 |
| R2 | D1「规范表示 = v2」仍然成立（这是内部表示的选择，不依赖 agent 支持 v2），但 Normalizer 的 **v1→v2 方向是当前唯一有生产流量的方向**，v2→v1 方向可以延后 | D1 / M1 |
| R3 | **M4 的成本大幅下降**：数据面可以直接用 `AcpServer` + 自定义 `AgentConnector`，omni-acp 在外面包认证、重放、多接收者。甚至可以考虑 M0 就用它当「原始 ACP 透传」端点，自定义协议只做控制面 | M4 → 可能提前；R6 决策值得重审 |
| R4 | 能力探测（`/v1/agents/{id}/probe`）必须记录 `protocolVersion` 协商结果 **和厂商扩展方法**（`session/set_model` 等），并暴露给客户端 | §7 |
| R5 | D7 的 compat 套件：现阶段的回归目标就是 claude-acp / codex-acp / gemini / opencode / kimi 这五个 v1 agent | D7 |

---

## 三、"agent 自带 fs / terminal，daemon 不实现" 是否可行

结论：**可行，而且是规范鼓励的路径**。

| 证据 | 内容 |
|---|---|
| ACP v1 spec（file-system） | *"Agents MUST verify that the Client supports these capabilities by checking the Client Capabilities field."* / *"If either readTextFile or writeTextFile is false or missing, the Agent MUST NOT attempt to call the corresponding filesystem method."* 目的："access unsaved editor state and allow Clients to track file modifications" |
| ACP v1 spec（terminals） | 同样：Agents must verify `terminal: true` before any terminal call |
| gemini-cli 0.58.0 | `if (this.clientCapabilities?.fs) { config.setFileSystemService(new AcpFileSystemService(...)) }`；否则用 `StandardFileSystemService`（`node:fs/promises`） |
| claude-acp 0.73.0 | 工具集 `{ type: "preset", preset: "claude_code" }`（Claude Code 自带 Read / Write / Edit / Bash）；`readTextFile` / `writeTextFile` 只出现在 client 代理类里（8 处），未见按能力切换工具的分支；无 `terminal/create` 调用 |
| codex-acp 1.8.0 | 解析 `clientCapabilities` 时默认 `fs: {readTextFile:false, writeTextFile:false}, terminal: false` |
| multica | hermes / kiro 等 11 个 ACP runtime `clientCapabilities: {}`；只有 kimi 开 `terminal: true`，`hermesClient.terminalEnabled` 注释："only set for ACP runtimes whose client-side terminal calls are implemented… avoids advertising a capability to Hermes-family runtimes that do not need it" —— 是为了让 daemon 持有 shell 进程，不是 kimi 缺功能 |
| ACP v2 | 两组方法已删除，"agent 自带"是唯一模型 |

代价与缓解见 DESIGN.md D3。
