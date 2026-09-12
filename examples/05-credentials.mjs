// M3-WP1 的凭据：把本机登录交给 daemon，两个 worker 各自 home，换凭据，重启。
//
//   pnpm --filter @omni-acp/examples credentials
//   AGENT=codex-acp pnpm --filter @omni-acp/examples credentials
//
// 三件事值得先说清楚，因为它们是设计而不是实现细节：
//
//  1. **读本机登录发生在客户端。** `OmniACP.localCredential(agent)` 在你自己的进程里读
//     `~/.claude/.credentials.json` / `~/.codex/auth.json`。一个替你读文件的 daemon 就是一个
//     能读任意路径的 daemon —— 远程请求、daemon 自己的 uid —— 这是没有安全版本的原语。
//  2. **secret 只上行。** `put` 之后你再也拿不回来：`list` / `get` / `check` 只给
//     `fingerprint`（sha256 前 12 位），足够说"就是我刚上传的那个"，拿来认证毫无用处。
//  3. **凭据文件是软链，不是复制。** 每个 worker 一个 home，home 里的凭据文件软链到仓库里那一份
//     规范文件。这不是省磁盘：agent 会自己刷新 token（E3），复制件几小时内就和源分叉，而软链让
//     任何一个 worker 的刷新写回所有 worker 都在读的那一份。
import { mkdtemp, readdir, readlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniACP } from "@omni-acp/client";

const AGENTS = {
  "claude-acp": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"] },
  "codex-acp": { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.8.0"] },
};
const agentId = process.env.AGENT ?? "claude-acp";
const workspace = await mkdtemp(join(tmpdir(), "omni-example-cred-"));
const dataDir = await mkdtemp(join(tmpdir(), "omni-example-data-"));

// ── 0. 本机登录 ──────────────────────────────────────────────────────────────
//
// 没登录就直接退出，而且是带话说的退出：`credential_required` 的修复办法是"先在本机登录"，
// 不是"重试"。
let credential;
try {
  credential = await OmniACP.localCredential(agentId);
} catch (e) {
  console.error(`${e.message}`);
  process.exit(1);
}
// 这里能看到的只有形状：`kind` 和文件名。值在 `files` 里，接下来直接上行，不打印。
console.log(
  `local login: kind=${credential.kind} files=${Object.keys(credential.files).join(",")}`,
);

const server = await OmniACP.local({
  adopt: "never",
  dataDir,
  config: {
    tokens: [
      {
        id: "local",
        secret: "local-dev-secret-0123456789abcdef",
        role: "admin",
        cwdRoots: [workspace],
      },
    ],
    agents: [{ id: agentId, ...AGENTS[agentId] }],
  },
});
console.log(`daemon at ${server.url}`);

try {
  // ── 1. 存进仓库 ────────────────────────────────────────────────────────────
  //
  // `put` 是本仓库里**唯一**一个 body 带明文 secret 的请求，所以 daemon 只在 TLS 或 loopback
  // 上接受它（否则 `403 insecure_transport`）。`OmniACP.local()` 绑的就是 127.0.0.1。
  const stored = await server.credentials.put(agentId, credential);
  console.log(
    `stored ${stored.agentId}/${stored.name}: method=${stored.method} ` +
      `fingerprint=${stored.fingerprint} expires=${stored.expiresAt ?? "-"}`,
  );

  // 拿回来的是 summary。没有任何一条路由会返回内容 —— 不是"默认不返回"，是没有这条路由。
  const readBack = await server.credentials.get(agentId);
  console.log(`read back: ${JSON.stringify(readBack)}`);

  // 轻检查：文件在、没过期。`{deep:true}` 会真起一个进程去问 agent，花 token，所以要显式要。
  console.log(`check: ${JSON.stringify(await server.credentials.check(agentId))}`);

  // `GET /v1/agents` 的 `login` 是**按当前 token 算**的：probe 是关于二进制的共享事实，
  // "我登录了吗"是关于调用方凭据的事实。
  const entry = (await server.agents()).find((a) => a.id === agentId);
  console.log(`agents[].login.state = ${entry?.login?.state ?? "(none)"}`);

  // ── 2. 两个 worker，两个 home，一份凭据 ────────────────────────────────────
  const first = await server.createAgent(agentId, { cwd: workspace });
  const second = await server.createAgent(agentId, { cwd: workspace });
  console.log(`worker A home: ${first.snapshot.home}`);
  console.log(`worker B home: ${second.snapshot.home}`);

  // 两条软链指向同一个规范文件。`readlink` 才是这个断言 —— 比字节内容强，因为两份复制品的字节
  // 也相等，而它们会分叉。
  const files = Object.keys(credential.files);
  const targets = await Promise.all(
    [first, second].map((w) => readlink(join(w.snapshot.home, files[0]))),
  );
  console.log(`A -> ${targets[0]}`);
  console.log(`B -> ${targets[1]}`);
  console.log(`same canonical file: ${String(targets[0] === targets[1])}`);

  const answer = await first.prompt("Reply with the single word OK.");
  console.log(`A turn: ${answer.verdict} stopReason=${String(answer.stopReason)}`);

  // agent 自己的东西落在 home 里（claude 的 `projects/`、codex 的 `thread_history`）。这就是
  // E7，也是为什么 hibernate / wake / restart 必须复用同一个目录。
  console.log(`A home now holds: ${(await readdir(first.snapshot.home)).join(", ")}`);
  console.log(`A home mode: ${((await stat(first.snapshot.home)).mode & 0o777).toString(8)}`);

  // ── 3. 重启：换进程，留会话 ────────────────────────────────────────────────
  //
  // 同一个 worker id、同一个 lease、同一个 home、同一个 session，`generation + 1`。
  await first.prompt("Remember the word lighthouse.");
  const restarted = await first.restart({ reason: "example" });
  console.log(
    `restart: generation=${String(restarted.generation)} pid=${String(restarted.pid)} ` +
      `resume=${JSON.stringify(restarted.resume)}`,
  );
  const recalled = await first.prompt("What word did I ask you to remember?");
  console.log(`recalled: ${recalled.text.trim().slice(0, 120)}`);

  // ── 4. 换凭据 ──────────────────────────────────────────────────────────────
  //
  // `applied` 说的是**实际发生了什么**，不是你要求了什么 —— 而它取决于描述符里那个**实测**出来的
  // `reload`：claude-acp 每次请求都重读文件（所以 `immediate`），codex-acp 在启动时缓存
  // （所以空闲时 `restarted`、跑 turn 时 `on-next-start`）。
  await server.credentials.put(agentId, credential, "rotated");
  const applied = await second.setCredential("rotated");
  console.log(
    `setCredential: applied=${applied.applied} fingerprint=${String(applied.credential.fingerprint)} ` +
      `previous=${String(applied.previous)} generation=${String(applied.generation)}`,
  );

  // 仓库里原地更新一个已经有 worker 在用的名字，会告诉你**哪些 worker 需要重启**：软链已经指向
  // 刚改的那个文件，所以 `reload:"file"` 的 agent 下一个请求就用上了，`reload:"restart"` 的不会。
  const updated = await server.credentials.put(agentId, credential);
  console.log(
    `re-put: workersAffected=${String(updated.workersAffected)} ` +
      `restartRequired=[${updated.restartRequired.join(", ")}]`,
  );

  // ── 5. 一条审计线 ──────────────────────────────────────────────────────────
  //
  // 换凭据在别的流里是隐形的：`reload:"file"` 的 agent 不重启、状态不变，日志上看就是一个 turn
  // 突然以另一个身份在回答。`omni.credential` 就是那一行，只有 fingerprint，没有 secret。
  // `events({since:0})` is a LIVE tail: it does not end for an open worker (`stream_end` only
  // arrives for a closed one), so the loop breaks on the envelope it came for, with a bound so a
  // daemon that never wrote one cannot hang the example.
  let scanned = 0;
  for await (const e of second.events({ since: 0 })) {
    scanned += 1;
    if (e.kind === "omni.credential") {
      console.log(`audit: ${JSON.stringify(e.payload)}`);
      break;
    }
    if (scanned > 200) break;
  }

  await first.close();
  await second.close();

  // 用着的凭据删不掉：live worker 的 home 就软链在那个文件上。
  try {
    await server.credentials.put(agentId, credential, "doomed");
    await server.credentials.remove(agentId, "doomed");
    console.log("removed the unused credential");
  } catch (e) {
    console.log(`remove refused: ${e.code} ${e.message}`);
  }
} finally {
  await server.close();
}
