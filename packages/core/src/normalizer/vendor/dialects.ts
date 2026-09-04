import { arr, num, record, str, type Json } from "../map/json.js";

/**
 * The two vendor DIALECTS M1 knows how to read (CONTRACTS.md §12.5, §13.4, F19/F20).
 *
 * A dialect is keyed by `ExtensionPath.dialect` — `"claude_structured_patch"` /
 * `"claude_rate_limit"` — and receives the value the descriptor's POINTER already resolved to.
 * That split is what keeps `descriptor-is-the-only-branch` (§17.1) true of this file as well as
 * of the map: no agent id and no vendor `_meta` key is spelled here; `/claudeCode/toolResponse`
 * and `/_claude~1rateLimit` live in the descriptor, where an operator can add a fork's spelling
 * without a commit.
 *
 *  - `claude_structured_patch` — `{structuredPatch, originalFile, content, filePath}`, which
 *    reconstructs a patch `git apply --check` accepts. Surfaced as `TurnResult.vendorPatch` and
 *    NEVER as `TurnResult.patch` (D8, ruling M1-R11). `null` rather than WRONG whenever the
 *    reconstructed hunk line counts disagree with `oldLines`/`newLines`.
 *  - `claude_rate_limit` — the structured signal DESIGN §6.2's "`end_turn` ≠ success" needs. It
 *    arrives BEFORE the failure and is not stderr text.
 *
 * Owned by M1-WP-B.
 */

export interface VendorPatch {
  readonly format: "git_patch";
  readonly text: string;
  readonly source: string;
}

/** Rate-limit statuses M1 treats as TERMINAL. Everything else — including the only status ever
 *  observed, `allowed_warning` at utilization 0.78 — is an advisory (§13.4). Enumerated rather
 *  than inferred: guessing that an unknown status means failure fails turns that succeeded. */
export const TERMINAL_RATE_LIMIT_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "blocked",
  "exhausted",
  "over_limit",
]);

export interface RateLimitSignal {
  readonly status: string;
  readonly terminal: boolean;
  readonly utilization: number | null;
  readonly resetsAt: number | null;
  readonly raw: Json;
}

/**
 * `_meta` at the descriptor's `rateLimit` pointer → a typed signal, or `null`.
 *
 * `terminal` keys on an ENUMERATED status set and on nothing else — no message text, no
 * threshold arithmetic. `utilization` is reported because an operator wants it in the warning,
 * never because a number decides anything.
 */
export function readRateLimit(value: unknown): RateLimitSignal | null {
  const raw = record(value);
  if (raw === null) return null;
  const status = str(raw["status"]);
  if (status === null) return null;
  return {
    status,
    terminal: TERMINAL_RATE_LIMIT_STATUSES.has(status),
    utilization: num(raw["utilization"]),
    resetsAt: num(raw["resetsAt"]),
    raw,
  };
}

interface Hunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/**
 * `_meta` at the descriptor's `patch` pointer → a unified git patch, or `null`.
 *
 * Two recorded shapes, both reconstructed and both asserted against a real `git apply --check`:
 *
 *  - an EDIT (corpus `10`): `structuredPatch` carries the hunks and `originalFile` the text they
 *    apply to. The hunk header is rebuilt from `oldStart`/`oldLines`/`newStart`/`newLines`.
 *  - a CREATION (corpus `03`): `structuredPatch` is EMPTY, `originalFile` is `null`, and the new
 *    content is in `content`. A `/dev/null` → `b/<path>` patch is synthesized from it, which is
 *    the only shape git accepts for a new file.
 *
 * `baseDir` is the session cwd when the caller knows it: git patches name paths relative to the
 * repository root, and an absolute `/tmp/...` path in an `a/`-prefixed header is not applicable
 * anywhere. When the file is not under `baseDir` the absolute path is kept, minus its leading
 * separator, so the patch is still applicable with `-p1` from the filesystem root — wrong is not
 * an option, so unreachable-but-honest is what is produced.
 *
 * Returns `null` rather than a wrong patch whenever the hunk's own line counts disagree with the
 * lines it carries (§11.6's accepted risk, made a check).
 */
export function readStructuredPatch(value: unknown, baseDir?: string): VendorPatch | null {
  const response = record(value);
  if (response === null) return null;

  const filePath = str(response["filePath"]);
  if (filePath === null) return null;
  const rel = relativize(filePath, baseDir);

  const hunks = readHunks(response["structuredPatch"]);
  if (hunks === null) return null;

  if (hunks.length === 0) {
    // A creation: no hunks, and the whole file is the addition.
    const content = str(response["content"]);
    if (content === null || response["originalFile"] !== null) return null;
    return { format: "git_patch", text: creationPatch(rel, content), source: "vendor" };
  }

  if (str(response["originalFile"]) === null) return null;

  const body: string[] = [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`];
  for (const hunk of hunks) {
    const counts = countHunk(hunk.lines);
    if (counts === null) return null;
    // The check that makes "null rather than wrong" real: a hunk whose header disagrees with its
    // own body produces a patch git will reject at best and misapply at worst.
    if (counts.old !== hunk.oldLines || counts.new !== hunk.newLines) return null;
    body.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      ...hunk.lines,
    );
  }
  return { format: "git_patch", text: `${body.join("\n")}\n`, source: "vendor" };
}

function readHunks(value: unknown): readonly Hunk[] | null {
  const list = arr(value);
  if (list === null) return null;
  const hunks: Hunk[] = [];
  for (const raw of list) {
    const h = record(raw);
    if (h === null) return null;
    const oldStart = num(h["oldStart"]);
    const oldLines = num(h["oldLines"]);
    const newStart = num(h["newStart"]);
    const newLines = num(h["newLines"]);
    const lines = arr(h["lines"]);
    if (oldStart === null || oldLines === null || newStart === null || newLines === null) {
      return null;
    }
    if (lines === null || !lines.every((l) => typeof l === "string")) return null;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: lines as readonly string[] });
  }
  return hunks;
}

function countHunk(lines: readonly string[]): { old: number; new: number } | null {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    const marker = line.slice(0, 1);
    if (marker === "\\") continue; // "\ No newline at end of file"
    if (marker === "-") oldCount += 1;
    else if (marker === "+") newCount += 1;
    else if (marker === " " || line === "") {
      // An empty string is a context line for an empty source line: git writes a bare " " and
      // some producers trim it. Counting it on both sides is what the diff means.
      oldCount += 1;
      newCount += 1;
    } else return null; // an unrecognized marker means we do not understand this hunk
  }
  return { old: oldCount, new: newCount };
}

function creationPatch(rel: string, content: string): string {
  const trailingNewline = content.endsWith("\n");
  const body = trailingNewline ? content.slice(0, -1) : content;
  const lines = body === "" ? [] : body.split("\n");
  const added = lines.map((l) => `+${l}`);
  if (!trailingNewline && lines.length > 0) added.push("\\ No newline at end of file");
  return [
    `diff --git a/${rel} b/${rel}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${rel}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...added,
    "",
  ].join("\n");
}

/** POSIX and Windows separators both, because a descriptor may describe either host. */
function relativize(filePath: string, baseDir?: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (baseDir !== undefined && baseDir !== "") {
    const base = baseDir.replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
  }
  return normalized.replace(/^\/+/, "").replace(/^([A-Za-z]):\//, "$1/");
}
