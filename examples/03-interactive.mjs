// M2 的交互回路：park -> 人回答 -> agent 继续，外加 setConfig 与 patch。
//
//   pnpm --filter @omni-acp/examples interactive
//   AGENT=codex-acp pnpm --filter @omni-acp/examples interactive
//
// 三件事，都是 M2 才有的：
//
//   1. onUnresolved:"park" —— 策略裁决不了的权限请求不再自动拒绝，而是停下来等人。worker 进入
//      `requires_action`，`worker.on("interaction", …)` 拿到一个可以 allow / deny / answer 的句柄。
//      这也是 D10 的开关：只有 park 的 worker 才在 initialize 里声明 elicitation 能力(F28)。
//   2. setConfig —— 换模型/模式。返回的是**整份**列表，成员可能变少(F34: claude 换 haiku 后 4 → 2)，
//      所以永远重读，不要缓存单条。
//   3. patch —— cwd 在 git 仓库里时，TurnResult.patch 是这一轮真正落盘的 diff(D8)，与 agent 自己
//      报的 changes 分开。不在仓库里就是 null，并且总有一条 warning 说明为什么。
import { OmniACP } from "@omni-acp/client";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENTS = {
  "claude-acp": { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"] },
  "codex-acp": { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@1.8.0"] },
};
const agentId = process.env.AGENT ?? "claude-acp";
const workspace = await mkdtemp(join(tmpdir(), "omni-example-m2-"));

/** 一个零提交的 git 仓库：`git add -A` 进空 index 不需要 HEAD，所以这样就够 provider 用了。 */
async function initRepo(dir) {
  await mkdir(join(dir, ".git", "objects"), { recursive: true });
  await mkdir(join(dir, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
}
await initRepo(workspace);

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
    // M2 的两个 daemon 级开关。provider 默认是 "none"：没人要求就不该在别人的仓库里跑 git。
    diff: { provider: "git" },
    // 双预算看门狗(DESIGN §7)：整轮没动静 silentMs，有工具在跑 toolMs。默认就是开的。
    watchdog: { silentMs: 300_000, toolMs: 600_000, cancelTimeoutMs: 60_000 },
  },
});
console.log(`daemon ${server.daemonId} at ${server.url}`);

// ── 1. 一个会停下来等人的 worker ──────────────────────────────────────────────
//
// policy 决定"能不能自动裁决"，onUnresolved 决定"裁决不了怎么办"。这里 default:"park" 意思是
// 所有权限请求都交给人 —— 换成 "readonly" 预设就是"读放行、写交给人"。
const worker = await server.createAgent(agentId, {
  cwd: workspace,
  onUnresolved: "park",
  policy: { default: "park" },
  parkTimeoutMs: 0, // 0 = 永不过期，真的等人。非 0 时到点按 parkTimeoutAction 处理(默认 deny)
});
console.log(
  `worker ${worker.id}: onUnresolved=${worker.snapshot.onUnresolved}`,
  `policy=${JSON.stringify(worker.snapshot.policy?.sources)}`,
  `patchMode=${worker.snapshot.patchMode}`,
  `watchdog=${JSON.stringify(worker.snapshot.watchdog)}`,
);

// DESIGN §9.1 的那一行。auto-allow 只是例子；真实前端应该在这里问人。
const off = worker.on("interaction", async (req) => {
  console.log(`\n[interaction] ${req.method} — ${req.title}`);
  if (req.options.length > 0) {
    // 只在 offered 里选，永远不选 allow_always(D4 规则 1 和 3)。allow() 不传 id 就按规则 2 排序挑。
    console.log(`  options: ${req.options.map((o) => `${o.optionId}(${o.kind})`).join(", ")}`);
    await req.allow();
  } else {
    // elicitation：按**问题** id 回答，一个问题一个值(F30)。
    const first = req.fields[0];
    await req.answer({ [first.id]: first.options[0]?.value ?? "notes.md" });
  }
  console.log("  answered\n");
});

const result = await worker.prompt("Create a file hello.txt containing exactly: hello");
console.log(`stopReason=${result.stopReason} verdict=${result.verdict}`);
for (const record of result.interactions) {
  console.log(
    `  interaction ${record.requestId}: ${record.decision} by ${record.by}` +
      ` (parked ${record.parkedMs ?? 0}ms, optionId=${record.optionId ?? "-"})`,
  );
}
console.log(
  `  hello.txt = ${JSON.stringify(await readFile(join(workspace, "hello.txt"), "utf8"))}`,
);

// ── 2. patch：这一轮真正改了什么 ──────────────────────────────────────────────
//
// changes 是 agent 自报的，patch 是磁盘真值。null 时一定有一条 source:"patch" 的 warning 说明原因
// （不在仓库里 / 仓库中途变了 / 超过 maxBytes / git 失败）。
console.log(
  `  patch: ${result.patch === null ? "null" : `${result.patch.split("\n").length} lines`}`,
);
console.log(`  patchInfo: ${JSON.stringify(result.patchInfo)}`);
for (const w of result.warnings.filter((x) => x.source === "patch")) {
  console.log(`  patch warning: ${w.code} — ${w.message}`);
}

// ── 3. setConfig：换模型/模式 ────────────────────────────────────────────────
//
// 两个真 agent 都不会为这个调用发通知(F34/F35)，所以列表只能从**方法自己的返回值**刷新。
const options = worker.config ?? [];
console.log(`\nconfigOptions: ${options.map((o) => `${o.id}=${o.currentValue}`).join(", ")}`);
const target = options.find((o) => o.id === "model") ?? options[0];
if (target !== undefined) {
  const choice = (target.raw.options ?? []).find((o) => o.value !== target.currentValue);
  if (choice !== undefined) {
    const after = await worker.setConfig(target.id, choice.value);
    // 成员可能变少：claude 换到 haiku 后 effort/fast 直接消失(F34)。所以重读整份，别缓存单条。
    console.log(`after setConfig: ${after.map((o) => `${o.id}=${o.currentValue}`).join(", ")}`);
  }
}

off();
await worker.close();
await server.close();
console.log("\ndone");
