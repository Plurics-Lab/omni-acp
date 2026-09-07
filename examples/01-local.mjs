// 本地模式：不用单独起 daemon，SDK 在本进程内起一个（loopback HTTP，随机端口）。
//
//   pnpm --filter @omni-acp/examples local
//   AGENT=codex-acp pnpm --filter @omni-acp/examples local
//
import { OmniACP } from "@omni-acp/client";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENTS = {
  "claude-acp": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"] },
  "codex-acp": { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.8.0"] },
};
const agentId = process.env.AGENT ?? "claude-acp";
const workspace = await mkdtemp(join(tmpdir(), "omni-example-"));

// ── 1. 起一个嵌入式 daemon ────────────────────────────────────────────────────
// adopt:"never" 总是起新的（M1 的唯一模式）；config 与 daemon.example.yaml 同形。
const server = await OmniACP.local({
  adopt: "never",
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
    eventLog: { driver: "memory" },
  },
});
console.log(
  `daemon ${server.daemonId} at ${server.url}; I am token "${server.me.tokenId}" (${server.me.role})`,
);

// ── 2. 一个 worker = 一个 agent 进程 + 一个 ACP session ──────────────────────
const worker = await server.createAgent(agentId, {
  cwd: workspace,
  label: "example",
  idleTimeoutMs: 0, // 0 = 这个 worker 不 hibernate
});
console.log(`worker ${worker.id} state=${worker.state} session=${worker.sessionId}`);
console.log(`agent says protocolVersion ${worker.snapshot.capabilities?.protocolVersion ?? "?"}`);

// ── 3. prompt(): 等整个 turn 结束，拿聚合好的 TurnResult ─────────────────────
const r1 = await worker.prompt("Reply with exactly one sentence: who are you?");
console.log(`\n[turn ${r1.turnId}] stopReason=${r1.stopReason} verdict=${r1.verdict}`);
console.log(r1.text.trim());
if (r1.usage) console.log(`context ${r1.usage.used}/${r1.usage.size} tokens`);

// ── 4. stream(): 同一条路径，不聚合，逐事件拿 ────────────────────────────────
process.stdout.write("\n[stream] ");
for await (const ev of worker.stream(
  `Create a file named hello.txt in the current directory containing the word hello.`,
)) {
  if (ev.type === "text") process.stdout.write(ev.delta);
  else if (ev.type === "tool_call")
    process.stdout.write(
      `\n  ⚙ ${ev.toolCall.kind ?? "tool"} ${ev.toolCall.title ?? ""} [${ev.toolCall.status}]\n`,
    );
  else if (ev.type === "done") {
    const r = ev.result;
    console.log(
      `\n[done] stopReason=${r.stopReason} tools=${r.toolCalls.length} changes=${r.changes.map((c) => c.path).join(",") || "-"}`,
    );
    // M1 的固定策略是自动拒绝需要许可的操作；被拒的 tool call 在这里，stopReason 仍可能是 end_turn。
    if (r.deniedToolCalls.length) console.log(`  denied: ${r.deniedToolCalls.join(", ")}`);
  }
}

// ── 5. 收尾 ──────────────────────────────────────────────────────────────────
const closed = await worker.close(); // session/close → 杀进程组
console.log(`\nclosed: leaderExited=${closed.leaderExited} treeGone=${closed.treeGone}`);
await server.close(); // 本地模式：连 daemon 一起停
