# omni-acp 设计文档

> 状态：草案 v0.8 · 2026-09-03
> 变更：v0.4 以 **Worker** 为用户面的核心对象重写了 §3 / §5 / §9 / §11 与 D12——SDK 主路径走自定义 `/v1/workers`，官方 `/acp/{agentId}` 降为可选兼容门。v0.3 合并了 [multica 与 registry 调研](research/2026-09-03-multica-and-registry.md) 的结论——M0 目标改为 v1 agent；数据面改用官方 `AcpServer`；Client Host 收窄为 terminal 必做 / fs 可选；resume 四态；权限 deny 的实现规则。

## 0. 项目定位

omni-acp 是一个**开源的 ACP 远程化与多 agent 管理层**。

- **Daemon**：部署在目标物理机（Windows / macOS / Linux）上，管理该机器上所有 ACP agent 的进程、会话与权限，对外暴露 HTTP 接口。**它首先是一个库**（`@omni-acp/daemon`，`createDaemon()`），CLI 只是它的一个壳（D15）。
- **Client SDK**：用户在自己的项目里引入，连接到一个或多个 daemon，管理和调用其上的 agent。

它**不是**产品化的 CI 系统、不是 IDE、不是 agent 本身。它是让"ACP agent 跑在别的机器上"这件事变得简单、安全、可编程的那一层。

### 非目标

- 不内置 git clone / PR 创建 / forge 集成 —— 提供扩展点，由使用者实现
- 不内置容器编排 —— daemon 可以被装进容器，但不负责为每个 run 起容器
- 不做多租户计费、配额市场
- 不实现 agent 本身的能力（模型调用、工具执行都归 agent）
- daemon 之间不做联邦（见 D11）

---

## 1. 背景：ACP 现状（2026-09-03 实地考察）

### 1.1 协议双版本并存，但生产中只有 v1

ACP **v1 稳定、v2 草案**（2026-07-20 公告）。官方要求两者长期共存，并明确说 v2 "don't ship it by default in production until we are closer to stabilization"。

对 registry 全部 39 个 agent 做静态扫描的结果：**0 个有 v2 证据，28 个确证 v1，11 个无法判定**。Zed 自己的 `claude-acp` 源码硬编码 `protocolVersion: 1`，`codex-acp` / gemini / qwen / codebuddy 的 bundle 里都是 `PROTOCOL_VERSION = 1`。SDK 侧：TS 1.4.0 有 `experimental/v2`，Rust 2.0.0 有 `unstable_protocol_v2` 特性，Python 无。

**结论：omni-acp 的第一批真实流量全部是 v1。** v2 是内部表示的选择（见 D1），不是对 agent 的假设。

### 1.2 v2 对本项目有决定性的三个变化

**(a) `fs/*` 与 `terminal/*` 从协议中删除。** v2 的 Agent→Client 回调只剩 `session/request_permission` 和 `elicitation/create`——低频、容忍网络延迟。而且 multica 的实证表明**即使在 v1 下不实现 `fs/*`，11 个 ACP runtime 也全部正常工作**（agent 自己读写磁盘）。

**(b) prompt 生命周期从"长挂请求"改成"异步事件"。**

| | v1 | v2 |
|---|---|---|
| `session/prompt` 返回时机 | 整个 turn 结束 | 立即返回 `{}` |
| turn 结束信号 | 响应体 `{stopReason}` | `session/update` → `state_update{state:"idle", stopReason}` |
| 中间状态 | 无 | `running` / `requires_action` / `idle` |
| 用量与成本 | 无 | `usage_update{used, size, cost}` |

**(c) 更新语义统一为 patch。** `tool_call_update` 首次出现即创建；`user_message` / `agent_message` / `agent_thought` 三态 patch（省略=不变，`null`/`[]`=清空，数组=替换）；`*_chunk` 追加。

### 1.3 现实中的 ACP = v1 + 厂商扩展

multica 为了挂住 11 个 ACP runtime 必须支持的**非标准方法**（v1、v2 schema 里都没有）：`session/set_model`（8 个 runtime）、`session/set_options`、`session/notification`（作为 `session/update` 别名）、`_meta.hermes.sessionProvenance`。Proxy-chains RFD 的规则——不认识的方法转发、保留 `_meta`——在这里是生存必需，不是锦上添花。

### 1.4 官方 TS SDK 1.4.0 已经带了远程传输实现

```
@agentclientprotocol/sdk/experimental/server        class AcpServer { handleRequest(Request); prepareWebSocketUpgrade() }
@agentclientprotocol/sdk/experimental/node          createNodeHttpHandler / createNodeWebSocketUpgradeHandler
@agentclientprotocol/sdk/experimental/http-client   createHttpStream(url, {headers, cookies})
@agentclientprotocol/sdk/experimental/ws-client     createWebSocketStream(url, ...)
```

`AcpServer` 实现的就是 streamable-HTTP RFD：`Acp-Connection-Id` / `Acp-Session-Id`、非 initialize 的 POST 回 202、GET SSE 分 connection-scoped / session-scoped 流、batch 回 501。构造参数是 `AgentConnector { connect(stream) }`——任何能接一条 `WireStream` 的对象都能挂上。

它**没有**的：每条流只允许一个接收者（第二个 GET 回 409）、没有重放、连接注册表纯内存、没有认证。**这些正好是 omni-acp 的增值面。**

### 1.5 其他可复用的官方资产

- **Agent Registry**：`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`，39 个 agent，声明 npx / uvx / binary 分发方式，**不声明协议版本**。
- **Proxy Chains RFD**：`proxy/initialize`、`proxy/successor`、未知方法必转发、`_meta` 必保留。

---

## 2. 已确认的需求

| # | 决定 |
|---|---|
| R1 | client / server 分离；server 是装在目标机上的常驻 daemon |
| R2 | daemon 管理该机器上的所有 agent（发现、安装、启动、监督、能力探测） |
| R3 | 跨平台：Windows / macOS / Linux |
| R4 | workspace 在**服务器**上 |
| R5 | 同时支持 ACP v1 和 v2，daemon 做版本适配 |
| R6 | ~~线上协议先自定义，后加官方兼容层~~ → **v0.3 改为：数据面直接用官方 transport，控制面自定义**（见 D12） |
| R7 | 结果交付：事件流（SSE）+ webhook |
| R8 | 权限无法自动决策时按 run 参数 `park / deny / fail` |
| R9 | 分发：npm 全局包 |
| R10 | 通用基础设施；自动化编排是主要场景之一 |
| R11 | 一个客户端会同时连多台 daemon |
| R12 | **第一批目标 agent 是 v1**：claude-acp / codex-acp / gemini / opencode / kimi |

---

## 3. 总体架构

### 3.1 核心对象：Worker

用户面唯一需要理解的对象。**一个 Worker = 一个 agent 子进程 + 该进程里的一个 ACP session。** `createAgent("claude-acp")` 调两次 = 两个进程、两个 worker，互不相干。

```
worker.state:  starting → ready ⇄ running ⇄ requires_action → hibernated → closed
                                                    │              │
                             有 InteractionRequest 待人回答      idle 超时，进程回收、session 保留；
                                                                下次 prompt 时重新 spawn + resume
```

内部仍然是 ACP 的 process / session 两层，但对外只暴露 worker。`sessionId` 作为 ACP 层 id 附带返回，供 `/acp` 兼容门和调试用。

### 3.2 Worker 生命周期

| 迁移 | 触发 | 说明 |
|---|---|---|
| — → `starting` | `POST /v1/workers` | spawn → `initialize` → `session/new` |
| `starting` → `ready` | 握手成功 | 返回 201，`capabilities` 为真实握手结果 |
| `starting` → `closed` | 握手失败 / 超时 | 502 / 504，进程组回收 |
| `ready` → `running` | `prompt` | 返回 202 `turnId`；忙时 409 |
| `running` → `requires_action` | InteractionRequest 无法自动裁决且 `onUnresolved: park` | 发 webhook；等 lease 持有者 |
| `requires_action` → `running` | lease 持有者回答，或超时按 `parkTimeoutAction` | |
| `running` → `ready` | `state_update{idle}` | daemon 聚合 `TurnResult` 落盘 |
| `ready` → `hibernated` | idle 超时（默认 30 min，per-worker 可配） | 进程回收、lease 释放、记录保留 |
| `hibernated` → `starting` | `prompt` / `attach` | 重新 spawn + resume；结果四态见 D2 |
| 任意 → `closed` | `DELETE` / 进程崩溃且不可 resume | `session/close`（能发则发）+ 杀进程组。`onUnresolved: fail` **不在**此行——它取消本轮、worker 保持打开（裁决 M2-R24） |

进程崩溃：agent 支持 resume → 转 `hibernated` 并标记 `crashed`，下次 prompt 自动恢复；不支持 → `closed`，`omni.worker_state` 带错误。

### 3.3 分层

```
  omni SDK · CLI · CI                          （可选，M4）Zed 等原生 ACP 客户端
        │  /v1/workers  自定义 REST + SSE              │  /acp/{agentId}  官方传输
        ▼                                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Daemon                                                             │
│   控制面 REST ───────────┐            ┌── AcpServer 薄适配           │
│                          ▼            ▼   (session/new → 建 worker) │
│                     Worker Registry  ◄── 两扇门都汇到这里            │
│                          │                                         │
│                ┌─────────▼──────────┐                              │
│                │ Worker             │                              │
│                │  Event Log   seq   │                              │
│                │  Interaction/Policy│                              │
│                │  Lease             │                              │
│                │  Normalizer v1⇄v2 │                              │
│                │  Client Host       │  默认不声明 · 按 agent opt-in │
│                └─────────┬──────────┘                              │
│   Agent Catalog · Runtime 描述符 · Supervisor（单一 spawn 入口）     │
└──────────────────────────┼─────────────────────────────────────────┘
                      stdio ACP（今天全是 v1）
             claude-acp · codex-acp · gemini · opencode · …
```

**两条核心不变量：**

1. **Worker 之内一切都是 ACP v2 形状。** v1 在 Normalizer 处终止。
2. **两扇门都只是入口，所有 ACP 流量都经过 Worker。** `/acp` 门不是旁路。

---


## 4. 核心设计决策

### D1 — 规范内部表示钉死在 ACP v2

**决策**：Event Log 中的事件 payload 是**原样的 v2 `SessionUpdate`**，外套信封 `{seq, ts, daemonId, sessionId, turnId, kind, payload}`。

**理由**：v2 的形状（异步 turn、patch 语义、agent-owned terminal）就是远程化想要的形状。内部只维护一种表示，对外任何视图都是它的投影。

**v0.3 补充**：这是内部表示的选择，与 agent 是否支持 v2 无关。当前只有 **v1→v2** 方向有真实流量；v2→v1（给 v2 客户端接 v1 agent 时的反向）是同一张映射表的另一半，M1 只做前者。

**代价**：v2 是草案。缓解见 D7。

### D2 — 一 worker 一进程；进程易失、session 持久；resume 四态

**决策**：每个 worker 独占一个 agent 子进程。daemon 保存 `workerId → (agentId, sessionId, cwd, mcpServers, owner, protocolVersion, runtimeQuirks, state)`。worker 在 idle 超时后进入 `hibernated`：进程回收、记录保留；下一次 prompt 时重新 spawn 并 resume（v1 `session/load`，v2 `session/resume`）。agent 不支持 resume 的，hibernated worker 收到 prompt 时报 `NotResumable`，由调用方决定重建。

**resume 的结果是四态，不是布尔**（源自 multica `Result.ResumeRejected` 的教训）：

| 结果 | 含义 | daemon 的动作 |
|---|---|---|
| `landed` | 落到了请求的 session | 正常继续 |
| `rejected_permanent` | transcript 没了 / 属于别的账号 / 历史无法重放 | 清掉 session 指针，按策略新建 |
| `rejected_transient` | 现在不行但 session 健康 | 本轮可用新 session，**不**作废旧指针 |
| `unknown` | 该 runtime 测不出来 | 保守：保留指针 |

**判定规则**：错误码 ∈ {-32603, -32602, -32002, -32000} 且文本含 `session not found` / `no session found` / `unknown session` → permanent；`stopReason == refusal` 且本轮零活动（无 text / thought / tool call）→ permanent；**网络 / 限流 / 配额 / 5xx / auth 错误永不算 rejected**。有的 runtime（Hermes）对未知 session 会静默新建，只能读 `_meta` 才知道——Runtime 描述符里要记录这个 quirk。

**诚实的限制**：Event Log 保得住"发生过什么"，保不住 agent 进程内的模型上下文。v1 的 `session/load` 受 `loadSession` capability 门控。能力矩阵按 agent 探测并如实暴露。

### D3 — Client Host：默认不声明 fs / terminal，整体按 agent opt-in

**决策**：daemon 作为 ACP Client，对 v1 agent 的 `initialize` 默认发 `clientCapabilities: {}`。规范要求 agent **MUST NOT** 调用未声明的 `fs/*` / `terminal/*`，于是 agent 走自带工具（直接读写磁盘、自己起 shell）。Client Host 保留为可选模块，由 Runtime 描述符逐 agent 开启。

**依据**（2026-09-03 调研，详见 research 文档 §三）：
- 规范原文：*"Agents MUST verify that the Client supports these capabilities… MUST NOT attempt to call the corresponding filesystem method."* 这些方法的声明目的是 *"access unsaved editor state and allow Clients to track file modifications"*——headless daemon 没有编辑器缓冲区，目的本身不存在
- gemini-cli：`if (clientCapabilities?.fs) setFileSystemService(AcpFileSystemService)`，否则保持 node fs 的 `StandardFileSystemService`
- claude-acp 0.73.0：工具集是 `claude_code` preset（自带 Read / Write / Edit / Bash），未见按 fs / terminal 能力切换工具的代码路径，也不调用 `terminal/*`
- codex-acp：schema 默认 `fs: {false, false}, terminal: false`
- multica：hermes 族 11 个 runtime 全部 `clientCapabilities: {}` 正常工作；kimi 的 `terminal: true` 是 opt-in，注释原话 *"avoids advertising a capability to Hermes-family runtimes that do not need it"*
- v2 已删除这两组方法——"agent 自带"是 v2 唯一模型

**失去什么**：daemon 看不到逐次的文件读写 RPC（但 `tool_call_update` 的 diff 与权限请求仍覆盖写操作，D8 的 git provider 给磁盘真值）；terminal 子进程不由 daemon 直接持有——取消时靠 Supervisor 杀 agent 进程组，孙进程同组一起死。

**何时开**：某个 agent 在 `{}` 下报错或功能缺失（probe / compat 套件发现）时，在描述符里打开对应能力。届时的实现细节：默认 `outputByteLimit = 50 000`、尾部环形截断落在 UTF-8 边界、`kill` = 杀进程组 + 确认整组消失、`release` 仅在 kill 确认后删句柄、反向翻译为 v2 `terminal_update` / `terminal_output_chunk`（对照 multica `acp_terminal.go`）。

### D4 — 权限策略引擎 + 三种兜底 + deny 的实现规则

**决策**：规则引擎自动裁决 `session/request_permission`；无法裁决时按 `onUnresolved: park | deny | fail`。

v2 的请求形状天然适合规则匹配：`subject` 是 `tool_call`（带 `kind` 与 `locations`）| `command`（带 `cwd`）的 tagged union。未知 subject 一律走 default（规范原文：*"Unknown subjects should be preserved or declined by policy"*）。

```yaml
policy:
  default: park
  rules:
    - match: { kind: [read, search, think, fetch] }                       → allow
    - match: { kind: [edit], path: "src/**" }                             → allow
    - match: { subject: command, cmd: "^(pnpm|npm) (test|run build)$" }   → allow
    - match: { kind: [delete] }                                           → deny
```

**`allow` / `deny` 落到 ACP 响应时的硬规则**（multica GH #5300 的教训）：

1. **只选 agent 实际 offered 的 `optionId`**，永不编造
2. `allow` 的选择顺序：已知 session 级 grant id（`allow_session` / `approve_for_session`）→ 任意 `kind == allow_once` → 找不到则降级为 deny
3. **永不选 `allow_always`**——某些 runtime 会把它持久化到 runtime 所有者的磁盘 allowlist，寿命超过这次会话
4. `deny` = 选 offered 的 `reject_once`；没有则回 JSON-RPC error `-32603`
5. **永不回 `outcome: cancelled`**——那取消的是整个 prompt turn，不是这一个动作
6. 未知 `kind` 视为非 grant（fail closed）

**策略归属**：daemon 配置里有命名预设（`readonly` / `src-edit` / `full` …），client 在 `createAgent` 时既可引用预设也可内联规则；但每个 token 的 ACL 里有一条 **`policyCeiling`（最宽允许）**，内联规则与预设的合并结果不得超过它——超过返回 403 `policy_exceeds_ceiling`。管理员用 ceiling 给 token 划红线，使用者在红线内自由。

**三种 `onUnresolved`**：`park` → session 进入 `requires_action`、发 webhook、等 lease 持有者，超时按 `parkTimeoutAction`；`deny` → 按上面规则 4；`fail` → `session/cancel` 取消本轮并标记 run 失败，**worker 保持打开**（裁决 M2-R24：`fail` 是对一个请求的策略判决，不是对 session 的判决；§3.2 的 `任意 → closed` 行相应修订）。

**v1/v2 差异**：v1 请求是 `{toolCall, options}`，v2 是 `{title, subject, options}`。Normalizer 统一成 v2 后再进引擎。

### D5 — 多观察者 + 单控制者（lease）

lease 按 **worker** 发。任意数量客户端可 `attach(workerId)` 接收事件；同一时刻只有 lease 持有者能 prompt、回答 InteractionRequest、改配置。创建 worker 的客户端自动持有 lease；lease 可释放、超时释放、强制抢占（带审计）。在 `/acp` 兼容门上对同一 session 再 `session/load` 的连接，拿不到 lease 就自动成为观察者：照收 `session/update`，`session/prompt` 收到错误。

### D6 — 事件日志与增量重放

每 worker 一条 append-only 日志，单调 `seq`，SQLite 持久化。重连用 `?since=<seq>`。

**v0.3 补充**：v1 的 `session/load` 会把整段历史以 `session/update` 全量重放。daemon 已有历史，所以**重放期间收到的 update 打 `replay: true` 标记进日志但不推给观察者**（或直接丢弃，可配置）。判断依据：从发出 load/resume 到收到其响应之间的所有 update 都是重放。

### D7 — v2 schema 锁定 commit，主动升级

官方 schema JSON 按 commit 落到 `packages/protocol/schema/`；SDK 版本 pin 死。`compat` 测试套件对真实 agent 二进制跑 initialize → new → prompt → load/resume 全流程。**当前回归目标：claude-acp / codex-acp / gemini / opencode / kimi**（全部 v1）。v2 的回归目标在真实 v2 agent 出现前，用 SDK 自带的 v2 example agent 合成。

### D8 — `result.changes` 与 `result.patch` 分开

| 字段 | 来源 | 保证 |
|---|---|---|
| `changes` | 聚合 `tool_call_update` 的 diff 内容 + `locations` | 永远有，但只是 agent 自报（v1 只有 `oldText/newText`；经 terminal 的 sed/formatter 改动不出现） |
| `patch` | workspace diff provider，默认 `git` | 有则准确；cwd 不在 git 仓库内为 `null` |

`git` provider 用临时 index（`GIT_INDEX_FILE=$tmp git add -A && git write-tree` 前后各一次，`git diff-tree -p`），不碰用户 index，尊重 `.gitignore`。不做 fs 快照 provider。

### D9 — webhook：薄 payload + 重试 + 持久化投递记录

payload 只有 `{deliveryId, event, daemonId, runId, sessionId, seq, ts}`，接收方回来拉全量。指数退避 6 次（0s/30s/2m/10m/30m/2h）后 `failed`；SQLite 表 `webhook_deliveries` + `redeliver` 端点即死信队列；HMAC 头 `Omni-Signature`；`deliveryId` 作幂等键。

### D10 — elicitation 与权限统一为 InteractionRequest；按 worker 决定是否声明能力

v2 的 `elicitation/create` 受 `capabilities.elicitation.form / .url` 门控。配合 D2，按 worker 的 `onUnresolved` 决定 initialize 时是否声明：`park` → 声明；`deny` / `fail` → 不声明，仍发来则回 `decline` / `cancel`。daemon 内部把 `request_permission` 与 `elicitation/create` 收敛为同一个 `InteractionRequest` 生命周期。`request_permission` 是 baseline，没有不声明这个杠杆。

### D11 — 多 daemon：Fleet 是 Server 之上的薄聚合

`Server`（`OmniACP.connect()` 的返回值）是单 daemon 原语；`Fleet` 只做聚合与寻址。`daemonId`（ULID，持久）随所有响应和事件信封携带；`sessionId` / `runId` 用 ULID 跨 daemon 唯一；全局地址 `"<daemonId>:<sessionId>"`。聚合调用返回 `{ok, errors}` 不抛；`seq` 仍是 per-(daemon, session)；放置策略不内置，只提供 `fleet.candidates(agentId)`。

### D12 — 传输：SDK 走自定义 `/v1/workers`，官方 `/acp/{agentId}` 是可选兼容门

**决策**：
- **主路径 `/v1/workers`**（自定义 REST + SSE）：SDK、CLI、CI 全走这里。对象模型就是 Worker。
- **兼容门 `/acp/{agentId}`**（官方 streamable HTTP，用 SDK 的 `AcpServer`）：给 Zed 等原生 ACP 客户端。一条路径一种 agent，`session/new` 在 Worker Registry 里建一个 worker，`session/load` 挂到已有 worker。**放到 M4。**

**理由**：v0.3 曾把 AcpServer 定为数据面，问题在于 ACP 的连接模型里没有"选哪个 agent"这个字段，而且 SDK 想要的对象是 worker 而不是连接 + session。让 SDK 绕道 `/acp` 只会把 ACP 的握手细节泄漏到用户代码里。官方门的唯一受益者是现成的编辑器客户端，所以保留但后置，实现成本也低（AcpServer 是现成的，`handleRequest(req, {createAgent})` 支持按 URL 选工厂）。

**代价**：对编辑器的直连体验推后到 M4；`experimental/*` 入口需 pin 版本。


### D13 — worker 可见性按 token；admin token 看全部

**决策**：一个 token 代表一个使用方（人或服务）。同一 token 下的所有客户端互相可见、可 `attach` 接管（lease 规则见 D5）；`Omni-Client-Id` 只用于 lease 归属与审计，**不是**可见性边界。另设 `admin` 角色的 token 可见全机 worker、可强制 steal lease、可读审计日志。

**理由**：这是"自动任务卡在权限上 → 换个设备接管"链路的前提；同时多人共用一台机器时彼此隔离。

### D14 — 本地模式：`OmniACP.local()` 在进程内起 daemon，仍走 loopback HTTP

**决策**：SDK 提供 `OmniACP.local(opts)`，返回与 `connect()` 相同类型的 `Server`。实现：动态 `import("@omni-acp/daemon")`，在本进程内 `startDaemon()` 监听 `127.0.0.1:随机端口`，自动生成 admin token，再用普通 `connect()` 连上。**不做内存直连**——只保留一条客户端代码路径。

**发现 → 复用 → 兜底**：`~/.omni-acp/daemon.json` 记 `{ pid, port, tokenFile }`；`local()` 先看它，进程活着就直接连，否则起新的并写回。token 文件 `0600`。这样多个脚本共享一个本地 daemon，worker 能跨进程 `attach`。

```ts
OmniACP.local({
  adopt: "prefer",     // prefer | never（总起新的）| require（找不到即报错）
  detach: false,       // true = 起独立后台进程（= omni-acp start --daemonize），本进程退出后继续活
  dataDir: "~/.omni-acp",
  config: { … },       // 可选，覆盖零配置默认
});
```

**生命周期**：`detach: false` 时 daemon 随进程退出，worker 进程被杀、session 记录留在 SQLite，下次 `local()` 可 resume；`detach: true` 时 SDK 只是启动器。

**零配置默认**：agent 从 PATH + registry 自动发现；内置策略预设 `readonly / src-edit / full`；`cwdRoots = [os.homedir()]`；不需要配置文件。

**包依赖**：`@omni-acp/client` 不硬依赖 `@omni-acp/daemon`（后者带 sqlite / hono / 进程管理）。未安装时 `local()` 抛明确错误提示 `npm i @omni-acp/daemon`。`local()` 就是 `createDaemon()`（D15）的一个调用者。

### D15 — daemon 是库，CLI 是壳

**决策**：`@omni-acp/daemon` 是一个可嵌入的库，导出 `createDaemon(config)`；所有能力（worker 创建、探测、策略、事件）**先是进程内可调用的对象，HTTP 只是把它们映射成 `/v1` 的适配层**。CLI 拆成独立包 `@omni-acp/cli`（npm 全局装的是它），只做参数 / YAML 解析、信号处理，然后调 `createDaemon()`。

```ts
import { createDaemon } from "@omni-acp/daemon";

const daemon = await createDaemon({
  dataDir: "~/.omni-acp",
  listen: { host: "127.0.0.1", port: 0 },       // port 0 = 随机；省略 listen 则不开 HTTP，纯进程内使用
  tokens: [{ id: "local", secret, role: "admin" }],
  agents: "auto",                                // 或显式列表
  policies: { readonly: {…}, "src-edit": {…} },
});
await daemon.start();                            // daemon.url
const w = await daemon.workers.create({ agent: "claude-acp", cwd, tokenId: "local" });   // 进程内直接调，不经 HTTP
daemon.on("worker.state", handler);
await daemon.stop({ graceful: true });
```

**三条硬约束**：
1. **HTTP 层零业务逻辑**：每个 `/v1` 路由 = 解析请求 → 调 `daemon.xxx` → 序列化。删掉 HTTP 层，库照样能测
2. **配置是对象不是文件**：库只收 `DaemonConfig`；YAML 归 CLI；`OmniACP.local()` 直接传对象
3. **库的依赖里没有 CLI 的东西**（参数解析、彩色输出、YAML 解析）

**调用者**：`omni-acp start`（CLI）、`OmniACP.local()`（D14）、未来的 Electron / VS Code 壳、测试。

---

## 5. 线上协议

### 5.1 主路径 `/v1`

认证 `Authorization: Bearer`；客户端身份 `Omni-Client-Id`（lease 归属、审计）。

```
GET    /v1/health · /v1/info                        # info 含持久 daemonId、平台、能力
GET    /v1/whoami                                   # 验证 token，返回 { tokenId, role, agents, cwdRoots, maxWorkers, policyCeiling }；SDK connect() 只调这一个
GET    /v1/agents                                   # 目录 + 能力矩阵 + runtime 描述符
POST   /v1/agents/{id}/probe                        # 一次性进程 initialize，记录 protocolVersion / capabilities / 扩展方法
# （M4+）POST /v1/agents/{id}/install                # 从 registry 安装：npx 直接可用，binary 下载 + sha256 校验 + 放入 PATH

POST   /v1/workers                                  # 建 worker：spawn + initialize + session/new，就绪后返回
         body   { agent, cwd, mcp: ["preset"], policy, onUnresolved, env?, label? }
         → 201  { workerId, daemonId, sessionId, agent, capabilities, state: "ready" }
GET    /v1/workers · /v1/workers/{wid}
POST   /v1/workers/{wid}/prompt   { content: ContentBlock[] }   → 202 { turnId }   # worker 忙 → 409
POST   /v1/workers/{wid}/cancel
GET    /v1/workers/{wid}/events?since=<seq>         # SSE，增量重放
GET    /v1/workers/{wid}/turns/{turnId}             # 轮询兜底：{ state, stopReason?, result? }
POST   /v1/workers/{wid}/interactions/{reqId}       # 回答权限 / elicitation
POST   /v1/workers/{wid}/config                     # → session/set_config_option
POST   /v1/workers/{wid}/lease/{acquire|release|steal}
DELETE /v1/workers/{wid}                            # session/close + 杀进程

POST   /v1/runs                                     # 一次性：建 worker + prompt + 收敛 + close + webhook
GET    /v1/runs/{rid} · /v1/runs/{rid}/events?since=<seq>
POST   /v1/runs/{rid}/cancel

GET    /v1/webhooks/deliveries · POST …/{id}/redeliver
GET    /v1/fs/read?path= · /v1/fs/list?path=        # 受 cwd 白名单约束
```

`POST /v1/workers` 是**同步就绪**的：npx 冷启动可能十几秒，但返回时 `capabilities` 是真实握手结果而不是缓存。带 `timeout`，超时返回 504 并回收进程。

补充约束：
- **prompt 内容**是 ACP `ContentBlock[]`（text / image / audio / resource / resource_link）。daemon 按该 worker 握手拿到的 `promptCapabilities` 预检，不支持的类型直接 400，不送给 agent；`resource_link` 与内嵌路径必须是绝对路径且落在白名单根内。
- **`env`** 是 worker 级附加环境变量，经黑名单过滤（`HOME` `PATH` `USER` `SHELL` `TMPDIR` 及 `OMNI_*` 前缀不可覆盖），叠加在 daemon 密钥库注入的凭据之后。
- **并发上限**：per-token `maxWorkers` 与 daemon 全局 `maxWorkers`；超限 429 `worker_limit`。
- **一 worker 一 turn**：`prompt` 在 `running` / `requires_action` 状态下返回 409 `worker_busy`；排队是 SDK 的行为，daemon 不排队。

### 5.2 兼容门 `/acp/{agentId}`（M4）

按官方 RFD：`POST` 上行（`initialize` 返回 200 + `Acp-Connection-Id`，其余 202）、`GET` + `Accept: text/event-stream` 开下行流、`DELETE` 关连接。`/acp` 不带 agentId = 该 token 的默认 agent。`initialize` 由 daemon 用探测缓存回答（此时还没有进程）；`session/new` 建 worker；一条连接可开多个 session = 多个 worker；连接断开只释放 lease，worker 不死。AcpServer 的连接表无 TTL，GC 自己做。

### 5.3 事件信封

```json
{ "seq": 1042, "ts": "…", "daemonId": "d_01J…", "workerId": "w_01J…", "sessionId": "s_01J…", "turnId": "t_01J…",
  "kind": "acp.session_update",
  "payload": { "sessionUpdate": "agent_message_chunk", "messageId": "…", "content": { … } } }
```

| kind | payload |
|---|---|
| `acp.session_update` | 原样的 v2 SessionUpdate（可带 `replay: true`） |
| `acp.interaction` | 权限或 elicitation 请求，附 `requestId`、当前状态 |
| `omni.policy_decision` | 自动裁决记录：结果 + 命中的规则 + 选中的 optionId |
| `omni.worker_state` | starting / ready / running / requires_action / hibernated / closed，含 resume 四态结果 |
| `omni.error` | daemon 侧错误 |

### 5.4 错误模型

错误体统一为 `{ code, message, acp?: { code, message, data } }`，`acp` 字段原样透传 agent 返回的 JSON-RPC 错误。

| HTTP | code | 场景 |
|---|---|---|
| 400 | `bad_request` | 参数错、prompt 内容类型不被该 agent 支持、路径不在白名单 |
| 401 / 403 | `unauthorized` / `forbidden` / `policy_exceeds_ceiling` | token 无效 / ACL 不允许该 agent 或 cwd / 内联策略超过 token 的 policyCeiling |
| 404 | `worker_not_found` | |
| 409 | `worker_busy` | 已有 turn 在跑 |
| 410 | `worker_closed` | |
| 422 | `not_resumable` | hibernated 且 agent 不支持 resume，或 resume 结果为 `rejected_permanent` |
| 423 | `lease_held` | 非 lease 持有者尝试 prompt / 回答 / 改配置 |
| 429 | `worker_limit` | 超过 per-token 或全局上限 |
| 502 | `agent_error` | 子进程握手失败、JSON-RPC 错误、进程崩溃 |
| 504 | `agent_timeout` | 握手或 resume 超时 |

### 5.5 Turn 结果由 daemon 聚合

收到该 turn 的 `state_update{idle}` 后，daemon 从 Event Log 聚合出 `TurnResult`（text、toolCalls 终态、changes、patch、usage、interactions）写入 `turns` 表。`GET /v1/workers/{wid}/turns/{turnId}`、SDK 的 `prompt()` 返回值、Run API 的结果、webhook 指向的对象都是**同一份**——避免 SDK 端聚合与轮询口径不一致。SDK 的 `stream()` 只是这份聚合之前的原始事件流。

---

## 6. Normalizer

### 6.1 v1 ⇄ v2 映射

| v1 | ⇄ v2 规范表示 |
|---|---|
| `session/prompt` 挂起 + `{stopReason}` | 立即 ack；发出时合成 `state_update{running}`；**响应返回 + 静默窗口 + 管道排空后**才合成 `state_update{idle, stopReason}` |
| `authenticate{id}` / `logout` | `auth/login{methodId}` / `auth/logout` |
| `session/load` | `session/resume` + `replayFrom:{type:"start"}`；重放期间的 update 打 `replay` 标记 |
| `session/set_mode` · `current_mode_update` | `session/set_config_option` · `configOptions`（category `mode`） |
| `tool_call` + `tool_call_update` | 统一 `tool_call_update` |
| diff `{oldText, newText}` | `{changes:[…], patch:{format:"git_patch", text}}` |
| 权限请求 `{toolCall, options}` | `{title, subject:{type:"tool_call"}, options}` |
| agent 调 `terminal/*` | Client Host 执行；反向发 `terminal_update` / `terminal_output_chunk` |
| 无 `session/list` / `session/close` | daemon 用注册表合成 |
| `clientCapabilities` / `agentCapabilities`、`clientInfo` / `agentInfo` | `capabilities`、`info` |
| 布尔能力 `"image": true` | 对象 `"image": {}` |
| MCP server 无 `type` | 必填 `type: "stdio" \| "http"` |

### 6.2 边界处理规则

- **未知方法透传**：client→agent 不认识的方法原样转发；agent→client 不认识的请求回 `-32601`（别让 agent 干等）。`_meta` 全程保留。
- **厂商扩展**：`session/set_model` / `session/set_options` / `session/notification` 等由 Runtime 描述符登记，Normalizer 按描述符处理（`set_model` 失败 → fail；`set_options` 失败 → warn）。
- **turn 收尾顺序**：等静默窗口 → cancel → 关 stdin → 带 grace 排空 stdout/stderr → terminate。直接在 prompt 响应处 cancel 会丢最后一段回答。（更正，见 CONTRACTS 裁决 M1-R4a：`session/cancel` 走的是 agent 的 stdin，先关 stdin 再 cancel 等于没发；静默窗口仍在最前，语料 finding 14 的理由不变。）
- **`end_turn` ≠ 成功**：stderr 出现 429 / token 过期等终态错误时把状态提升为 failed。
- **mcpCapabilities 过滤**：`initialize` 返回的 `mcpCapabilities` 决定哪些 http/sse 条目能进 `session/new`；有些 runtime 不声明该块但接受 stdio，描述符里登记容忍。

---

## 7. Agent Catalog、Runtime 描述符、Supervisor

**目录来源**：官方 registry.json → daemon 配置文件 → 运行时 API 注册。**M0–M3 只做发现 + 探测**（npx 类 agent 有 Node 就能跑；binary 类要求目标机已装好），从 registry 自动安装后置到 M4+。

**Runtime 描述符**（对应 multica 的 BuiltinRuntime）：每个 agent 一条，承载探测结果与 quirk：

```yaml
claude-acp:
  command: npx
  args: ["@agentclientprotocol/claude-agent-acp@0.73.0"]
  probed: { protocolVersion: 1, capabilities: {…}, extensions: [] }
  clientHost: { terminal: true, fs: false }
  quirks: { resumeSilentlyCreates: false, toleratesOmittedMcpCapabilities: false }
```

同一协议族的兼容分叉只需一条新描述符，不改代码。

**Supervisor**（对照 multica `launch.go`）：
- **单一 spawn 入口**，用测试强制（否则总会有一处忘记设进程组）
- 构造时就设进程组（POSIX）/ Job Object（Windows）；取消 = 杀整组。os/exec 式的"只杀 leader"会留下 MCP server 和 shell 孙进程
- 优雅退出（SIGTERM → grace → SIGKILL）作为 per-agent 可覆盖项
- Linux cgroup v2 / Windows Job Object 限资源；macOS 只有 wall-clock 与 rlimit（文档如实说明）
- Run 层的 **idle watchdog 双预算**：无消息 N 分钟杀；但 `tool_call_update.status == in_progress` 时切换到更大的 tool 预算（npm install 沉默 20 分钟是正常的）

---

## 8. 安全模型

| 项 | 设计 |
|---|---|
| 默认绑定 | `127.0.0.1`；暴露到网络需显式配置 + 强制 TLS |
| 认证 | Bearer token，可选 mTLS；`/acp` 与 `/v1` 共用同一中间件 |
| ACL | 每 token：可用 agent 白名单、cwd 根白名单、`maxWorkers`、`policyCeiling`（D4）、角色 `user` / `admin`（D13） |
| 路径校验 | 所有客户端来源路径 realpath 后必须落在白名单根内 |
| 审计 | worker 创建 / 关闭、权限裁决、lease 抢占、fs 写入、env 注入 |
| 凭据 | agent 的 API key 由 daemon 侧密钥库持有 |

### 鉴权流程

无状态 Bearer：每个 `/v1/*` 请求（含 SSE 的 GET）带 `Authorization: Bearer <secret>`，可选 `Omni-Client-Id` 区分同一 token 的多个客户端。没有登录接口、不发 cookie。

```
header 缺失 / 格式错 / secret 未知     → 401 unauthorized
secret 有效但本次请求越界             → 403 forbidden（agent、cwd、policyCeiling）/ 429 worker_limit
通过                                  → 请求上下文挂 { tokenId, role, acl }，下游各层直接用
```

- **每次都查、不缓存决策**：从配置删掉 token + reload 即时生效
- token 只走 header 不进 URL；非 `127.0.0.1` 绑定强制 TLS
- 配置里存 secret 的 SHA-256，不存明文
- SDK 的 `OmniACP.connect({ url, token })` 只调 `GET /v1/whoami`，验证并取回该 token 的边界放在 `server.me`；之后自动附在每个请求上
- 签发 / 吊销 API 后置 M4+，现在靠配置文件带外分发

### 🔴 `mcpServers` 是最高危攻击面

`session/new` 的 `mcpServers: [{type:"stdio", command, args, env}]` 会在服务器上执行。**客户端不得直接指定 stdio 类型的 MCP server**，只能引用 daemon 预注册的具名 preset；`type:"http"` 放宽到 URL 白名单。preset 解析出真实配置后，还要按 §6.2 的 mcpCapabilities 过滤。

---

## 9. Client SDK

### 9.1 主 API：Worker

```ts
import { OmniACP } from "@omni-acp/client";

const server  = await OmniACP.connect({ url: "https://127.0.0.1:7777", token });

const worker1 = await server.createAgent("claude-acp", { cwd: "/srv/a" });
const worker2 = await server.createAgent("claude-acp", {          // 第二个进程
  cwd: "/srv/b", mcp: ["github"], policy: "readonly", onUnresolved: "deny",
});

const r1 = await worker1.prompt("who are you?");                 // TurnResult
const r2 = await worker2.prompt("who are you?");

for await (const ev of worker1.stream("refactor src/parser.ts")) {   // 流式
  if (ev.type === "text") process.stdout.write(ev.delta);
}

worker1.on("interaction", (req) => req.allow());                 // 交互式批权限
worker1.on("state", (s) => …);

await worker1.close();

const again  = await server.attach(workerId);                     // 重连 / 另一个客户端接管（拿 lease）
const list   = await server.workers();                            // 该 token 可见的 worker
```

```ts
interface TurnResult {
  turnId: string; stopReason: StopReason;
  text: string;                       // 拼好的 agent_message
  toolCalls: ToolCall[];              // 终态
  changes: FileChange[];              // agent 自报（D8）
  patch: string | null;               // git 真值（D8）
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
  interactions: InteractionRecord[];  // 本轮的权限裁决记录
}
```

**`prompt()` 的语义**：`POST …/prompt` 拿 `turnId`；SDK 在 worker 创建时就已订阅 `events` SSE（断线用 `since` 续）；等到该 `turnId` 的 `state_update{idle}` 后聚合返回。同一 worker 同时只能有一个 prompt（ACP 限制）——默认排队，`{ queue: false }` 则抛。`stream()` 是同一条路径不聚合。

SDK 内部承担的脏活：三态 patch 应用、chunk 累积、tool call upsert、`hibernated` worker 的自动唤醒、`NotResumable` 抛错。

### 9.2 本地模式（D14）

```ts
const server = await OmniACP.local();      // 有本地 daemon 就连，没有就在本进程里起
const w = await server.createAgent("claude-acp", { cwd: process.cwd() });
```

与远程 `Server` 同类型，后续代码不区分本地 / 远程。Fleet 可混用：`fleet.add("local", await OmniACP.local())`。

### 9.3 Run（一次性任务）

```ts
await server.runs.create({ agent, cwd, prompt, policy, onUnresolved: "park", parkTimeoutSec: 600, webhook });
```

= 建 worker + prompt + 收敛 + close，结果走 webhook（D9）。

### 9.4 Fleet

```ts
const fleet = new Fleet();
fleet.add("gpu-box",  { url, token });
fleet.add("mac-mini", { url, token });
const w = await fleet.createAgent("claude-acp", { daemon: "gpu-box", cwd: "/srv/proj" });
w.ref;                                            // "d_01J…:w_01J…"
const { ok, errors } = await fleet.workers();     // 部分不可达不抛
```

`Fleet` 就是 `Map<name, Server>`；放置策略不内置（D11）。

### 9.5 Bridge（M4）

`omni-acp bridge --server … --agent claude-acp`：本地说 stdio ACP，远端走 `/acp/{agentId}`，用官方 `http-client` 就是几十行。Zed / nvim 零改动。路径语义问题用同路径挂载或路径改写缓解。

---


## 10. 仓库结构与技术选型

```
packages/
  protocol/   @omni-acp/protocol   信封类型、控制面类型、v1/v2 schema 快照与 codegen
  core/       @omni-acp/core       Session Core：Event Log · Interaction · Lease · Normalizer · Client Host
  daemon/     @omni-acp/daemon     库：createDaemon() · Worker Registry · Catalog · Supervisor · 策略 · 鉴权 · HTTP 适配层（零业务逻辑）
  cli/        @omni-acp/cli        壳：参数 / YAML → createDaemon()；npm 全局装的是它；bin 名 `omni-acp`
  client/     @omni-acp/client     Server · Worker · Run · Fleet · local()（可选依赖 daemon）
  bridge/     @omni-acp/bridge
```

| 项 | 选型 |
|---|---|
| 语言 / 运行时 | TypeScript · Node 22+（`node:sqlite`） |
| ACP | `@agentclientprotocol/sdk` 1.4.0 pin：`.`（v1）、`experimental/v2`、`experimental/server`、`experimental/node`、`experimental/http-client` |
| HTTP | Hono（`/v1`）；M4 加 AcpServer node 适配器（`/acp`） |
| 持久化 | SQLite |
| 校验 | zod（SDK 的 peer dep，顺手） |

---

## 11. 里程碑

**M0 — 骨架：伪代码用 curl 走通**
monorepo（core / daemon / cli / client 四包，daemon 从第一天就是 `createDaemon()` 库，D15）；**三平台 CI 矩阵（Linux / macOS / Windows）从这一步就有**——Supervisor 的进程组 / Job Object 在构造时就分平台写对，不后补；Supervisor（单一 spawn 入口 + 进程组）；Worker Registry；`POST /v1/workers` → spawn + initialize + session/new；`prompt` / `events` / `DELETE`；Normalizer 先只做 v1 prompt 生命周期合成（`state_update running/idle`）。验收：对 claude-acp 起两个 worker，各 prompt 一次，两边互不干扰。

**M1 — Worker 内核**
Normalizer v1→v2 全量映射（turn 收尾、replay 标记、扩展方法透传）；Event Log 持久化 + `since` 重放；lease；hibernate / resume 四态。验收：同一份 SDK 代码对五个 v1 目标 agent 行为一致；断线重连不丢事件；hibernated worker 能被唤醒。

**M2 — 生产化**
InteractionRequest + 策略引擎（三种 onUnresolved、deny 规则）；认证 / ACL / cwd 白名单 / mcpServers preset + capabilities 过滤；webhook 投递与重试；git diff provider；idle watchdog 双预算；Runtime 描述符与 quirk 表。

**M3 — SDK**
`@omni-acp/client`：Server / Worker（prompt · stream · on · attach）/ Run / Fleet / `local()`（D14）。这一步之后对外可用。

**M4 — 兼容门与 v2**
`/acp/{agentId}`（AcpServer 薄适配）+ bridge；真实 v2 agent 出现后接入（v2→v1 反向映射）；WebSocket；Client Host（fs / terminal）按需 opt-in 实现；从 registry 安装 agent。

---


## 12. 决议记录

**2026-09-03 第一轮**：v2 schema 锁定（D7）· changes/patch 分开（D8）· webhook 薄 payload + 重试（D9）· elicitation 统一为 InteractionRequest（D10）· Fleet 薄聚合（D11）。

**2026-09-03 第二轮**（合并调研）：
| 问题 | 决议 |
|---|---|
| M0 目标 agent | 从"v2 only"改为 v1 五个主流 agent —— registry 0/39 有 v2 |
| 传输层（原 R6） | 数据面直接用官方 `AcpServer`，控制面自定义（D12） |
| Client Host 范围 | ~~terminal 必做，fs opt-in~~ → 第四轮改为整体默认不声明（D3） |
| resume 语义 | 四态 landed / rejected_permanent / rejected_transient / unknown（D2） |
| 权限 deny 实现 | 只选 offered optionId、永不 allow_always、永不 cancelled（D4） |
| Normalizer 边界 | replay 标记、turn 收尾顺序、未知方法透传、厂商扩展登记（§6.2） |

**2026-09-03 第三轮**（SDK 对象模型）：
| 问题 | 决议 |
|---|---|
| 用户面核心对象 | **Worker** = 1 进程 + 1 ACP session；`createAgent()` 一次一个进程（§3.1） |
| 传输（D12 再改） | SDK 主路径 `/v1/workers`；`/acp/{agentId}` 降为 M4 可选兼容门 |
| `/acp` 选 agent | 一条路径一种 agent；`initialize` 由 daemon 用探测缓存回答 |
| lease 粒度 | 按 worker；兼容门上后来的 `session/load` 自动成为观察者（D5） |

**2026-09-03 第四轮**（fs / terminal）：
| 问题 | 决议 |
|---|---|
| Client Host | **默认 `clientCapabilities: {}`**，agent 用自带工具；fs / terminal 整体作为 opt-in 模块后置到 M4（D3）。依据：规范 MUST NOT、gemini / claude-acp / codex-acp 源码、multica 11 runtime 实证 |

**2026-09-03 第五轮**（遗留决策）：
| 问题 | 决议 |
|---|---|
| 策略归属 | daemon 命名预设 + client 内联都行；token ACL 设 `policyCeiling` 上限（D4） |
| worker 可见性 | 同 token 全可见可接管；admin token 看全部（D13） |
| agent 安装 | M0–M3 只发现 + 探测；从 registry 安装后置 M4+（§7） |
| Windows | M0 起三平台 CI 矩阵（§11） |
| 确认的默认值 | hibernate 30 min；worker 关闭后事件日志保留 7 天；token 放配置文件；npm scope `@omni-acp/*`；CLI 先只做 `start / agents / probe / workers` |
| 本地模式 | `OmniACP.local()` 进程内起 daemon，loopback HTTP，发现-复用-兜底；（D14） |
| daemon 形态 | **库优先**：`createDaemon()`，HTTP 是零逻辑适配层，CLI 拆成 `@omni-acp/cli` 壳（D15） |
