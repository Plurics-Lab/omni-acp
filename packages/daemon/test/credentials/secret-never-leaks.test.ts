import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HEADER, type DaemonConfig, type Logger } from "@omni-acp/protocol";
import { fakeSupervisor, scriptedAgent, seqIds } from "@omni-acp/testkit";
import { createDaemon } from "../../src/create-daemon.js";
import { removeTempRoots, tempRoot } from "../support/temp-dirs.js";

/**
 * `secret-never-leaks` — DESIGN §8's rule, made a test over a WHOLE cycle.
 *
 * A PLANTED token is stored, a worker is created on it, prompted, its credential is swapped, the
 * worker is restarted and closed — and then every byte this daemon produced is searched for the
 * planted string: every HTTP response body, every log line (including their `fields`), and every
 * event envelope on every worker's log.
 *
 * It is a grep because that is the only form of the claim that cannot be out-argued. The store
 * already returns summaries and the snapshot already carries a fingerprint; what this catches is
 * the third path nobody thought about — a `detail` on an error, a log field, a future snapshot row
 * — and it catches it for the routes as they are TODAY rather than as they were reviewed.
 *
 * Owned by M3-WP1.
 */

const SECRET = "d".repeat(32);
/**
 * Deliberately unmistakable, and deliberately three different shapes.
 *
 * A single planted string would pass if one of the three storage shapes leaked and the others did
 * not — and the three go to three different places: a `files` credential to a file the agent reads,
 * a `token` to the env var the descriptor declares, an `apiKey` to another one.
 */
const PLANTED_FILE_SECRET = "PLANTED-IN-FILE-sk-ant-oat01-zzzz";
const PLANTED_TOKEN = "PLANTED-AS-TOKEN-oauth-yyyy";
const PLANTED_API_KEY = "PLANTED-AS-APIKEY-sk-xxxx";
const ALL_PLANTED = [PLANTED_FILE_SECRET, PLANTED_TOKEN, PLANTED_API_KEY];

interface Captured {
  /** Every line this daemon logged, message and fields flattened to one string. */
  readonly lines: string[];
}

/** A logger that KEEPS everything, including the `fields` object every call may carry. */
function capturingLogger(captured: Captured): Logger {
  const write = (level: string, msg: string, fields?: Record<string, unknown>): void => {
    captured.lines.push(`${level} ${msg} ${fields === undefined ? "" : JSON.stringify(fields)}`);
  };
  const make = (bindings: Record<string, unknown>): Logger => ({
    child: (more) => make({ ...bindings, ...more }),
    debug: (m, f) => write("debug", m, { ...bindings, ...f }),
    info: (m, f) => write("info", m, { ...bindings, ...f }),
    warn: (m, f) => write("warn", m, { ...bindings, ...f }),
    error: (m, f) => write("error", m, { ...bindings, ...f }),
  });
  return make({});
}

afterEach(async () => {
  await removeTempRoots();
});

describe("guard: secret-never-leaks — a planted credential over a whole worker cycle", () => {
  // A whole cycle over a fake supervisor: a create, a prompt that is deliberately never settled,
  // a swap, a forced restart and a close, each of which walks a real close-out ladder on the real
  // clock. 30 s is the budget the M2 integration cases use for the same reason.
  it(
    "appears in no response body, no log line and no event envelope",
    { timeout: 30_000 },
    async () => {
      const root = await tempRoot("omni-noleak-");
      const dataDir = join(root, "data");
      const cwd = join(root, "work");
      await mkdir(dataDir, { recursive: true });
      await mkdir(cwd, { recursive: true });

      const captured: Captured = { lines: [] };
      const supervisor = fakeSupervisor();
      // Four processes: the create, the restart, the setCredential's own restart, and one spare.
      for (let i = 0; i < 6; i += 1) supervisor.enqueue(scriptedAgent());

      const config: DaemonConfig = {
        dataDir,
        listen: { host: "127.0.0.1", port: 0 },
        tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }],
        agents: [
          // `claude-acp` by id so the REAL builtin governs: its credential contract is what decides
          // the file name, the two env variables and (measured) `reload: "file"`.
          { id: "claude-acp", command: process.execPath, args: ["-e", ""] },
        ],
        logLevel: "debug",
      };
      const daemon = await createDaemon(config, {
        supervisor,
        ids: seqIds(),
        logger: capturingLogger(captured),
      });

      /** Every response body, kept verbatim. */
      const bodies: string[] = [];
      const call = async (
        method: string,
        path: string,
        body?: unknown,
      ): Promise<{ status: number; text: string }> => {
        const res = await daemon.fetch(
          new Request(`http://daemon.invalid${path}`, {
            method,
            headers: {
              [HEADER.auth]: `Bearer ${SECRET}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        const text = await res.text();
        bodies.push(text);
        return { status: res.status, text };
      };

      try {
        // ── 1. store all three shapes ─────────────────────────────────────────
        const put = await call("PUT", "/v1/credentials/claude-acp/default", {
          kind: "files",
          files: {
            ".credentials.json": JSON.stringify({
              claudeAiOauth: { accessToken: PLANTED_FILE_SECRET },
            }),
          },
        });
        expect(put.status).toBe(200);
        expect(
          (
            await call("PUT", "/v1/credentials/claude-acp/oauth", {
              kind: "token",
              token: PLANTED_TOKEN,
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await call("PUT", "/v1/credentials/claude-acp/key", {
              kind: "apiKey",
              apiKey: PLANTED_API_KEY,
            })
          ).status,
        ).toBe(200);

        // ── 2. every READ surface ─────────────────────────────────────────────
        await call("GET", "/v1/credentials");
        await call("GET", "/v1/credentials/claude-acp/default");
        await call("GET", "/v1/credentials/claude-acp/oauth");
        await call("POST", "/v1/credentials/claude-acp/default/check", {});
        // H4 now carries the per-token `login` row, which is the newest surface and therefore the
        // one most likely to have picked something up.
        await call("GET", "/v1/agents");

        // ── 3. a worker on the TOKEN credential, i.e. the env-var shape ───────
        const created = await call("POST", "/v1/workers", {
          agent: "claude-acp",
          cwd,
          credential: "oauth",
        });
        expect(created.status).toBe(201);
        const workerId = (JSON.parse(created.text) as { workerId: string }).workerId;

        await call("GET", `/v1/workers/${workerId}`);
        await call("GET", "/v1/workers");
        await call("POST", `/v1/workers/${workerId}/prompt`, {
          content: [{ type: "text", text: "hello" }],
        });

        // ── 4. the swap, and the restart ──────────────────────────────────────
        const swapped = await call("PUT", `/v1/workers/${workerId}/credential`, {
          credential: "key",
        });
        expect(swapped.status).toBe(200);
        // `fresh: true` because `scriptedAgent()` advertises no resume spelling, and a restart that
        // cannot resume is a `422` BEFORE the process is reclaimed (§restart's own 422 row). What
        // this case is about is the bytes, not the resume — `restart.test.ts` owns the four-state
        // half and the compat suite proves the real resume against a real agent.
        const restarted = await call("POST", `/v1/workers/${workerId}/restart`, {
          force: true,
          fresh: true,
        });
        expect(restarted.status).toBe(200);

        // ── 5. the whole event log, and the close ─────────────────────────────
        await call("GET", `/v1/workers/${workerId}/turns/t_00000000000000000000000001`);
        await call("DELETE", `/v1/workers/${workerId}`);

        const envelopes = JSON.stringify(
          daemon.workers.logFor(workerId as never, daemon.authContextFor("t")).read(0),
        );

        // ── the grep ──────────────────────────────────────────────────────────
        for (const planted of ALL_PLANTED) {
          const inBodies = bodies.filter((b) => b.includes(planted));
          expect(inBodies, `a planted secret reached an HTTP response body`).toEqual([]);
          const inLogs = captured.lines.filter((l) => l.includes(planted));
          expect(inLogs, `a planted secret reached a log line`).toEqual([]);
          expect(envelopes.includes(planted), `a planted secret reached an event envelope`).toBe(
            false,
          );
        }

        // The guard is only meaningful if the cycle actually HAPPENED, so the positive half is
        // asserted too: the fingerprints are there, on the bodies and in the audit envelope.
        expect(bodies.join("\n")).toMatch(/[0-9a-f]{12}/);
        expect(envelopes).toContain("omni.credential");
        /**
         * …and the LOG surface was genuinely exercised, which is the half a grep over an empty array
         * would pass vacuously.
         *
         * The store's own line is the one that matters here: it is written on every `PUT`, it carries
         * the agent, the name, the method and the FINGERPRINT, and it is the single most likely place
         * in the repository for a credential value to be added by accident.
         */
        const stored = captured.lines.filter((l) => l.includes("stored a credential"));
        expect(stored.length).toBe(3);
        expect(stored.join("\n")).toMatch(/[0-9a-f]{12}/);
      } finally {
        await daemon.stop();
      }
    },
  );

  it("FIRES on a planted leak, so the grep is known to work", () => {
    // §10.2's rule: a guard nobody has watched fail is a guard nobody knows works. The three
    // haystacks above are strings, so this is the whole mechanism.
    const bodies = [`{"token":"${PLANTED_TOKEN}"}`];
    expect(bodies.filter((b) => b.includes(PLANTED_TOKEN))).not.toEqual([]);
    const lines = [`info spawning {"env":{"CLAUDE_CODE_OAUTH_TOKEN":"${PLANTED_TOKEN}"}}`];
    expect(lines.filter((l) => l.includes(PLANTED_TOKEN))).not.toEqual([]);
  });
});
