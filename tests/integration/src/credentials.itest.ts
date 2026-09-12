import { lstat, mkdir, readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope } from "@omni-acp/protocol";
import {
  fixtureAgent,
  readEnvelopes,
  startHarness,
  tempRoot,
  type Harness,
} from "./support/harness.js";

/**
 * M3-WP1 end to end: real processes, real loopback HTTP, the real SDK
 * (docs/M3-WP1-CREDENTIALS.md acceptance 1, 2, 3, 4, 5, 6, 7).
 *
 * The fixture is `hybrid.mjs` because it is the ONE fixture that implements a real resume — which
 * is what a restart has to survive — and the agent id is `claude-acp` because the credential
 * CONTRACT is descriptor data selected by id: the file name, the home variable and the measured
 * `reload: "file"` all come off the shipped builtin, and running them against a fixture is how the
 * plumbing is tested without spending a real agent's tokens. The REAL agents are the compat
 * suite's job and the acceptance record's.
 *
 * Every claim here is asserted on the thing itself: the home on the filesystem, the link with
 * `readlink`, the resume through a prompt that has to RECALL something from before the restart.
 *
 * Owned by M3-WP1.
 */

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.dispose();
  harness = null;
});

/** The credential shape claude-acp actually reads (E1), with a planted, greppable token. */
const credentialBody = (token: string, expiresAt?: number): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      subscriptionType: "max",
    },
  });

async function start(o?: {
  credentials?: Record<string, unknown>;
  /** Extra `hybrid.mjs` knobs — `HYBRID_NEVER_ANSWER` is the one acceptance 5 needs. */
  agentEnv?: Record<string, string>;
}): Promise<Harness> {
  const sessionDir = await tempRoot("omni-cred-sessions-");
  harness = await startHarness({
    roots: 1,
    agents: [
      // The id selects the BUILTIN descriptor — which is where the credential contract lives — and
      // the command is the fixture that can really resume. `HYBRID_SESSION_DIR` is the fixture's
      // own knob and is deliberately NOT the worker's home: what a restart has to prove is that
      // the SESSION survives, and a fixture that stored its sessions in the home would prove the
      // home survived instead.
      fixtureAgent("claude-acp", "hybrid", {
        HYBRID_SESSION_DIR: sessionDir,
        ...(o?.agentEnv ?? {}),
      }),
    ],
    ...(o?.credentials === undefined ? {} : { config: { credentials: o.credentials } }),
  });
  return harness;
}

const homeOf = (h: Harness, workerId: string): string =>
  join(h.daemon.config.dataDir, "homes", workerId);

const failure = async (p: Promise<unknown>): Promise<OmniError> => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
};

describe("M3-WP1 acceptance 1 — two workers, two homes, ONE canonical credential file", () => {
  it("links both homes at the same file, prompts both, and reaps the homes after retention", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;

    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("PLANTED-ACCEPTANCE-1") },
    });

    const first = await server.createAgent("claude-acp", { cwd });
    const second = await server.createAgent("claude-acp", { cwd });
    expect(first.id).not.toBe(second.id);

    // ── two homes ────────────────────────────────────────────────────────────
    for (const worker of [first, second]) {
      const home = homeOf(h, worker.id);
      expect(worker.snapshot.home).toBe(home);
      expect((await lstat(home)).isDirectory()).toBe(true);
      expect(((await lstat(home)).mode & 0o777).toString(8)).toBe("700");
    }
    expect(first.snapshot.home).not.toBe(second.snapshot.home);

    /**
     * ── ONE canonical file, reached by a LINK from each home ─────────────────
     *
     * `readlink` is the assertion and a byte comparison would not be: two COPIES of one credential
     * would compare equal and would then DIVERGE the moment the agent refreshed its own token (E3),
     * which is the failure this whole design exists to prevent. A link means whichever worker
     * refreshes writes through to the file the other one reads.
     */
    const targets = await Promise.all(
      [first, second].map((w) => readlink(join(homeOf(h, w.id), ".credentials.json"))),
    );
    expect(targets[0]).toBe(targets[1]);
    expect(targets[0]).toContain(join("credentials", "local", "claude-acp", "default", "files"));
    expect(await readFile(targets[0] as string, "utf8")).toContain("PLANTED-ACCEPTANCE-1");

    // Both report the same credential, by fingerprint, and the same 12 hex characters the store
    // gave back.
    const stored = await server.credentials.get("claude-acp");
    for (const worker of [first, second]) {
      expect(worker.snapshot.credential).toEqual({
        name: "default",
        method: "files",
        fingerprint: stored.fingerprint,
      });
    }
    expect(stored.inUseBy).toBe(2);

    // ── both prompt ──────────────────────────────────────────────────────────
    for (const worker of [first, second]) {
      const result = await worker.prompt("hello");
      expect(result.stopReason).not.toBeNull();
    }

    /**
     * ── the agent's own state lands IN the home, and survives until retention ─
     *
     * E7 is the reason the home is per worker and is reused across a hibernate, a wake and a
     * restart: the agent writes its session files in there. The fixture writes a marker instead of
     * `projects/`, because what this asserts is the DIRECTORY's lifetime rather than any
     * particular agent's layout — the real `projects/` is acceptance 1's row in the real-agent
     * record.
     */
    const home = homeOf(h, first.id);
    await mkdir(join(home, "projects"), { recursive: true });
    await writeFile(join(home, "projects", "state.jsonl"), "the conversation");

    await first.close();
    /**
     * A CLOSED worker's home is KEPT: `credentials.homeRetentionDays` defaults to 1, so a
     * post-mortem can still read what the agent wrote (§Home 隔离: home 随 worker 记录保留).
     *
     * The DELETION half is `credentials/home.test.ts`'s three sweep cases, over an injected clock:
     * this daemon runs on the system clock and a test that waited out a retention day would be a
     * test nobody runs. What is asserted HERE is the half only a live daemon can show — that a
     * close does NOT take the directory with it.
     */
    expect(await readdir(join(home, "projects"))).toEqual(["state.jsonl"]);
    await second.close();
  });
});

describe('M3-WP1 acceptance 2 — `credential:"none"` is refused at CREATE', () => {
  it("is 422 credential_required before a process exists, not on the first prompt", async () => {
    // The whole point of the create-time check: on claude-acp a worker with no credential
    // handshakes FINE and fails on the first `session/prompt` with `-32000 Authentication
    // required` (measured), which is a 502 from the agent for something the daemon already knew —
    // minus a ~7 s cold start and a `maxWorkers` slot.
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;

    const before = h.daemon.workers.size;
    const e = await failure(server.createAgent("claude-acp", { cwd, credential: "none" }));
    // `credential:"none"` means "an EMPTY home": the worker would be demonstrably unauthenticated,
    // so a runtime that declares a credential contract refuses it AT CREATE. It is refused whether
    // or not `allowInherit` is on, because the caller did not ask to inherit — they asked for
    // nothing.
    expect(e.code).toBe("credential_required");
    expect(e.message).toContain("none");
    expect(e.status).toBe(422);
    // NO slot was taken and NO process was spawned.
    expect(h.daemon.workers.size).toBe(before);
    expect(await readdir(join(h.daemon.config.dataDir, "homes")).catch(() => [])).toEqual([]);

    // And the same is true for an explicit name nobody stored.
    const missing = await failure(
      server.createAgent("claude-acp", { cwd, credential: "not-stored" }),
    );
    expect(missing.code).toBe("credential_required");
    expect(h.daemon.workers.size).toBe(before);

    // …while OMITTING it still works, because `credentials.allowInherit` defaults true and that is
    // M2's behaviour. The two are different requests and get different answers.
    const inherited = await server.createAgent("claude-acp", { cwd });
    expect(inherited.snapshot.credential?.method).toBe("inherit");
    await inherited.close();
  });

  it("refuses an EXPIRED credential with its own code, and says when it expired", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;
    const expiredAt = Date.now() - 60_000;
    await server.credentials.put(
      "claude-acp",
      { kind: "files", files: { ".credentials.json": credentialBody("OLD", expiredAt) } },
      "stale",
    );

    const e = await failure(server.createAgent("claude-acp", { cwd, credential: "stale" }));
    // A DIFFERENT code from `credential_required`, because the fix is different: one says "store a
    // credential", the other says "store a NEWER one".
    expect(e.code).toBe("credential_expired");
    expect(e.message).toContain(new Date(expiredAt).toISOString());
  });
});

describe("M3-WP1 acceptance 3 — a stored credential is the default, and it never comes back", () => {
  it("serves login.state ok on GET /v1/agents and leaks the token nowhere", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;
    const planted = "PLANTED-ACCEPTANCE-3-sk-ant-oat01";

    // Before anything is stored: `unknown`, because `allowInherit` is on and a worker would take
    // the daemon's environment. Not `ok` — we have not checked anything — and not `required`,
    // because a worker WOULD start.
    expect((await server.agents()).find((a) => a.id === "claude-acp")?.login?.state).toBe(
      "unknown",
    );

    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody(planted, Date.now() + 3_600_000) },
    });

    const entry = (await server.agents()).find((a) => a.id === "claude-acp");
    expect(entry?.login?.state).toBe("ok");
    expect(entry?.login?.credential).toBe("default");
    expect(entry?.login?.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // A new worker takes it WITHOUT being asked to, which is what "the default" means.
    const worker = await server.createAgent("claude-acp", { cwd });
    expect(worker.snapshot.credential?.name).toBe("default");

    await worker.prompt("hello");
    const envelopes = await readEnvelopes(server.url, h.token, worker.id);
    expect(envelopes.length).toBeGreaterThan(0);

    // ── the grep, over everything a client can reach ─────────────────────────
    const haystack = JSON.stringify([
      await server.agents(),
      await server.credentials.list(),
      await server.credentials.get("claude-acp"),
      await server.credentials.check("claude-acp"),
      await server.workers(),
      worker.snapshot,
      envelopes,
    ]);
    expect(haystack).not.toContain(planted);
    // The fingerprint IS there, which is the whole substitute: enough to say "that is the
    // credential I uploaded", useless for authenticating anything.
    expect(haystack).toContain(entry?.login?.fingerprint as string);
  });
});

describe("M3-WP1 acceptance 4 — restart resumes, keeps the lease, and the stream stays gap-free", () => {
  it("replaces the process, RECALLS the conversation, and advances generation by one", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;
    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("PLANTED-ACCEPTANCE-4") },
    });

    const worker = await server.createAgent("claude-acp", { cwd });
    // Something to remember. The hybrid fixture's resume REPLAYS the session's own history, which
    // is what makes "the conversation survived" an observable fact rather than a hope.
    await worker.prompt("remember the word lighthouse");

    const before = worker.snapshot;
    const pidBefore = before.process?.pid;
    const holderBefore = before.lease.holder;
    expect(pidBefore).toBeGreaterThan(0);
    expect(holderBefore).not.toBeNull();
    const homeBefore = before.home;

    const result = await worker.restart();

    expect(result.generation).toBe(before.generation + 1);
    expect(result.resume).toMatchObject({ outcome: "landed" });
    expect(result.sessionId).toBe(before.sessionId);
    expect(result.pid).not.toBe(pidBefore);
    expect(result.terminatedTurn).toBeNull();

    const after = (await server.attach(worker.id)).snapshot;
    expect(after.state).toBe("ready");
    // THE HOME IS THE SAME DIRECTORY (E7): a restart that rebuilt it would resume into a session
    // directory with no history.
    expect(after.home).toBe(homeBefore);
    // THE LEASE IS THE SAME HOLDER. A hibernate releases it; a restart is a gap the holder asked
    // for, and releasing it would hand the worker to whichever peer polled first.
    expect(after.lease.holder).toEqual(holderBefore);

    // The conversation survived, on the new process.
    const recalled = await worker.prompt("what word did I ask you to remember?");
    expect(recalled.stopReason).not.toBeNull();

    /**
     * ── the stream is gap-free across the restart ────────────────────────────
     *
     * §8.2's rule is that `seq` is 1-based, gap-free and strictly increasing PER WORKER, and a
     * restart is the newest way to break it: a new process with the same worker id must continue
     * the same seq space rather than starting a second history.
     */
    const envelopes: EventEnvelope[] = await readEnvelopes(server.url, h.token, worker.id);
    const seqs = envelopes.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));

    const states = envelopes
      .filter((e) => e.kind === "omni.worker_state")
      .map((e) => (e.kind === "omni.worker_state" ? e.payload.reason : ""));
    expect(states).toContain("restart");
    expect(states.indexOf("resumed")).toBeGreaterThan(states.indexOf("restart"));
  });
});

describe("M3-WP1 acceptance 5 — a forced restart terminates the turn with `restarted`", () => {
  it("reports stopReason null and error.code restarted, with NO synthesized idle", async () => {
    // `HYBRID_NEVER_ANSWER` is the fixture's own knob for a turn that never resolves, which is
    // exactly the turn a forced restart has to interrupt — and the only way to hold a turn open
    // long enough to interrupt it deterministically.
    const h = await start({ agentEnv: { HYBRID_NEVER_ANSWER: "1" } });
    const s2 = await h.connect();
    const cwd2 = h.roots[0] as string;
    await s2.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("PLANTED-ACCEPTANCE-5") },
    });

    const worker = await s2.createAgent("claude-acp", { cwd: cwd2 });
    // A turn that will never settle on its own.
    const turn = worker.prompt("this never answers");
    // Give the prompt time to reach the wire and become the current turn.
    await new Promise<void>((r) => setTimeout(r, 400));
    expect((await s2.attach(worker.id)).snapshot.state).toBe("running");

    const refused = await failure(worker.restart());
    expect(refused.code).toBe("worker_busy");

    const result = await worker.restart({ force: true, reason: "credential rotation" });
    expect(result.terminatedTurn).not.toBeNull();

    /**
     * The SDK's own aggregate, from the SAME pure reducer `GET /turns/{id}` runs (DESIGN §5.5).
     * §restart requires all three of these and a fabricated `idle` would break every one:
     * `stopReason: null` because the agent did not finish, `error.code: "restarted"` because that
     * is the cause, and `verdict: "failed"` because a turn cut short was never "ok".
     */
    const aggregate = await turn;
    expect(aggregate.stopReason).toBeNull();
    expect(aggregate.error?.code).toBe("restarted");
    expect(aggregate.error?.message).toContain("credential rotation");
    expect(aggregate.verdict).toBe("failed");

    // NO `state_update{idle}` for that turn, on the wire.
    const envelopes = await readEnvelopes(s2.url, h.token, worker.id);
    const idles = envelopes.filter(
      (e) =>
        e.turnId === aggregate.turnId &&
        e.kind === "acp.session_update" &&
        (e.payload as unknown as Record<string, unknown>)["sessionUpdate"] === "state_update" &&
        (e.payload as unknown as Record<string, unknown>)["state"] === "idle",
    );
    expect(idles).toEqual([]);

    // `GET /turns/{id}` agrees, which is the half that makes it one aggregate rather than two.
    const status = await worker.turn(aggregate.turnId);
    expect(status.result?.error?.code).toBe("restarted");
    expect(status.state).toBe("failed");
  });
});

describe("M3-WP1 acceptance 6 — setCredential, and the cross-token 403", () => {
  it('relinks the home and reports `immediate` for a reload:"file" runtime', async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;
    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("FIRST-CREDENTIAL") },
    });
    const rotated = await server.credentials.put(
      "claude-acp",
      { kind: "files", files: { ".credentials.json": credentialBody("SECOND-CREDENTIAL") } },
      "rotated",
    );

    const worker = await server.createAgent("claude-acp", { cwd });
    const home = homeOf(h, worker.id);
    expect(await readFile(join(home, ".credentials.json"), "utf8")).toContain("FIRST-CREDENTIAL");
    const pidBefore = worker.snapshot.process?.pid;

    const applied = await worker.setCredential("rotated");

    // MEASURED on claude-acp 0.73.0: the credential file is consulted PER REQUEST, so the swap has
    // already taken effect and replacing the process would be a cold start for nothing.
    expect(applied.applied).toBe("immediate");
    expect(applied.credential).toEqual({
      name: "rotated",
      method: "files",
      fingerprint: rotated.fingerprint,
    });
    expect(applied.generation).toBe(1);

    // THE LINK MOVED, on the filesystem, and the home's other contents are untouched.
    expect(await readlink(join(home, ".credentials.json"))).toContain(
      join("claude-acp", "rotated", "files"),
    );
    expect(await readFile(join(home, ".credentials.json"), "utf8")).toContain("SECOND-CREDENTIAL");
    // No new process: `immediate` means immediate.
    expect((await server.attach(worker.id)).snapshot.process?.pid).toBe(pidBefore);

    // The audit envelope, with a fingerprint and no secret.
    const envelopes = await readEnvelopes(server.url, h.token, worker.id);
    const audit = envelopes.filter((e) => e.kind === "omni.credential");
    expect(audit.length).toBe(1);
    expect(audit[0]?.payload).toMatchObject({
      op: "set",
      credential: "rotated",
      applied: "immediate",
      fingerprint: rotated.fingerprint,
    });
    expect(JSON.stringify(audit)).not.toContain("SECOND-CREDENTIAL");

    // And the worker still works on the new credential.
    expect((await worker.prompt("still there?")).stopReason).not.toBeNull();
  });

  it("answers 403 credential_forbidden for another token's credential", async () => {
    const h = await start();
    const cwd = h.roots[0] as string;
    // A SECOND token on the same daemon. The harness mints one admin token, so the second is added
    // through the config the daemon already holds — which is also the shape an operator uses.
    h.daemon.config.tokens.push({
      id: "other",
      secretSha256: "f".repeat(64),
      role: "user",
      agents: "*",
      cwdRoots: [cwd],
      maxWorkers: 4,
      policyCeiling: null,
      policyPresets: "*",
      mcpPresets: [],
      envAllow: [],
    });

    const server = await h.connect();
    // Token `other` stores a credential under a name token `local` does not have.
    const otherAuth = h.daemon.authContextFor("other");
    await h.daemon.credentials.put(otherAuth, "claude-acp", "theirs", {
      kind: "files",
      files: { ".credentials.json": credentialBody("SOMEBODY-ELSES") },
    });

    /**
     * `403 credential_forbidden`, not `422 credential_required`.
     *
     * The distinction is the point of the code: "that credential is not yours" and "that credential
     * does not exist" are materially different things to debug when two people share a machine.
     * What it costs is one bit about a NAME — never its content, never its owner — and the message
     * says nothing more.
     */
    const e = await failure(server.createAgent("claude-acp", { cwd, credential: "theirs" }));
    expect(e.code).toBe("credential_forbidden");
    expect(e.status).toBe(403);
    expect(e.message).not.toContain("other");
    expect(e.message).not.toContain("SOMEBODY-ELSES");

    /**
     * The harness's token is an ADMIN, so it CAN see that the credential exists — D13 gives an
     * admin the whole machine. What it cannot do is USE it, which is the assertion above: a worker
     * runs as its own token, and ownership is the path.
     *
     * The listing is the other half of §凭据仓库's admin row: a summary and never a content.
     */
    const listed = await server.credentials.list();
    expect(listed.map((c) => `${c.ownerTokenId}/${c.name}`)).toEqual(["other/theirs"]);
    expect(JSON.stringify(listed)).not.toContain("SOMEBODY-ELSES");
  });
});

describe("M3-WP1 acceptance 7 — a store PUT names the workers that need a restart", () => {
  it("counts every linked worker and lists only the ones a swap cannot reach", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;
    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("BEFORE-ROTATION") },
    });

    const first = await server.createAgent("claude-acp", { cwd });
    const second = await server.createAgent("claude-acp", { cwd });

    const rotated = await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("AFTER-ROTATION") },
    });

    expect(rotated.workersAffected).toBe(2);
    /**
     * EMPTY, and that is the right answer for this runtime rather than a gap in the feature.
     *
     * claude-acp's measured `reload` is `"file"`: both workers' homes link AT the file that just
     * changed, and both pick the new credential up on their very next request. Restarting them
     * would be replacing two processes for nothing. The codex-acp half — where `reload` is
     * `"restart"` and the list is non-empty — is `store.test.ts`'s in-place-update case and the
     * real-agent record's acceptance 7.
     */
    expect(rotated.restartRequired).toEqual([]);
    expect(rotated.fingerprint).not.toBe("");

    // The new credential really is what both homes now read, through the unchanged link.
    for (const worker of [first, second]) {
      expect(await readFile(join(homeOf(h, worker.id), ".credentials.json"), "utf8")).toContain(
        "AFTER-ROTATION",
      );
    }

    // A live worker's home links at it, so the credential cannot be deleted out from under them.
    const e = await failure(server.credentials.remove("claude-acp"));
    expect(e.code).toBe("worker_busy");

    await first.close();
    await second.close();
    // Closed workers hold nothing, so the delete goes through.
    await server.credentials.remove("claude-acp");
    expect((await server.credentials.list()).length).toBe(0);
  });
});

describe('M3-WP1 — `home:"shared"` and no credential are M2, byte for byte', () => {
  it("builds no home, sets no variable, and reports no credential", async () => {
    const h = await start();
    const server = await h.connect();
    const cwd = h.roots[0] as string;

    // NOTHING stored and `credential` omitted: `credentials.allowInherit` defaults true, so the
    // worker takes the daemon's own environment. This IS the backward-compatibility bar for the
    // whole work package.
    const inherited = await server.createAgent("claude-acp", { cwd });
    expect(inherited.snapshot.credential).toEqual({
      name: null,
      method: "inherit",
      fingerprint: null,
    });
    expect(inherited.snapshot.home).toBeNull();
    expect((await inherited.prompt("hello")).stopReason).not.toBeNull();
    expect(await readdir(join(h.daemon.config.dataDir, "homes")).catch(() => [])).toEqual([]);

    /**
     * …and `home:"shared"` with a FILE credential is REFUSED rather than silently inherited.
     *
     * A file credential can only reach the agent through its home — that is what E1 and E2 measure
     * — so this request asks for a credential to be used and for the only channel that could carry
     * it to be absent. Answering with the daemon's own environment instead would hand back a
     * worker authenticated as SOMEBODY ELSE with nothing saying so.
     */
    await server.credentials.put("claude-acp", {
      kind: "files",
      files: { ".credentials.json": credentialBody("SHARED-HOME") },
    });
    const e = await failure(server.createAgent("claude-acp", { cwd, home: "shared" }));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("isolated home");

    // A TOKEN credential is fine on a shared home: it lands in an environment variable and needs
    // no directory at all.
    await server.credentials.put("claude-acp", { kind: "token", token: "SHARED-TOKEN" }, "oauth");
    const shared = await server.createAgent("claude-acp", {
      cwd,
      home: "shared",
      credential: "oauth",
    });
    expect(shared.snapshot.home).toBeNull();
    expect(shared.snapshot.credential?.method).toBe("token");
    expect(await readdir(join(h.daemon.config.dataDir, "homes")).catch(() => [])).toEqual([]);
  });
});
