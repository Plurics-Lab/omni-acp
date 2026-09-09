import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The two architecture guards M2-PLAN §3 assigns to this work package:
 * `webhook-body-is-thin` and `no-unbounded-outbound`.
 *
 * Both scan CODE, never prose: the forbidden names appear legally in the doc comments that
 * explain why they are forbidden, and a guard that fires on its own rationale teaches people to
 * delete the rationale (amendment A8). Both also carry a "FIRES on a planted violation" block,
 * because a guard nobody has watched fail is a guard nobody knows works.
 *
 * Owned by M2-B-WP-R.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const PROTOCOL_CONTRACTS = join(HERE, "..", "..", "..", "protocol", "src", "contracts.ts");

interface Source {
  readonly file: string;
  readonly text: string;
  /** Comments AND string content blanked — for identifier and call-site scans. */
  readonly code: string;
  /** Comments blanked, string content KEPT — for the two literal scans below. */
  readonly literals: string;
}

/**
 * Blanks comments and, optionally, string content, keeping every offset so a line number stays a
 * line number.
 *
 * The two projections are the difference between "is this call made?" and "is this option set?".
 * `redirect: "manual"` is a LITERAL, and a scan over the identifier projection would find an
 * empty string and report the option missing.
 */
function blank(source: string, stripStrings: boolean): string {
  const out = source.split("");
  const erase = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== "\n") out[i] = " ";
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      erase(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      erase(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        // Only a template literal may cross a newline; for the other two the line end is a
        // terminator that FAILS CLOSED, so a stray quote cannot blank the rest of the file and
        // leave every check below silently passing.
        if (ch !== "`" && c === "\n") break;
        if (c === ch) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (stripStrings) erase(i + 1, j);
      i = closed ? j + 1 : j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

function read(file: string, text: string): Source {
  return { file, text, code: blank(text, true), literals: blank(text, false) };
}

function walk(dir: string, prefix: string, out: Source[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel, out);
    else if (entry.name.endsWith(".ts"))
      out.push(read(rel, readFileSync(join(dir, entry.name), "utf8")));
  }
}

const webhookSources = (): Source[] => {
  const out: Source[] = [];
  walk(join(SRC, "webhook"), "", out);
  return out;
};

// ── webhook-body-is-thin ─────────────────────────────────────────────────────

/** D9's eight keys (ruling M2-R13). The set is the guard; the count is a courtesy. */
const THIN_KEYS = [
  "deliveryId",
  "event",
  "daemonId",
  "workerId",
  "runId",
  "sessionId",
  "seq",
  "ts",
];

describe("guard: webhook-body-is-thin", () => {
  it("`WebhookPayload` declares EXACTLY the eight keys and no ninth", () => {
    const text = readFileSync(PROTOCOL_CONTRACTS, "utf8");
    const block = /export interface WebhookPayload \{([\s\S]*?)\n\}/.exec(text)?.[1];
    expect(block, "WebhookPayload was renamed or moved").toBeDefined();

    const declared = [...(block ?? "").matchAll(/readonly\s+([A-Za-z0-9_]+)\s*:/g)].map(
      (m) => m[1] ?? "",
    );
    // The payload is the ONE thing a receiver sees, and a field added to it is a field the
    // daemon has agreed to hand a third party on every run for ever. It is pinned as a SET, so
    // a rename shows up as loudly as an addition.
    expect(declared.sort()).toEqual([...THIN_KEYS].sort());
  });

  it("nothing in `webhook/` puts a key on a delivery body that WebhookPayload does not declare", () => {
    // The dispatcher builds the body in exactly one place, by SPREADING the caller's payload and
    // adding `deliveryId`. Any other object literal reaching `JSON.stringify` on the send path
    // would be a second body shape nobody pinned.
    const dispatcher = webhookSources().find((s) => s.file === "dispatcher.ts");
    expect(dispatcher).toBeDefined();
    const construction = /const payload: WebhookPayload = \{ \.\.\.p, deliveryId \};/.exec(
      dispatcher?.code ?? "",
    );
    expect(construction, "the delivery body is no longer `{...p, deliveryId}`").not.toBeNull();

    // ...and it is the only thing serialized as a body.
    const stringifies = [...(dispatcher?.code ?? "").matchAll(/JSON\.stringify\(([^)]*)\)/g)].map(
      (m) => (m[1] ?? "").trim(),
    );
    expect(stringifies).toEqual(["row.payload"]);
  });

  it("FIRES on a planted ninth key", () => {
    const planted = `export interface WebhookPayload {
  readonly deliveryId: DeliveryId;
  readonly event: WebhookEvent;
  readonly daemonId: DaemonId;
  readonly workerId: WorkerId;
  readonly runId: RunId | null;
  readonly sessionId: SessionId | null;
  readonly seq: Seq;
  readonly ts: string;
  readonly prompt: string;
}`;
    const block = /export interface WebhookPayload \{([\s\S]*?)\n\}/.exec(planted)?.[1] ?? "";
    const declared = [...block.matchAll(/readonly\s+([A-Za-z0-9_]+)\s*:/g)].map((m) => m[1] ?? "");
    expect(declared.sort()).not.toEqual([...THIN_KEYS].sort());
    expect(declared).toContain("prompt");
  });
});

// ── no-unbounded-outbound ────────────────────────────────────────────────────

/** Every way of turning a `Response` into bytes this process would then hold. */
const BODY_READERS = ["text", "json", "arrayBuffer", "blob", "formData", "bytes"];

describe("guard: no-unbounded-outbound", () => {
  it("never reads a receiver's response body — only cancels it", () => {
    for (const source of webhookSources()) {
      for (const reader of BODY_READERS) {
        const hits = [...source.code.matchAll(new RegExp(`\\bres\\.${reader}\\s*\\(`, "g"))];
        expect({ file: source.file, reader, hits: hits.length }).toEqual({
          file: source.file,
          reader,
          hits: 0,
        });
      }
      // Nor through the body stream, which is the same unbounded input by another route.
      for (const via of ["getReader", "pipeTo", "pipeThrough", "tee"]) {
        expect({ file: source.file, via, hits: source.code.includes(`body?.${via}(`) }).toEqual({
          file: source.file,
          via,
          hits: false,
        });
      }
    }
  });

  it("CANCELS the body instead, which is the opposite of reading it", () => {
    const dispatcher = webhookSources().find((s) => s.file === "dispatcher.ts");
    // Cancelling is what returns the socket to the pool; leaving it alone leaks a connection per
    // delivery, and reading it takes bytes we have no use for from a party we do not trust.
    expect(dispatcher?.code).toMatch(/res\.body\?\.cancel\(\)/);
  });

  it("never follows a redirect, and always bounds the attempt", () => {
    const dispatcher = webhookSources().find((s) => s.file === "dispatcher.ts");
    // `manual` is the security decision: following a `302` turns an allowlisted origin into
    // whatever the receiver names next (§24.4). Scanned over the LITERAL projection, because
    // that is what it is.
    expect(dispatcher?.literals).toMatch(/redirect:\s*"manual"/);
    expect(dispatcher?.code).toMatch(/signal:\s*controller\.signal/);
    expect(dispatcher?.code).toMatch(/setTimer\(o\.config\.timeoutMs/);
  });

  it("FIRES on a planted body read", () => {
    const planted = read("planted.ts", `const body = await res.text();\nconst j = res.json();`);
    const hits = BODY_READERS.filter((r) => new RegExp(`\\bres\\.${r}\\s*\\(`).test(planted.code));
    expect(hits).toEqual(["text", "json"]);
  });

  it("does NOT fire on the doc comment that explains the rule", () => {
    // The prose in `dispatcher.ts` says "the response body is NEVER READ"; a substring scan would
    // fire on the sentence and teach the next author to delete it (amendment A8).
    const planted = read(
      "planted.ts",
      `// the body is never read: res.text() is forbidden\nconst x = 1;`,
    );
    const hits = BODY_READERS.filter((r) => new RegExp(`\\bres\\.${r}\\s*\\(`).test(planted.code));
    expect(hits).toEqual([]);
  });
});
