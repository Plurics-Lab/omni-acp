import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architecture guard: `sse-is-unchanged` (CONTRACTS.md §10.2, M1-PLAN §1.3 exit criterion 7).
 *
 * `daemon/src/http/sse.ts` must be BYTE-IDENTICAL to its M0 content for the whole of M1.
 *
 * The reason is a claim M1 makes and must not quietly weaken: restart-survivable `?since=` is a
 * DRIVER SWAP (§14.8) — the ring stays in front of a write-through store, `EventLog.subscribe`
 * keeps its one synchronous replay-then-attach critical section, and the SSE writer never learns
 * that a log can be durable. If persistence turns out to need an SSE rewrite, that is a finding
 * worth stopping for, not a diff worth merging: the "replay then live, with no event in between"
 * property is the one the whole reconnect acceptance rests on.
 *
 * The digest is over the file's bytes with CRLF normalised, because `.gitattributes` checks the
 * repository out with LF everywhere but a Windows editor can still write CRLF, and a guard that
 * fired on line endings would teach people to disable it.
 */
const SSE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "http", "sse.ts");

/** sha256 of `packages/daemon/src/http/sse.ts` as M0 shipped it (commit 28826b3). */
const M0_SHA256 = "c3cce04daa62c141fe62f5677be783b60e463f4af586e7bab146bb40ac10c08b";

describe("guard: sse-is-unchanged", () => {
  it("is byte-identical to M0's sse.ts", () => {
    const bytes = readFileSync(SSE, "utf8").replace(/\r\n/g, "\n");
    const actual = createHash("sha256").update(bytes, "utf8").digest("hex");
    expect({ file: "http/sse.ts", sha256: actual }).toEqual({
      file: "http/sse.ts",
      sha256: M0_SHA256,
    });
  });

  it("would catch a one-character edit", () => {
    // The mechanism, asserted: a guard nobody has watched fail is a guard nobody knows works.
    const bytes = readFileSync(SSE, "utf8").replace(/\r\n/g, "\n");
    const planted = createHash("sha256").update(`${bytes} `, "utf8").digest("hex");
    expect(planted).not.toBe(M0_SHA256);
  });
});
