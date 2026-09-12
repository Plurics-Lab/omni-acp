import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OmniError, type CredentialInput } from "@omni-acp/protocol";

/**
 * `OmniACP.localCredential(agent)` — this machine's own login, read on the CLIENT side, as a
 * `CredentialInput` ready for `server.credentials.put()`.
 *
 * ── Why the client and not the daemon ───────────────────────────────────────────────────────────
 *
 * A daemon that read `~/.claude/.credentials.json` for you would be a daemon that reads any file
 * you can name, from a remote request, as whatever user it runs as. That is a file-disclosure
 * primitive with a credential-shaped default, and there is no version of it that is safe to expose
 * over HTTP. So the read happens where the file already belongs to the caller — in their own
 * process — and what crosses the wire is a body the caller chose to send.
 *
 * The corollary is the one real limitation, and it is stated rather than worked around: this only
 * works when the SDK runs on the machine that holds the login. `OmniACP.local()` and a
 * loopback daemon are exactly that case, which is the case this exists for; for a remote daemon an
 * operator copies the body themselves.
 *
 * ── The paths, and their evidence ───────────────────────────────────────────────────────────────
 *
 * Both are MEASURED (docs/M3-WP1-CREDENTIALS.md E1/E2, re-verified 2026-09-12):
 * `~/.claude/.credentials.json` carries `{claudeAiOauth:{accessToken, refreshToken, expiresAt,
 * refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier}}`, and `~/.codex/auth.json`
 * carries `{auth_mode, OPENAI_API_KEY, tokens:{id_token, access_token, refresh_token, account_id},
 * last_refresh}`. The FILE NAME the daemon will store it under is the descriptor's own
 * `credentials.files` entry, which is why the table below names the same two strings.
 *
 * Nothing here is logged, and the content is not inspected beyond `JSON.parse`-ing it to fail
 * early on a file that is not a credential at all.
 */
const LOCAL_LOGINS: Readonly<
  Record<string, { readonly dir: string; readonly file: string; readonly agent: string }>
> = {
  "claude-acp": { dir: ".claude", file: ".credentials.json", agent: "claude-acp" },
  "claude-agent-acp": { dir: ".claude", file: ".credentials.json", agent: "claude-acp" },
  "claude-code-acp": { dir: ".claude", file: ".credentials.json", agent: "claude-acp" },
  "codex-acp": { dir: ".codex", file: "auth.json", agent: "codex-acp" },
};

export interface LocalCredentialOptions {
  /** Override the home directory. Tests use it; an operator with a relocated login can too. */
  readonly home?: string;
}

/**
 * The machine's login for `agent`, as a `files` credential.
 *
 * `agent` is matched against a small table of KNOWN runtimes rather than against the daemon's
 * configured agent ids, because the id an operator typed in their config is theirs to choose:
 * `agents[].id: "claude"` is legal and says nothing about where the login lives. An id this does
 * not know is a `bad_request` naming the two it does — never a guess at a path, which would be the
 * file-disclosure primitive again in miniature.
 */
export async function localCredential(
  agent: string,
  o?: LocalCredentialOptions,
): Promise<CredentialInput> {
  const known = LOCAL_LOGINS[agent];
  if (known === undefined) {
    throw new OmniError(
      "bad_request",
      `localCredential() knows where ${Object.keys(LOCAL_LOGINS)
        .map((k) => JSON.stringify(k))
        .join(", ")} keep their logins, not ${JSON.stringify(agent)}`,
    );
  }
  const path = join(o?.home ?? homedir(), known.dir, known.file);

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (e) {
    // The PATH is named because the caller chose it (it is their own home) and because "log in
    // first" is the actionable answer. The content is not read, so nothing can leak here.
    throw new OmniError(
      "credential_required",
      `no ${agent} login was found at ${path}; log in on this machine first`,
      { cause: e, detail: { path } },
    );
  }
  try {
    JSON.parse(content);
  } catch (e) {
    // FAIL EARLY, on this side. A malformed credential uploaded successfully would fail later as
    // an authentication error from the agent — which is the one failure mode that looks like
    // "your subscription lapsed" and is actually "your file is truncated".
    throw new OmniError(
      "bad_request",
      `the ${agent} login at ${path} is not valid JSON; it is not a credential this agent reads`,
      { cause: e, detail: { path } },
    );
  }

  return { kind: "files", files: { [known.file]: content } };
}
