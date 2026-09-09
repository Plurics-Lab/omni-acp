// M2 的 Run：一次性任务 + webhook 回调。
//
//   pnpm --filter @omni-acp/examples run-webhook
//   AGENT=codex-acp pnpm --filter @omni-acp/examples run-webhook
//
// Run 是 DESIGN §9.3 的"发出去就不管了"那一半：create + prompt + settle + close 是 daemon 的事，
// 调用方拿一个 runId 就可以走。做完之后 daemon 往 webhook 推一条**薄** payload —— 只有八个键，
// 没有 turn 内容 —— 接收方拿 runId 回来拉全量(D9)。薄是安全设计：投递会重试、会进日志、会到第三方，
// 里面不该有 agent 说过的话。
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniACP } from "@omni-acp/client";

const AGENTS = {
  "claude-acp": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"] },
  "codex-acp": { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.8.0"] },
};
const agentId = process.env.AGENT ?? "claude-acp";
const workspace = await mkdtemp(join(tmpdir(), "omni-example-run-"));
const SECRET = "example-webhook-secret-0123456789";

// ── 1. 一个接收端 ────────────────────────────────────────────────────────────
//
// 先起接收端，因为 webhooks.allow 是白名单，而端口要绑了才知道。
const received = [];
const receiver = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ body, signature: req.headers["omni-signature"] ?? "" });
    res.writeHead(204).end();
  });
});
await new Promise((resolve) => receiver.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${receiver.address().port}`;
console.log(`receiver at ${origin}`);

/** `Omni-Signature: t=<unix秒>,v1=<hex>` —— HMAC-SHA256 覆盖 "<t>.<原始 body>"。 */
function verify(entry, secret) {
  const parsed = /^t=(\d+),v1=([0-9a-f]+)$/.exec(entry.signature);
  if (parsed === null) return false;
  const expected = createHmac("sha256", secret).update(`${parsed[1]}.${entry.body}`).digest("hex");
  // 时间戳在**签名内容里**，所以接收方不用解析 JSON 就能按年龄拒绝重放。
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parsed[2]));
}

// ── 2. daemon：出站是 fail-closed 的 ─────────────────────────────────────────
const server = await OmniACP.local({
  adopt: "never",
  config: {
    tokens: [
      {
        id: "local",
        secret: "local-dev-secret-0123456789abcdef",
        role: "admin",
        cwdRoots: [workspace],
        // 没有签名密钥的 token 不能创建带 webhook 的 run —— 一条没人能验证的投递不如不发。
        webhookSecret: SECRET,
      },
    ],
    agents: [{ id: agentId, ...AGENTS[agentId] }],
    eventLog: { driver: "memory" },
    webhooks: {
      // 默认 enabled:false。这是 daemon 的第一个**出站**面，所以三道门都默认关着(§24.6)。
      enabled: true,
      mode: "allowlist",
      allow: [origin],
      // 默认 denyCidrs 含 127.0.0.0/8 等内网段，防 SSRF/元数据服务。本例的接收端就在 loopback 上，
      // 所以这里显式清空 —— 真实部署里不要这么写，把接收端放在允许的网段上。
      denyCidrs: [],
      secrets: { ci: SECRET },
    },
  },
});

// ── 3. 一个 Run ─────────────────────────────────────────────────────────────
const run = await server.runs.create({
  agent: agentId,
  cwd: workspace,
  prompt: [{ type: "text", text: "Reply with exactly the word PONG." }],
  // secret 是**名字**，值永远不过网(§24.3)。
  webhook: { url: `${origin}/hook`, secret: "ci" },
});
console.log(`run ${run.runId} accepted (state=${run.state}, persistence=${run.persistence})`);

// 202 ACCEPTED，之后自己收敛。轮询或者订阅 runs.events(id) 都行 —— 后者是和 worker.events()
// 同一条可续传的流，断线用 ?since= 接上。
let settled = run;
for (let i = 0; i < 600 && !["succeeded", "failed", "cancelled"].includes(settled.state); i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  settled = await server.runs.get(run.runId);
}
console.log(`run ${settled.runId}: ${settled.state}`);
console.log(`  text: ${JSON.stringify(settled.result?.text ?? null)}`);

// ── 4. 投递 ─────────────────────────────────────────────────────────────────
for (let i = 0; i < 200 && received.length === 0; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
}
for (const entry of received) {
  const payload = JSON.parse(entry.body);
  console.log(`  delivery ${payload.deliveryId}: ${payload.event}`);
  console.log(`  keys: ${Object.keys(payload).sort().join(", ")}`);
  console.log(`  signature verifies: ${verify(entry, SECRET)}`);
  // 薄 payload 的用法：拿 runId 回来拉全量。workerId 也在里面，所以 /v1 的其它路由都能寻址。
  const full = await server.runs.get(payload.runId);
  console.log(`  pulled back: state=${full.state}, worker=${full.workerId}`);
}

// 投递记录是持久的死信队列：失败六次后是 `failed`，可以 `omni-acp deliveries --redeliver <id>`
// 重发。deliveryId 是幂等键，重启也不会变。
await server.close();
receiver.close();
console.log("\ndone");
