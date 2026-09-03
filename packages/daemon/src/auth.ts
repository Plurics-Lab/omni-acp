import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { relative, isAbsolute } from "node:path";
import {
  HEADER,
  OmniError,
  hashSecret,
  verifySecret,
  type ClientId,
  type ClientRef,
  type ResolvedDaemonConfig,
  type TokenConfig,
  type TokenId,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { resolvePath } from "./ids-file.js";
import type { AuthContext } from "./types.js";

export interface TokenStore {
  /**
   * Throws `unauthorized`. Re-evaluated on EVERY request and never cached: mutating the token
   * table must change the next verdict with no restart (DESIGN §8). Comparison is
   * `timingSafeEqual` over the SHA-256 digests; the plaintext secret is hashed at config load
   * and dropped.
   */
  verify(headers: Headers): AuthContext;
  /**
   * The in-process half: an `AuthContext` for a token id with no header in sight, which is what
   * `Daemon.authContextFor()` returns and what `verify()` produces once it has matched a secret
   * (review R10, D15). Throws `unauthorized` for an unknown token id.
   */
  contextFor(tokenId: TokenId, clientId?: string | null): AuthContext;
  has(tokenId: TokenId): boolean;
}

interface TokenEntry {
  readonly tokenId: TokenId;
  readonly role: "user" | "admin";
  readonly agents: readonly string[] | "*";
  readonly cwdRoots: readonly string[];
  readonly maxWorkers: number;
  /** Lower-case hex. The plaintext never reaches this object. */
  readonly sha256: string;
}

/** An `Omni-Client-Id` is audit metadata; it is bounded so it cannot become a log-bloat vector. */
const MAX_CLIENT_ID = 200;

/**
 * `Bearer <secret>`, scheme case-insensitive (RFC 7235 says the scheme is), exactly one token
 * after it. The secret itself is never captured into an error message or a log field.
 */
const BEARER = /^bearer[ \t]+(\S+)[ \t]*$/i;

const unauthorized = (why: string): OmniError => new OmniError("unauthorized", why);

/**
 * Normalizes ONE config token into an entry, hashing a plaintext secret and dropping it from the
 * config object in the process — "hashed at config load and dropped" (H13), made true of the
 * object an embedder can still reach through `daemon.config`.
 */
function toEntry(token: TokenConfig): TokenEntry | null {
  if (token.secret !== undefined) {
    token.secretSha256 = hashSecret(token.secret);
    delete token.secret;
  }
  const sha256 = token.secretSha256;
  if (sha256 === undefined) return null; // unreachable through zod; a mutated table can do it

  const roots = token.cwdRoots.length === 0 ? [homedir()] : token.cwdRoots;
  return {
    tokenId: token.id,
    role: token.role,
    agents: token.agents === "*" ? "*" : [...token.agents],
    cwdRoots: roots.map(resolvePath),
    maxWorkers: token.maxWorkers,
    sha256: sha256.toLowerCase(),
  };
}

/**
 * The token table AS OF THIS CALL.
 *
 * Rebuilt per request on purpose: DESIGN §8's "每次都查、不缓存决策" is a property of the daemon,
 * not of a config reload path that M0 does not have yet — removing a token from
 * `daemon.config.tokens` must change the very next verdict. The table is a handful of entries
 * and the work is one `Object.entries` walk, so there is nothing here worth caching and getting
 * wrong.
 */
function tableOf(config: ResolvedDaemonConfig): Map<TokenId, TokenEntry> {
  const table = new Map<TokenId, TokenEntry>();
  for (const token of config.tokens) {
    const entry = toEntry(token);
    if (entry === null) continue;
    // First occurrence wins; `createTokenStore` refuses a duplicate id at construction, so this
    // is only reachable through a table mutated at runtime.
    if (!table.has(entry.tokenId)) table.set(entry.tokenId, entry);
  }
  return table;
}

/** `child` is inside `parent` (or is `parent`). Case-insensitive on Windows via `path.relative`. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function createAuthContext(entry: TokenEntry, clientId: ClientId | null): AuthContext {
  const context: AuthContext = {
    tokenId: entry.tokenId,
    role: entry.role,
    clientId,
    agents: entry.agents,
    cwdRoots: entry.cwdRoots,
    maxWorkers: entry.maxWorkers,

    assertAgent(agentId: string): void {
      if (entry.agents === "*") return;
      if (entry.agents.includes(agentId)) return;
      // 403, not 404: the agent catalog is not a secret, the token's allowance is the boundary
      // (§9). Worker EXISTENCE is the thing that must never leak, and that is `canSee`.
      throw new OmniError("forbidden", `agent "${agentId}" is not allowed for this token`, {
        detail: { tokenId: entry.tokenId, agentId },
      });
    },

    /**
     * `realpath` FIRST, containment second. That order is the whole point: a symlink inside an
     * allowed root pointing at `/etc` is a path that passes a string comparison and fails this
     * one (D18 — an unchecked `cwd` on a process-spawning daemon is arbitrary code execution).
     *
     * The roots are `realpath`d too, because `/tmp` is a symlink to `/private/tmp` on macOS and
     * a root that does not canonicalise would reject every cwd underneath it.
     */
    async assertCwd(cwd: string): Promise<string> {
      const forbidden = (why: string): never => {
        throw new OmniError("forbidden", why, { detail: { cwd, roots: entry.cwdRoots } });
      };

      let canonical: string;
      try {
        canonical = await realpath(resolvePath(cwd));
      } catch {
        // Unreadable or absent: containment is unprovable, so it fails closed. A 403 rather
        // than a 404 also means the reply does not report whether the path exists.
        return forbidden("cwd does not resolve to a directory inside an allowed root");
      }

      for (const root of entry.cwdRoots) {
        let canonicalRoot: string;
        try {
          canonicalRoot = await realpath(root);
        } catch {
          canonicalRoot = root; // a configured root that does not exist can still match nothing
        }
        if (contains(canonicalRoot, canonical)) return canonical;
      }
      return forbidden("cwd is outside every allowed root for this token");
    },

    /** D13: an admin sees the whole machine; everyone else sees their own token's workers. */
    canSee(w: WorkerSnapshot): boolean {
      return entry.role === "admin" || w.ownerTokenId === entry.tokenId;
    },

    asClientRef(): ClientRef {
      return { tokenId: entry.tokenId, clientId };
    },
  };
  return context;
}

function readClientId(headers: Headers): ClientId | null {
  const raw = headers.get(HEADER.clientId);
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > MAX_CLIENT_ID) {
    // The header name is written the way an operator sees it in their own client, not the
    // lower-cased lookup key `Headers` normalises to.
    throw new OmniError("bad_request", `Omni-Client-Id exceeds ${MAX_CLIENT_ID} characters`);
  }
  return value;
}

export function createTokenStore(config: ResolvedDaemonConfig): TokenStore {
  const seen = new Set<string>();
  for (const token of config.tokens) {
    if (seen.has(token.id)) {
      throw new OmniError("bad_request", `duplicate token id "${token.id}"`);
    }
    seen.add(token.id);
  }
  // Hash-and-drop happens here as well as in `verify`, so a plaintext secret is gone from
  // `daemon.config` the moment `createDaemon()` returns, not on the first request.
  tableOf(config);

  return {
    verify(headers: Headers): AuthContext {
      const header = headers.get(HEADER.auth);
      if (header === null) throw unauthorized("missing Authorization header");
      const match = BEARER.exec(header);
      if (match === null) throw unauthorized("malformed Authorization header; expected Bearer");
      const secret = match[1] ?? "";
      const clientId = readClientId(headers);

      // Every entry is compared, with no early exit, so the number of comparisons does not vary
      // with WHICH token matched. The comparison itself is `timingSafeEqual` (verifySecret).
      let matched: TokenEntry | null = null;
      for (const entry of tableOf(config).values()) {
        if (verifySecret(secret, entry.sha256) && matched === null) matched = entry;
      }
      if (matched === null) throw unauthorized("unknown bearer token");
      return createAuthContext(matched, clientId);
    },

    contextFor(tokenId: TokenId, clientId?: string | null): AuthContext {
      const entry = tableOf(config).get(tokenId);
      if (entry === undefined) throw unauthorized(`unknown token id "${tokenId}"`);
      return createAuthContext(entry, clientId ?? null);
    },

    has(tokenId: TokenId): boolean {
      return tableOf(config).has(tokenId);
    },
  };
}
