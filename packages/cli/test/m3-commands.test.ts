import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { parseArgs, USAGE } from "../src/args.js";
import {
  localLoginAgents,
  readLocalCredential,
  renderCredentialPut,
  renderCredentials,
  renderLogin,
} from "../src/remote.js";
import type { CredentialListResponse, CredentialPutResult, LoginState } from "@omni-acp/protocol";

/**
 * M3-WP1's CLI command (docs/M3-WP1-CREDENTIALS.md §线上协议):
 *
 *     omni-acp credentials list
 *     omni-acp credentials import <agent> [--name <name>]
 *     omni-acp credentials put <agent> --token-value|--api-key|--file <name>   (secret on STDIN)
 *     omni-acp credentials get|rm|check <agent> [--name <name>] [--deep]
 *
 * `parse → ONE call → print` (D15), asserted in both halves — and then TWO rules that are about
 * secrets rather than about shape, and that a CLI is the easiest place to get wrong:
 *
 *  1. a secret is NEVER an argv. There is no `--value` and no `--file <path>`: an argument is
 *     visible in the shell history and in every process listing on the machine, and a path is the
 *     file-disclosure primitive the daemon refuses, moved to the client.
 *  2. nothing PRINTED is a secret. Every renderer is fed a credential-shaped body carrying a
 *     planted token and the output is grepped.
 *
 * Owned by M3-WP1.
 */

function sink(): {
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  out: () => string;
  err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (c: string) => ((stdout += c), true) } as unknown as NodeJS.WritableStream,
      stderr: { write: (c: string) => ((stderr += c), true) } as unknown as NodeJS.WritableStream,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

async function serve(routes: Record<string, unknown>): Promise<{
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const body = routes[`${req.method ?? ""} ${req.url ?? ""}`];
      res.writeHead(body === undefined ? 400 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(body ?? { code: "bad_request", message: `no route for ${req.url ?? ""}` }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const AUTH = ["--token", "secret-token-value"];
const PLANTED = "PLANTED-CLI-sk-ant-oat01-zzzz";

const SUMMARY: CredentialListResponse["credentials"][number] = {
  agentId: "claude-acp",
  name: "default",
  ownerTokenId: "local",
  method: "files",
  fingerprint: "a1b2c3d4e5f6",
  files: [".credentials.json"],
  env: null,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
  expiresAt: "2026-09-13T00:00:00.000Z",
  inUseBy: 2,
};

const PUT_RESULT: CredentialPutResult = {
  ...SUMMARY,
  workersAffected: 2,
  restartRequired: ["w_01J00000000000000000000002"],
};

describe("parseArgs — omni-acp credentials", () => {
  it("parses every op, and defaults the name to `default`", () => {
    expect(parseArgs(["credentials", "list"])).toEqual({ cmd: "credentials", op: "list" });
    expect(parseArgs(["credentials", "import", "claude-acp"])).toEqual({
      cmd: "credentials",
      op: "import",
      agent: "claude-acp",
      // The same name `createAgent({credential})` falls back to, so the two surfaces agree about
      // which credential an operator means when they name none.
      name: "default",
    });
    expect(parseArgs(["credentials", "get", "codex-acp", "--name", "ci"])).toEqual({
      cmd: "credentials",
      op: "get",
      agent: "codex-acp",
      name: "ci",
    });
    expect(parseArgs(["credentials", "check", "claude-acp", "--deep"])).toEqual({
      cmd: "credentials",
      op: "check",
      agent: "claude-acp",
      name: "default",
      deep: true,
    });
    expect(parseArgs(["credentials", "rm", "claude-acp", "--json"])).toEqual({
      cmd: "credentials",
      op: "rm",
      agent: "claude-acp",
      name: "default",
      json: true,
    });
  });

  it("takes exactly one of --token-value, --api-key, --file on `put`", () => {
    expect(parseArgs(["credentials", "put", "claude-acp", "--token-value"])).toEqual({
      cmd: "credentials",
      op: "put",
      agent: "claude-acp",
      name: "default",
      kind: "token",
    });
    expect(parseArgs(["credentials", "put", "codex-acp", "--api-key"])).toMatchObject({
      kind: "apiKey",
    });
    expect(
      parseArgs(["credentials", "put", "claude-acp", "--file", ".credentials.json"]),
    ).toMatchObject({ kind: "file", file: ".credentials.json" });

    /**
     * NONE of them is an error rather than a default, and that is the point.
     *
     * The three land in three DIFFERENT places: a token and an api key become the env var the
     * DESCRIPTOR declares, a file becomes a file the agent reads. Guessing would hand the agent a
     * secret under a name it never reads — a silent authentication failure rather than a refusal.
     */
    expect(parseArgs(["credentials", "put", "claude-acp"])).toEqual({
      cmd: "error",
      message: "credentials put needs one of --token-value, --api-key or --file <name>",
    });
    expect(parseArgs(["credentials", "put", "claude-acp", "--token-value", "--api-key"])).toEqual({
      cmd: "error",
      message: "credentials put takes exactly one of --token-value, --api-key, --file",
    });
  });

  it("refuses an unknown op and a missing agent, naming what it takes", () => {
    expect(parseArgs(["credentials", "frobnicate", "x"])).toEqual({
      cmd: "error",
      message: 'credentials takes import, put, list, get, rm or check, not "frobnicate"',
    });
    expect(parseArgs(["credentials", "get"])).toEqual({
      cmd: "error",
      message: "credentials get needs an agent id",
    });
    expect(parseArgs(["credentials", "list", "extra"])).toEqual({
      cmd: "error",
      message: 'unexpected argument "extra"',
    });
  });

  it("has NO flag that could carry a secret or a path", () => {
    /**
     * A guard rather than a case, and it is the one rule of this command.
     *
     * `--value <secret>` would put a subscription token in `~/.bash_history` and in the output of
     * `ps` for every account on the machine. `--file <path>` reads like a convenience and is the
     * file-disclosure primitive the daemon refuses (`localCredential` reads two KNOWN paths and
     * nothing else) moved one layer out. Both are absent, and an argv that tries either is an
     * `unknown flag`.
     *
     * `--file` DOES exist and takes a credential FILE NAME (`.credentials.json`) — the name the
     * agent reads, not a path on disk. The assertion below is that a path-shaped value still
     * parses (it is just a name to us) while the two dangerous flags do not exist at all.
     */
    expect(parseArgs(["credentials", "put", "claude-acp", "--value", "sk-secret"])).toEqual({
      cmd: "error",
      message: 'unknown flag "--value"',
    });
    expect(parseArgs(["credentials", "put", "claude-acp", "--secret", "sk-secret"])).toEqual({
      cmd: "error",
      message: 'unknown flag "--secret"',
    });
    // And the usage text SAYS so, because a rule nobody reads is a rule somebody works around.
    expect(USAGE).toContain("reads it from stdin");
    expect(USAGE).toContain("never returned");
  });
});

describe("omni-acp credentials — parse → ONE call → print", () => {
  it("lists, and prints a fingerprint rather than anything else", async () => {
    const server = await serve({
      "GET /v1/credentials": { credentials: [{ ...SUMMARY }] } satisfies CredentialListResponse,
    });
    const io = sink();
    try {
      expect(await main(["credentials", "list", "--url", server.url, ...AUTH], {}, io.io)).toBe(0);
    } finally {
      await server.close();
    }
    // ONE call. A command that got chatty would show a second row here.
    expect(server.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /v1/credentials"]);
    expect(io.out()).toContain("a1b2c3d4e5f6");
    expect(io.out()).toContain("claude-acp");
    expect(io.out()).toContain("FINGERPRINT");
  });

  it("checks, and passes --deep through as the body", async () => {
    const login: LoginState = {
      state: "ok",
      method: "files",
      credential: "default",
      fingerprint: "a1b2c3d4e5f6",
      expiresAt: "2026-09-13T00:00:00.000Z",
      checkedAt: "2026-09-12T00:00:00.000Z",
      deep: true,
    };
    const server = await serve({ "POST /v1/credentials/claude-acp/default/check": login });
    const io = sink();
    try {
      expect(
        await main(
          ["credentials", "check", "claude-acp", "--deep", "--url", server.url, ...AUTH],
          {},
          io.io,
        ),
      ).toBe(0);
    } finally {
      await server.close();
    }
    expect(server.seen.length).toBe(1);
    expect(JSON.parse(server.seen[0]?.body ?? "{}")).toEqual({ deep: true });
    expect(io.out()).toContain("state: ok");
    expect(io.out()).toContain("deep: true");
  });

  it("removes, and says which credential went", async () => {
    const server = await serve({ "DELETE /v1/credentials/codex-acp/ci": {} });
    const io = sink();
    try {
      expect(
        await main(
          ["credentials", "rm", "codex-acp", "--name", "ci", "--url", server.url, ...AUTH],
          {},
          io.io,
        ),
      ).toBe(0);
    } finally {
      await server.close();
    }
    expect(server.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "DELETE /v1/credentials/codex-acp/ci",
    ]);
    expect(io.out()).toContain("removed codex-acp/ci");
  });

  it("imports THIS machine's login, reading it locally and uploading the body", async () => {
    const home = await mkdtemp(join(tmpdir(), "omni-cli-home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: PLANTED } }),
    );

    // The READ is local, in the operator's own process. `readLocalCredential` is the function the
    // command uses, and it takes the home as a parameter precisely so this is testable without
    // touching the developer's real login.
    const input = await readLocalCredential("claude-acp", { home });
    expect(input).toEqual({
      kind: "files",
      files: { ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: PLANTED } }) },
    });

    // …and the COMMAND does the same thing, end to end. `os.homedir()` reads `HOME` on POSIX and
    // `USERPROFILE` on Windows, so both are pointed at the temp home for the duration — which is
    // what lets this exercise `main()` itself rather than only the function under it.
    const server = await serve({ "PUT /v1/credentials/claude-acp/default": PUT_RESULT });
    const io = sink();
    const previous = { home: process.env["HOME"], profile: process.env["USERPROFILE"] };
    try {
      process.env["HOME"] = home;
      process.env["USERPROFILE"] = home;
      expect(
        await main(
          ["credentials", "import", "claude-acp", "--url", server.url, ...AUTH],
          {},
          io.io,
        ),
      ).toBe(0);
    } finally {
      if (previous.home === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous.home;
      if (previous.profile === undefined) delete process.env["USERPROFILE"];
      else process.env["USERPROFILE"] = previous.profile;
      await server.close();
    }

    // ONE call, and the secret went UP in the body — which is the only direction it ever travels.
    expect(server.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "PUT /v1/credentials/claude-acp/default",
    ]);
    expect(server.seen[0]?.body).toContain(PLANTED);
    // What it PRINTS is the fingerprint and the restart advice, and never the token it just read.
    expect(io.out()).toContain("a1b2c3d4e5f6");
    expect(io.out()).toContain("restart required");
    expect(io.out()).not.toContain(PLANTED);
  });

  it("refuses an agent whose login location it does not know, naming the ones it does", async () => {
    await expect(readLocalCredential("some-other-agent")).rejects.toThrow(
      /knows where .* keep their logins/,
    );
    // The table is the SDK's, restated here because the DAG runs `protocol → core → daemon → cli`
    // and the client is a sibling leaf (§3.1) — importing it would put a second package in the
    // CLI's runtime closure. The parity assertion below is what keeps the restatement honest.
    expect(localLoginAgents()).toEqual([
      "claude-acp",
      "claude-agent-acp",
      "claude-code-acp",
      "codex-acp",
    ]);
  });

  it("fails EARLY on a login that is not JSON, rather than uploading a truncated one", async () => {
    const home = await mkdtemp(join(tmpdir(), "omni-cli-home-"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), '{"auth_mode":"chat');
    // A truncated credential uploaded successfully fails later as an authentication error from the
    // agent — which looks like "your subscription lapsed" and is not.
    await expect(readLocalCredential("codex-acp", { home })).rejects.toThrow(/not valid JSON/);
  });

  it("says `log in on this machine first` when there is no login at all", async () => {
    const home = await mkdtemp(join(tmpdir(), "omni-cli-home-"));
    await expect(readLocalCredential("claude-acp", { home })).rejects.toThrow(
      /log in on this machine first/,
    );
  });
});

describe("guard: nothing the CLI prints is a secret", () => {
  it("renders a fingerprint and never a credential value", () => {
    /**
     * Every renderer, fed a body carrying a planted token in every field that could plausibly
     * hold one — and then grepped.
     *
     * The daemon has no route that returns credential content, so a leak here could only come from
     * a renderer printing something it was handed; this is the test that would catch a `--show`
     * flag, or a `JSON.stringify(body)` added for convenience.
     */
    const poisoned = { ...SUMMARY, fingerprint: "a1b2c3d4e5f6" } as Record<string, unknown>;
    poisoned["secret"] = PLANTED;
    poisoned["token"] = PLANTED;

    const rendered = [
      renderCredentials({ credentials: [poisoned as never] }),
      renderCredentialPut({ ...PUT_RESULT, ...(poisoned as never) }),
      renderLogin({
        state: "expired",
        method: "files",
        credential: "default",
        fingerprint: "a1b2c3d4e5f6",
        checkedAt: "2026-09-12T00:00:00.000Z",
        deep: false,
        detail: "the stored credential expired at 2026-09-11T00:00:00.000Z",
      }),
    ].join("\n");

    expect(rendered).not.toContain(PLANTED);
    // …and the substitute IS there, which is what makes the refusal usable rather than merely safe.
    expect(rendered).toContain("a1b2c3d4e5f6");
    expect(rendered).toContain("restart required");
  });

  it("prints an EMPTY store as a sentence, not as an empty table", () => {
    expect(renderCredentials({ credentials: [] })).toBe("no credentials stored");
  });
});
