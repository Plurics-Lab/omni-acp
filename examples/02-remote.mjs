// 远程模式：连一个已经在跑的 daemon。
//
//   # 终端 1（目标机器）
//   pnpm --filter @omni-acp/examples daemon        # 读 daemon.example.yaml；或 omni-acp start --port 7777 --print-token
//   # 终端 2
//   OMNI_URL=http://127.0.0.1:7777 OMNI_TOKEN=... AGENT=claude-acp CWD=/srv/alice/proj \
//     pnpm --filter @omni-acp/examples remote
//
import { OmniACP, OmniError } from "@omni-acp/client";

const url = process.env.OMNI_URL ?? "http://127.0.0.1:7777";
const token = process.env.OMNI_TOKEN;
const agentId = process.env.AGENT ?? "claude-acp";
const cwd = process.env.CWD ?? process.cwd();
if (!token) throw new Error("set OMNI_TOKEN (the daemon prints it with --print-token)");

// connect() 只发一个 GET /v1/whoami：验 token，取回它的边界。
const server = await OmniACP.connect({ url, token, clientId: "example-remote" });
console.log(
  `connected to ${server.daemonId}: agents=${JSON.stringify(server.me.agents)} cwdRoots=${JSON.stringify(server.me.cwdRoots)}`,
);
console.log(`catalog: ${(await server.agents()).map((a) => a.id).join(", ")}`);

// ── 两个 worker 并行：各自一个进程，互不干扰 ────────────────────────────────
const [w1, w2] = await Promise.all([
  server.createAgent(agentId, { cwd, label: "w1" }),
  server.createAgent(agentId, { cwd, label: "w2" }),
]);
console.log(
  `w1=${w1.id} pid=${w1.snapshot.process?.pid}   w2=${w2.id} pid=${w2.snapshot.process?.pid}`,
);

// 订阅 worker 状态迁移（starting → ready ⇄ running → hibernated/closed）
const off = w1.on("state", (s) => console.log(`  w1 → ${s}`));

const [r1, r2] = await Promise.all([
  w1.prompt("Reply with exactly the word PONG."),
  w2.prompt("Reply with exactly the word PING."),
]);
console.log(`w1: ${r1.text.trim()}   w2: ${r2.text.trim()}`);
off();

// ── 同一 worker 同时只能跑一个 turn ────────────────────────────────────────────
// 等第一个 turn 真正进入 running，再发第二个：{queue:false} 立刻抛 worker_busy（409）；
// 默认 {queue:true} 则在 SDK 侧排队，等前一个 turn 结束后发出。
const running = new Promise((resolve) => {
  const off = w1.on("state", (s) => {
    if (s === "running") {
      off();
      resolve();
    }
  });
});
const slow = w1.prompt("Count from 1 to 5, one number per line.");
await running;
try {
  await w1.prompt("ignored", { queue: false });
} catch (e) {
  if (e instanceof OmniError) console.log(`second prompt while busy → ${e.code} (${e.status})`);
}
const queued = w1.prompt("Reply with exactly the word QUEUED."); // 排队，前一个结束后才发
console.log(`slow: ${(await slow).text.trim().replace(/\n/g, " ")}`);
console.log(`queued: ${(await queued).text.trim()}`);

// ── 另一个客户端可以 attach 同一个 worker（观察者），或抢 lease 接管 ────────
const other = await OmniACP.connect({ url, token, clientId: "example-observer" });
const view = await other.attach(w1.id);
console.log(
  `observer sees w1 state=${view.state}, lease holder=${view.lease.snapshot.holder?.clientId ?? "none"}`,
);
await view.lease.steal("handover demo"); // 之后 w1 这个句柄再 prompt 会得到 423 lease_held
console.log(`after steal: holder=${view.lease.snapshot.holder?.clientId}`);

// ── 事件日志：断线也不丢，?since= 续传由 SDK 自动做；也能手动重放 ─────────
let n = 0;
for await (const env of w1.events({ since: 0 })) {
  n++;
  if (env.kind === "omni.worker_state")
    console.log(`  seq ${env.seq}: ${env.kind} → ${env.payload.state}`);
  if (n >= 200 || (env.kind === "omni.worker_state" && env.payload.state === "ready" && n > 5))
    break;
}

await Promise.all([view.close(), w2.close()]);
await server.close();
await other.close();
