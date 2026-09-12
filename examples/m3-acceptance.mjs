// docs/M3-WP1-CREDENTIALS.md §验收, run for REAL against claude-acp and codex-acp.
//
//   node m3-acceptance.mjs claude | codex
//
// This is the script whose output IS `docs/M3-WP1-CREDENTIALS.md` §Real-agent record. It is kept in
// the repository rather than thrown away for one reason: the record makes claims about latencies,
// resume outcomes and what a real agent writes into a home, and a claim about a real agent that
// nobody can re-run is a claim that decays into a note. Re-running it is one command.
//
// It builds the daemon with `createDaemon` rather than `OmniACP.local()` for one reason: acceptance
// 6 needs TWO tokens with secrets this script knows, and `local()` mints its own secret and honours
// only the first token's ACL. Everything else goes through the ordinary SDK over real loopback HTTP.
//
// Prompts are deliberately tiny: every one of them is a real turn against a real subscription.
import { mkdtemp, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmniACP } from "@omni-acp/client";
import { createDaemon } from "@omni-acp/daemon";

const WHICH = process.argv[2] ?? "claude";
const AGENTS = {
  claude: {
    id: "claude-acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.73.0"],
    files: [".credentials.json"],
    reload: "file",
    // A prompt this agent takes long enough over that a forced restart has something to interrupt.
    slow: "Count from 1 to 60, one number per line, with a brief pause between each line.",
  },
  codex: {
    id: "codex-acp",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.8.0"],
    files: ["auth.json"],
    reload: "restart",
    slow: "Count from 1 to 60, one number per line, with a brief pause between each line.",
  },
};
const A = AGENTS[WHICH];
if (!A) throw new Error("usage: m3-acceptance.mjs claude|codex");

const TOKEN_A = "m3-acceptance-secret-0123456789ab";
const TOKEN_B = "m3-acceptance-peer-0123456789abcd";

const results = [];
const record = (item, status, detail) => {
  results.push({ item, status, detail });
  console.log(`[${status.toUpperCase()}] ${item}: ${detail}`);
};
const fail = (item, e) =>
  record(item, "fail", `${e?.code ?? ""} ${e?.message ?? String(e)}`.trim());

const workspace = await mkdtemp(join(tmpdir(), "omni-m3-ws-"));
const dataDir = await mkdtemp(join(tmpdir(), "omni-m3-data-"));

const credential = await OmniACP.localCredential(A.id);
const PLANTED = Object.values(credential.files)[0];
console.log(`local login: ${Object.keys(credential.files).join(",")} (${PLANTED.length} bytes)`);

const daemon = await createDaemon({
  dataDir,
  listen: { host: "127.0.0.1", port: 0 },
  tokens: [
    { id: "local", secret: TOKEN_A, role: "admin", cwdRoots: [workspace] },
    // The SECOND token, for acceptance 6's cross-token 403.
    { id: "peer", secret: TOKEN_B, role: "user", cwdRoots: [workspace] },
  ],
  agents: [{ id: A.id, command: A.command, args: A.args }],
  handshakeTimeoutMs: 240_000,
  hibernate: { wakeTimeoutMs: 240_000 },
  turn: { hardMs: 600_000 },
  // Short enough that acceptance 1's retention half runs inside this script.
  eventLog: { retentionSweepMs: 1_500 },
  credentials: { homeRetentionDays: 0 },
  logLevel: "warn",
});
await daemon.start();
const url = daemon.url;
console.log(`daemon at ${url}\ndataDir ${dataDir}`);

const server = await OmniACP.connect({ url, token: TOKEN_A, requestTimeoutMs: 300_000 });

/** Every SSE frame a worker's stream has to offer right now. */
async function sse(workerId, budgetMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  let text = "";
  try {
    const res = await fetch(`${url}/v1/workers/${workerId}/events?since=0`, {
      headers: { authorization: `Bearer ${TOKEN_A}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    for await (const chunk of res.body) text += decoder.decode(chunk, { stream: true });
  } catch {
    // The abort is how this ends for a LIVE worker: `stream_end` only arrives for a closed one.
  } finally {
    clearTimeout(timer);
  }
  const ids = [];
  const envelopes = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("id:")) ids.push(Number(line.slice(3).trim()));
    if (line.startsWith("data:")) {
      try {
        envelopes.push(JSON.parse(line.slice(5)));
      } catch {
        /* a control frame */
      }
    }
  }
  return { text, ids, envelopes };
}

const t0 = Date.now();
try {
  // ── acceptance 3 (first: everything else needs a stored credential) ─────────
  try {
    const before = (await server.agents()).find((a) => a.id === A.id)?.login?.state;
    const at = Date.now();
    const put = await server.credentials.put(A.id, credential);
    const putMs = Date.now() - at;
    const entry = (await server.agents()).find((a) => a.id === A.id);
    const haystack = JSON.stringify([
      await server.agents(),
      await server.credentials.list(),
      await server.credentials.get(A.id),
      await server.credentials.check(A.id),
    ]);
    const leaked = haystack.includes(PLANTED);
    record(
      "3 put(localCredential) → default for a new worker, login.state ok, no leak",
      entry?.login?.state === "ok" && !leaked ? "pass" : "fail",
      `login before=${before} after=${entry?.login?.state} method=${put.method} ` +
        `fingerprint=${put.fingerprint} expiresAt=${put.expiresAt ?? "-"} put=${putMs}ms leaked=${leaked}`,
    );
  } catch (e) {
    fail("3 put(localCredential)", e);
  }

  // ── acceptance 2: credential:"none" is 422 at CREATE ───────────────────────
  try {
    const at = Date.now();
    let code = "(no error)";
    try {
      await server.createAgent(A.id, { cwd: workspace, credential: "none" });
    } catch (e) {
      code = e.code;
    }
    record(
      '2 credential:"none" is 422 credential_required at create, not on the first prompt',
      code === "credential_required" ? "pass" : "fail",
      `code=${code} in ${Date.now() - at}ms; homes on disk: ` +
        `[${(await readdir(join(dataDir, "homes")).catch(() => [])).join(" ")}]`,
    );
  } catch (e) {
    fail('2 credential:"none" at create', e);
  }

  // ── acceptance 1: two homes, one canonical file ────────────────────────────
  let first;
  let second;
  try {
    const at = Date.now();
    first = await server.createAgent(A.id, { cwd: workspace });
    const firstMs = Date.now() - at;
    const at2 = Date.now();
    second = await server.createAgent(A.id, { cwd: workspace });
    const secondMs = Date.now() - at2;

    const targets = await Promise.all(
      [first, second].map((w) => readlink(join(w.snapshot.home, A.files[0]))),
    );
    const modes = await Promise.all(
      [first, second].map(async (w) => ((await stat(w.snapshot.home)).mode & 0o777).toString(8)),
    );
    const ta = Date.now();
    const a = await first.prompt("Reply with the single word OK.");
    const turnA = Date.now() - ta;
    const tb = Date.now();
    const b = await second.prompt("Reply with the single word OK.");
    const turnB = Date.now() - tb;
    const contents = await Promise.all([
      readdir(first.snapshot.home),
      readdir(second.snapshot.home),
    ]);
    record(
      "1 isolated homes, credential symlinked to ONE canonical file, both prompt",
      first.snapshot.home !== second.snapshot.home &&
        targets[0] === targets[1] &&
        modes.every((m) => m === "700") &&
        a.stopReason !== null &&
        b.stopReason !== null &&
        a.verdict === "ok" &&
        b.verdict === "ok"
        ? "pass"
        : "fail",
      `create ${firstMs}ms / ${secondMs}ms; link -> ${targets[0]}; modes ${modes.join(",")}; ` +
        `turns ${a.verdict}(${turnA}ms)/${b.verdict}(${turnB}ms); ` +
        `A home holds [${contents[0].join(" ")}]`,
    );
  } catch (e) {
    fail("1 isolated homes", e);
  }

  // ── acceptance 4: restart resumes ──────────────────────────────────────────
  try {
    await first.prompt("Remember the word lighthouse. Reply with just OK.");
    const before = (await server.attach(first.id)).snapshot;
    const holderBefore = JSON.stringify(before.lease.holder);

    const at = Date.now();
    const restarted = await first.restart({ reason: "m3 acceptance 4" });
    const restartMs = Date.now() - at;

    const after = (await server.attach(first.id)).snapshot;
    const tr = Date.now();
    const recalled = await first.prompt("What word did I ask you to remember? Answer in one word.");
    const recallMs = Date.now() - tr;
    const remembered = /lighthouse/i.test(recalled.text);

    const { ids } = await sse(first.id);
    const contiguous = ids.length > 0 && ids.every((s, i) => s === i + 1);

    record(
      "4 restart resumes, generation +1, lease kept, home kept, seq contiguous, recall works",
      restarted.resume.outcome === "landed" &&
        restarted.generation === before.generation + 1 &&
        after.home === before.home &&
        JSON.stringify(after.lease.holder) === holderBefore &&
        restarted.sessionId === before.sessionId &&
        contiguous &&
        remembered
        ? "pass"
        : "fail",
      `resume.outcome=${restarted.resume.outcome} rule=${restarted.resume.rule} ` +
        `method=${restarted.resume.method} replayed=${restarted.resume.replayedEvents} ` +
        `gen ${before.generation}->${restarted.generation} restart=${restartMs}ms ` +
        `pid ${before.process?.pid}->${restarted.pid} ` +
        `lease-kept=${JSON.stringify(after.lease.holder) === holderBefore} ` +
        `home-kept=${after.home === before.home} session-kept=${restarted.sessionId === before.sessionId} ` +
        `seq=1..${ids.at(-1)} contiguous=${contiguous} ` +
        `recall(${recallMs}ms)="${recalled.text.trim().replace(/\s+/g, " ").slice(0, 90)}" ` +
        `remembered=${remembered}`,
    );
  } catch (e) {
    fail("4 restart resumes", e);
  }

  // ── acceptance 5: restart({force:true}) interrupts a running turn ──────────
  try {
    const victim = await server.createAgent(A.id, { cwd: workspace });
    const turn = victim.prompt(A.slow);
    // Wait until the agent is genuinely mid-turn: poll rather than sleep a fixed amount.
    let state = "";
    for (let i = 0; i < 40; i += 1) {
      state = (await server.attach(victim.id)).snapshot.state;
      if (state === "running") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    // …and then let it produce some real output, so the projection has something to have kept.
    await new Promise((r) => setTimeout(r, 2500));

    let refusedCode = "(none)";
    try {
      await victim.restart();
    } catch (e) {
      refusedCode = e.code;
    }
    const at = Date.now();
    const forced = await victim.restart({ force: true, reason: "m3 acceptance 5" });
    const forcedMs = Date.now() - at;

    const aggregate = await turn;
    const status = await victim.turn(aggregate.turnId);
    const { envelopes } = await sse(victim.id);
    const idles = envelopes.filter(
      (e) =>
        e.turnId === aggregate.turnId &&
        e.kind === "acp.session_update" &&
        e.payload?.sessionUpdate === "state_update" &&
        e.payload?.state === "idle",
    );

    record(
      "5 restart({force:true}) ends the turn with `restarted`, and no synthesized idle",
      state === "running" &&
        refusedCode === "worker_busy" &&
        aggregate.error?.code === "restarted" &&
        aggregate.stopReason === null &&
        idles.length === 0 &&
        forced.terminatedTurn === aggregate.turnId
        ? "pass"
        : "fail",
      `state-before=${state} unforced=${refusedCode} forced=${forcedMs}ms ` +
        `error=${aggregate.error?.code} stopReason=${aggregate.stopReason} verdict=${aggregate.verdict} ` +
        `text=${aggregate.text.trim().length}b stranded=${JSON.stringify(aggregate.strandedToolCalls)} ` +
        `synthesized-idles=${idles.length} turnStatus=${status.state} ` +
        `terminatedTurn-matches=${forced.terminatedTurn === aggregate.turnId} ` +
        `gen=${forced.generation}`,
    );
    // It still works afterwards, which is what makes it a restart rather than a close.
    const afterForce = await victim.prompt("Reply with the single word OK.");
    record(
      "5b the worker takes prompts again on the new process",
      afterForce.stopReason !== null ? "pass" : "fail",
      `verdict=${afterForce.verdict} stopReason=${afterForce.stopReason}`,
    );
    await victim.close().catch(() => {});
  } catch (e) {
    fail("5 restart({force:true})", e);
  }

  // ── acceptance 6: setCredential + cross-token 403 + no secret in events ────
  try {
    await server.credentials.put(A.id, credential, "rotated");
    const genBefore = (await server.attach(second.id)).snapshot.generation;
    const at = Date.now();
    const applied = await second.setCredential("rotated");
    const appliedMs = Date.now() - at;

    const { text, envelopes } = await sse(second.id);
    const audit = envelopes.filter((e) => e.kind === "omni.credential");

    // The cross-token 403: `peer` stores a name `local` does not have, then `local` asks for it.
    const peer = await OmniACP.connect({ url, token: TOKEN_B, requestTimeoutMs: 60_000 });
    await peer.credentials.put(A.id, credential, "theirs");
    let crossCode = "(none)";
    let crossMessage = "";
    try {
      await server.createAgent(A.id, { cwd: workspace, credential: "theirs" });
    } catch (e) {
      crossCode = e.code;
      crossMessage = e.message;
    }
    await peer.close();

    const expected = A.reload === "file" ? "immediate" : "restarted";
    const genAfter = (await server.attach(second.id)).snapshot.generation;
    record(
      "6 setCredential reports what actually happened; cross-token is 403; no secret in the audit",
      applied.applied === expected &&
        crossCode === "credential_forbidden" &&
        audit.length === 1 &&
        !text.includes(PLANTED)
        ? "pass"
        : "fail",
      `applied=${applied.applied} (expected ${expected} for measured reload:"${A.reload}") ` +
        `in ${appliedMs}ms; fingerprint=${applied.credential.fingerprint} previous=${applied.previous}; ` +
        `generation ${genBefore}->${genAfter}; audit-envelopes=${audit.length} ` +
        `audit=${JSON.stringify(audit[0]?.payload ?? null)}; ` +
        `cross-token=${crossCode} ("${crossMessage.slice(0, 70)}"); ` +
        `secret-in-stream=${text.includes(PLANTED)}`,
    );
  } catch (e) {
    fail("6 setCredential + cross-token 403", e);
  }

  // ── acceptance 7: a store PUT names the workers that need a restart ────────
  try {
    const linked = (await server.workers()).filter(
      (w) => w.credential?.name === "default" && w.state !== "closed",
    );
    const updated = await server.credentials.put(A.id, credential);
    const expectedRestart = A.reload === "restart" ? linked.length : 0;
    record(
      "7 a store PUT reports workersAffected and lists restartRequired",
      updated.workersAffected === linked.length &&
        updated.restartRequired.length === expectedRestart
        ? "pass"
        : "fail",
      `workersAffected=${updated.workersAffected} linked-live=${linked.length} ` +
        `restartRequired=[${updated.restartRequired.join(" ")}] ` +
        `(expected ${expectedRestart} for measured reload:"${A.reload}") inUseBy=${updated.inUseBy}`,
    );
  } catch (e) {
    fail("7 PUT restartRequired", e);
  }

  // ── acceptance 1b: the home is REMOVED by the retention sweep ──────────────
  //
  // This daemon runs `homeRetentionDays: 0`, so a closed worker's home is eligible the instant it
  // closes. That makes the deletion half testable in four seconds and the "kept at close" half
  // UNTESTABLE here by construction — the sweep fires every 1.5 s and legitimately wins the race.
  // 1c below takes that half against a daemon with a real retention window.
  try {
    const homeA = first.snapshot.home;
    await writeFile(join(homeA, "acceptance-marker"), "x");
    const beforeClose = await readdir(homeA);
    await first.close();
    await second.close();
    await new Promise((r) => setTimeout(r, 5000));
    const afterSweep = await readdir(homeA).catch(() => null);
    record(
      "1b the home is removed by the retention sweep once the worker has closed",
      afterSweep === null ? "pass" : "fail",
      `before close: [${beforeClose.join(" ")}]; ` +
        `after sweep (homeRetentionDays: 0): ${
          afterSweep === null ? "(gone)" : `[${afterSweep.join(" ")}]`
        }`,
    );
  } catch (e) {
    fail("1b home removed by the sweep", e);
  }
  // ── acceptance 1c: the home is KEPT at close, under a real retention window ─
  //
  // A SECOND daemon, because the first one's `homeRetentionDays: 0` makes this claim untestable.
  // No prompt is sent: the handshake alone is what makes the agent write its own files into the
  // home, which is the thing that has to survive (E7), and a turn would cost tokens for no
  // additional evidence.
  try {
    const keepDir = await mkdtemp(join(tmpdir(), "omni-m3-keep-"));
    const keepDaemon = await createDaemon({
      dataDir: keepDir,
      listen: { host: "127.0.0.1", port: 0 },
      tokens: [{ id: "local", secret: TOKEN_A, role: "admin", cwdRoots: [workspace] }],
      agents: [{ id: A.id, command: A.command, args: A.args }],
      handshakeTimeoutMs: 240_000,
      // Sweeps often, keeps for a day: the opposite of the daemon above, on purpose.
      eventLog: { retentionSweepMs: 1_000 },
      credentials: { homeRetentionDays: 1 },
      logLevel: "warn",
    });
    await keepDaemon.start();
    const keepServer = await OmniACP.connect({
      url: keepDaemon.url,
      token: TOKEN_A,
      requestTimeoutMs: 300_000,
    });
    try {
      await keepServer.credentials.put(A.id, credential);
      const worker = await keepServer.createAgent(A.id, { cwd: workspace });
      const home = worker.snapshot.home;
      await worker.close();
      // Three sweep intervals, so this is "the sweep ran and left it" rather than "no sweep ran".
      await new Promise((r) => setTimeout(r, 3500));
      const kept = await readdir(home).catch(() => null);
      record(
        "1c the home is KEPT at close, so a post-mortem can still read the agent's own files",
        kept !== null && kept.length > 0 ? "pass" : "fail",
        `after close + 3 sweeps (homeRetentionDays: 1): ${
          kept === null ? "(gone)" : `[${kept.join(" ")}]`
        }`,
      );
    } finally {
      await keepServer.close().catch(() => {});
      await keepDaemon.stop({ graceful: true }).catch(() => {});
    }
  } catch (e) {
    fail("1c home kept at close", e);
  }
} finally {
  await server.close().catch(() => {});
  await daemon.stop({ graceful: true }).catch(() => {});
  console.log(`\n=== ${A.id} — ${Date.now() - t0}ms ===`);
  for (const r of results) console.log(`${r.status.toUpperCase().padEnd(5)} ${r.item}`);
  console.log(`\nJSON ${JSON.stringify(results)}`);
}
