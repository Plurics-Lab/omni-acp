import { randomBytes } from "node:crypto";
import { readFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmniACP, type InteractionRequestHandle, type Server, type Worker } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";
import { runUtility } from "@omni-acp/core";
import type {
  Daemon,
  InteractionPayload,
  PolicyDecisionPayload,
  RunSnapshot,
  WebhookPayload,
} from "@omni-acp/protocol";
import {
  fakeWebhookReceiver,
  fixtureAgentPath,
  initGitRepoAt,
  type FakeReceiver,
} from "@omni-acp/testkit";
import { main } from "@omni-acp/cli";
import { tempRoot } from "./support/harness.js";

/**
 * M2's acceptance script (docs/M2-PLAN.md §4), for the parts a FIXTURE agent can prove
 * deterministically. The real-agent half runs from `tests/compat/src/runner.ts` against
 * `claude-acp` and `codex-acp`, twice in a row, and is recorded in M2-PLAN §5.
 *
 * ONE daemon, TWO SDK clients on one token with distinct client ids (`A` the controller, `B` the
 * observer), and the script in order: the park end to end, the observer's `423`, the watchdog's
 * dual budget, a webhook delivery, the patch, containment, and the CLI over the same socket.
 *
 * Everything below is deliberately end-to-end THROUGH THE ROUTES: the individual features have
 * their own integration files (`interaction-park`, `watchdog`, `run-webhook`, `patch`,
 * `prompt-content`), and this one exists to prove they are WIRED — which is the whole of
 * M2-WP-J's job and the one thing a per-feature test cannot show.
 *
 * Owned by M2-WP-J.
 */

const STEP_MS = 90_000;

async function hasGit(): Promise<boolean> {
  try {
    return (await runUtility("git", ["--version"], { timeoutMs: 30_000 })).code === 0;
  } catch {
    return false;
  }
}
const NO_GIT = !(await hasGit());

interface Rig {
  readonly daemon: Daemon;
  readonly url: string;
  readonly tokenA: string;
  readonly A: Server;
  readonly B: Server;
  readonly workspace: string;
  readonly receiver: FakeReceiver;
  readonly secret: string;
  dispose(): Promise<void>;
}

let live: Rig | null = null;
afterEach(async () => {
  await live?.dispose();
  live = null;
});

/** §4's setup, in one place: the config the script names, with every M2 block in force. */
async function startRig(): Promise<Rig> {
  const workspace = await tempRoot("omni-m2-ws-");
  const dataDir = await tempRoot("omni-m2-data-");
  const tokenA = randomBytes(32).toString("hex");
  const secret = randomBytes(32).toString("hex");
  // The receiver binds FIRST: its origin is not knowable until it has a port, and
  // `webhooks.allow` is an allowlist (§24.6).
  const receiver = await fakeWebhookReceiver();

  const agent = (id: string, env: Record<string, string>) => ({
    id,
    command: process.execPath,
    args: [fixtureAgentPath("patch-writer")],
    env,
  });

  const daemon = await createDaemon({
    dataDir,
    listen: { host: "127.0.0.1", port: 0 },
    logLevel: "warn",
    eventLog: { driver: "sqlite" },
    hibernate: { idleMs: 60_000 },
    watchdog: { silentMs: 300_000, toolMs: 8_000, cancelTimeoutMs: 20_000 },
    interaction: { parkTimeoutMs: 0 },
    diff: { provider: "git" },
    webhooks: {
      enabled: true,
      mode: "allowlist",
      allow: [new URL(receiver.url).origin],
      // Ruling M2-R16: §24.6's CIDR check is ABSOLUTE, so the default list (which contains
      // `127.0.0.0/8`) would 403 every delivery to a loopback receiver. It is emptied HERE, in
      // the one config that needs it, and never in a shared default.
      denyCidrs: [],
      secrets: { ci: secret },
    },
    tokens: [
      {
        id: "a",
        secret: tokenA,
        role: "admin",
        cwdRoots: [workspace],
        maxWorkers: 8,
        webhookSecret: secret,
      },
    ],
    agents: [
      agent("asker", { PATCH_ASK: "1", PATCH_FILES: '{"hello.txt":"hello\\n"}' }),
      agent("writer", { PATCH_FILES: '{"report.txt":"OMNI-M2\\n"}' }),
      {
        id: "staller",
        command: process.execPath,
        args: [fixtureAgentPath("stall-in-tool")],
      },
    ],
  });
  await daemon.start();
  const url = daemon.url ?? "";
  // TWO clients on ONE token: the SDK mints a ULID per `connect()`, which is what makes them two
  // controllers rather than one (§16.1 rule L4).
  const A = await OmniACP.connect({ url, token: tokenA });
  const B = await OmniACP.connect({ url, token: tokenA });

  const rig: Rig = {
    daemon,
    url,
    tokenA,
    A,
    B,
    workspace,
    receiver,
    secret,
    async dispose(): Promise<void> {
      await A.close().catch(() => undefined);
      await B.close().catch(() => undefined);
      await daemon.stop({ graceful: true }).catch(() => undefined);
      await receiver.close().catch(() => undefined);
    },
  };
  live = rig;
  return rig;
}

/** Every envelope of a worker's life, through the SDK's own resumable tail. */
async function envelopesOf(rig: Rig, workerId: string): Promise<Record<string, unknown>[]> {
  const worker = await rig.A.attach(workerId);
  const out: Record<string, unknown>[] = [];
  try {
    for await (const envelope of worker.events({
      since: 0,
      signal: AbortSignal.timeout(3_000),
    })) {
      out.push(envelope as unknown as Record<string, unknown>);
      if (out.length > 500) break;
    }
  } catch {
    // The signal fires on a live worker's stream, which is how a bounded read ends.
  }
  return out;
}

const sink = () => {
  let out = "";
  return {
    io: {
      stdout: { write: (c: string) => ((out += c), true) } as unknown as NodeJS.WritableStream,
      stderr: { write: () => true } as unknown as NodeJS.WritableStream,
    },
    text: () => out,
  };
};

describe("M2-WP-J — the join: the §4 script over fixtures", () => {
  it(
    "step 1: a park reaches requires_action, the SDK answers allow, and the file exists",
    { timeout: STEP_MS },
    async () => {
      const rig = await startRig();
      const cwd = join(rig.workspace, "step1");
      await mkdir(cwd, { recursive: true });
      if (!NO_GIT) await initGitRepoAt(cwd);

      // `onUnresolved: "park"` is ALSO D10's switch: it is the only value under which this worker
      // declares `clientCapabilities.elicitation` (F28, §19.2).
      const w: Worker = await rig.A.createAgent("asker", {
        cwd,
        onUnresolved: "park",
        parkTimeoutMs: 0,
        // A policy whose DEFAULT is `park`, because that is what "unresolved" means: `deny-all`
        // decides every request on its own and nothing would ever reach a human (§20.3, §19.1).
        policy: { default: "park" },
      });
      expect(w.snapshot.state).toBe("ready");
      expect(w.snapshot.onUnresolved).toBe("park");
      expect(w.snapshot.capabilities?.clientCapabilities).toEqual({ elicitation: { form: {} } });
      // The six defaults, seen through the SDK on one snapshot (acceptance 7).
      expect(w.snapshot.watchdog).toMatchObject({ toolMs: 8_000, cancelTimeoutMs: 20_000 });
      expect(w.snapshot.policy).toMatchObject({ default: "park", onUnresolved: "park" });
      expect(w.snapshot.patchMode).toBe("on_write");
      expect(w.snapshot.mcp).toEqual({ requested: [], applied: [], dropped: [] });

      // DESIGN §9.1's shape, with the answer HELD: the handler hands the request to the test
      // instead of answering it, because a park that is answered in 8 ms (which is what the SDK
      // does when the handler calls `allow()` inline) is a park no observer can ever see. The
      // whole point of `requires_action` is that it is a state somebody else can read.
      const parked: string[] = [];
      let arrive!: (req: InteractionRequestHandle) => void;
      const arrived = new Promise<InteractionRequestHandle>((resolve) => {
        arrive = resolve;
      });
      const off = w.on("interaction", (req) => {
        parked.push(req.requestId);
        arrive(req);
      });
      const turn = w.prompt("write hello.txt");
      const held = await arrived;

      // The OBSERVER sees the park through the ordinary routes, and may not answer it: reading is
      // ungated, answering is the holder's (M2-R6, rule L2).
      let view = await rig.B.attach(w.id);
      for (let i = 0; i < 200 && view.snapshot.state !== "requires_action"; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        view = await rig.B.attach(w.id);
      }
      expect(view.snapshot.state).toBe("requires_action");
      expect(view.snapshot.interactions?.length).toBe(1);

      const refused = await fetch(
        `${rig.url}/v1/workers/${w.id}/interactions/${view.snapshot.interactions?.[0]?.requestId ?? ""}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${rig.tokenA}`,
            "content-type": "application/json",
            "omni-client-id": "cli_observer_b",
          },
          body: JSON.stringify({ action: "deny" }),
        },
      );
      expect(refused.status).toBe(423);
      const fenced = (await refused.json()) as { lease?: { holder?: unknown } };
      expect(fenced.lease?.holder).not.toBeNull();

      // Only NOW does the human answer, which is what makes `parkedMs` a real number.
      await held.allow();
      const result = await turn;
      off();

      expect(result.stopReason).toBe("end_turn");
      // The file is on DISK. That is the whole of step 1: a human's answer reached the agent and
      // the agent did the thing.
      expect(await readFile(join(cwd, "hello.txt"), "utf8")).toBe("hello\n");
      expect(parked).toHaveLength(1);

      expect(result.interactions).toHaveLength(1);
      const record = result.interactions[0];
      expect(record).toMatchObject({ decision: "allow", by: "human" });
      // D4 rule 1: only an OFFERED option is ever sent; rule 3: never an `allow_always`.
      expect(record?.optionId).toBe("allow");
      expect(record?.parkedMs ?? 0).toBeGreaterThan(0);

      // M2-R4: exactly ONE `omni.policy_decision` for that request — the park and the answer are
      // one decision, not two.
      const envelopes = await envelopesOf(rig, w.id);
      const decisions = envelopes.filter((e) => e["kind"] === "omni.policy_decision");
      expect(decisions).toHaveLength(1);
      // The DECISION is what the human chose; `by:"human"` is what says who chose it. One
      // envelope for one request, whichever way it went (M2-R4).
      const decided = decisions[0]?.["payload"] as PolicyDecisionPayload;
      expect(decided.decision).toBe("allow");
      expect(decided.by).toBe("human");
      const interactions = envelopes
        .filter((e) => e["kind"] === "acp.interaction")
        .map((e) => e["payload"] as InteractionPayload);
      expect(interactions[0]).toMatchObject({ status: "pending", kind: "permission" });
      expect(interactions.at(-1)).toMatchObject({ status: "answered" });

      // And the patch is there, from the same turn (step 5's half that a fixture can prove).
      if (!NO_GIT) {
        expect(result.patch).toContain("hello.txt");
        expect(result.patchInfo?.quality).toBe("exact");
      }
    },
  );

  it(
    "step 2: the tool budget cancels a stalled turn, and the stranded call is reported",
    { timeout: STEP_MS },
    async () => {
      const rig = await startRig();
      const w = await rig.A.createAgent("staller", { cwd: rig.workspace });
      expect(w.snapshot.watchdog).toMatchObject({ toolMs: 8_000 });

      const started = Date.now();
      const result = await w.prompt("stall in a tool");
      const elapsed = Date.now() - started;

      // It SETTLED — the half of ruling M2-R8 a hang would violate — and it took about the tool
      // budget rather than the silent one.
      expect(elapsed).toBeLessThan(60_000);
      expect(elapsed).toBeGreaterThan(5_000);
      expect(result.stopReason === "cancelled" || result.error !== null).toBe(true);
      // F36: the call the agent was running is left non-terminal forever, and we report it
      // rather than synthesizing a status no agent sent.
      expect(result.strandedToolCalls).toHaveLength(1);
      expect(result.verdict === "partial" || result.verdict === "failed").toBe(true);

      const envelopes = await envelopesOf(rig, w.id);
      const errors = envelopes.filter((e) => e["kind"] === "omni.error");
      // §21.5's ladder order: `omni.error{agent_timeout}` FIRST, because that is what makes the
      // verdict `failed` and what a `?since=` reader sees.
      expect(errors.length).toBeGreaterThan(0);
      expect((errors[0]?.["payload"] as { code: string }).code).toBe("agent_timeout");
    },
  );

  it(
    "step 4: a run delivers exactly one webhook, signed, with the eight thin keys",
    { timeout: STEP_MS },
    async () => {
      const rig = await startRig();
      const created = await rig.A.runs.create({
        agent: "writer",
        cwd: rig.workspace,
        prompt: [{ type: "text", text: "write the report" }],
        webhook: { url: rig.receiver.url, secret: "ci" },
      });
      // H25 is ACCEPTED, not "finished": the run converges on the daemon's own time, and a
      // fixture turn is fast enough that it may already have.
      expect(["queued", "starting", "running", "succeeded"]).toContain(created.state);

      let settled: RunSnapshot = created;
      for (let i = 0; i < 300; i += 1) {
        settled = await rig.A.runs.get(created.runId);
        if (["succeeded", "failed", "cancelled"].includes(settled.state)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(settled.state).toBe("succeeded");
      expect(settled.result).not.toBeNull();
      // The run's own worker wrote the file, so a run is a real turn and not a stub.
      await expect(stat(join(rig.workspace, "report.txt"))).resolves.toBeDefined();

      for (let i = 0; i < 300 && rig.receiver.received.length === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(rig.receiver.received).toHaveLength(1);
      const payload = JSON.parse(rig.receiver.received[0]?.body ?? "{}") as WebhookPayload;
      // EXACTLY eight keys (§24.3, ruling M2-R13's `workerId` included), so a receiver comes back
      // and pulls rather than being handed a turn.
      expect(Object.keys(payload).sort()).toEqual([
        "daemonId",
        "deliveryId",
        "event",
        "runId",
        "seq",
        "sessionId",
        "ts",
        "workerId",
      ]);
      expect(payload.runId).toBe(created.runId);
      expect(rig.receiver.verify(0, rig.secret)).toBe(true);
      expect(rig.receiver.verify(0, "the-wrong-secret-which-is-32-bytes!!")).toBe(false);
    },
  );

  it(
    "step 6: a resource_link outside every cwdRoot is 400, and the path is elided",
    { timeout: STEP_MS },
    async () => {
      const rig = await startRig();
      const outside = await tempRoot("omni-m2-outside-");
      const w = await rig.A.createAgent("writer", { cwd: rig.workspace });

      // Through the SDK, so the request carries the HOLDER's client id: a raw `fetch` would be a
      // second client and would meet the lease's `423` before the content gate was ever reached.
      const refused = await w
        .prompt([
          { type: "text", text: "read this" },
          { type: "resource_link", uri: `file://${outside}/secret.txt`, name: "secret.txt" },
        ] as never)
        .then(
          () => null,
          (e: unknown) => e as { code?: string; message?: string },
        );
      expect(refused).not.toBeNull();
      expect(refused?.code).toBe("bad_request");
      // The message ELIDES the path, so a probe cannot use the 400 to map the filesystem (§26.2).
      expect(refused?.message ?? "").not.toContain(outside);
      // …and the worker is still usable, because the admission was rolled back.
      expect((await rig.A.attach(w.id)).snapshot.state).toBe("ready");
    },
  );

  it(
    "the CLI reads the same daemon: workers, interactions, answer, runs, deliveries",
    { timeout: STEP_MS },
    async () => {
      const rig = await startRig();
      const cwd = join(rig.workspace, "cli");
      await mkdir(cwd, { recursive: true });

      // Created and prompted over RAW HTTP with no `Omni-Client-Id`, because that is what the CLI
      // is: one token, no client id, no stream. An SDK client would hold the lease with a ULID
      // the CLI cannot present, and every answer would be a `423` — which is the lease working,
      // not the CLI failing (§16.1 rule L4).
      const headers = {
        authorization: `Bearer ${rig.tokenA}`,
        "content-type": "application/json",
      };
      const created = await fetch(`${rig.url}/v1/workers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "asker",
          cwd,
          onUnresolved: "park",
          parkTimeoutMs: 0,
          policy: { default: "park" },
        }),
      });
      expect(created.status).toBe(201);
      const worker = (await created.json()) as { workerId: string };
      const prompted = await fetch(`${rig.url}/v1/workers/${worker.workerId}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: [{ type: "text", text: "write hello.txt" }] }),
      });
      expect(prompted.status).toBe(202);
      const { turnId } = (await prompted.json()) as { turnId: string };

      const args = ["--url", rig.url, "--token", rig.tokenA];
      // `omni-acp workers` prints `requires_action` AND the pending count (acceptance 11). The
      // poll is the CLI's own output, so what is asserted is what an operator would see.
      let workers = sink();
      for (let i = 0; i < 200; i += 1) {
        workers = sink();
        expect(await main(["workers", ...args], {}, workers.io)).toBe(0);
        if (workers.text().includes("requires_action")) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(workers.text()).toContain("requires_action");
      expect(workers.text()).toMatch(/requires_action.*\s1\s/);

      // `omni-acp interactions <wid>` lists the pending set…
      const listed = sink();
      expect(await main(["interactions", worker.workerId, ...args], {}, listed.io)).toBe(0);
      expect(listed.text()).toContain("session/request_permission");
      expect(listed.text()).toContain("allow(allow_once)");
      const reqId = /\b(x_[0-9A-HJKMNP-TV-Z]{26})\b/.exec(listed.text())?.[1] ?? "";
      expect(reqId).not.toBe("");

      // …and `interactions answer --allow` releases it, which is a human unblocking an agent from
      // a terminal — the whole reason the command exists.
      const answered = sink();
      const code = await main(
        ["interactions", "answer", worker.workerId, reqId, "--allow", ...args],
        {},
        answered.io,
      );
      expect(code).toBe(0);
      expect(answered.text()).toContain("answered");

      // The agent did the thing, and the file is on disk.
      for (let i = 0; i < 200; i += 1) {
        const turn = await fetch(`${rig.url}/v1/workers/${worker.workerId}/turns/${turnId}`, {
          headers,
        });
        const status = (await turn.json()) as { state: string };
        if (status.state === "completed") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await readFile(join(cwd, "hello.txt"), "utf8")).toBe("hello\n");

      // `runs` and `deliveries` answer on a daemon that has neither, rather than throwing.
      const runs = sink();
      expect(await main(["runs", ...args], {}, runs.io)).toBe(0);
      expect(runs.text()).toContain("no runs");
      const deliveries = sink();
      expect(await main(["deliveries", ...args], {}, deliveries.io)).toBe(0);
      expect(deliveries.text()).toContain("no deliveries");
    },
  );
});
