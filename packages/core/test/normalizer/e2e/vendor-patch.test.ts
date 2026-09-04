import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { transcriptUpdates } from "@omni-acp/testkit";
import { reduceTurn, type EventEnvelope, type TurnId, type WorkerId } from "@omni-acp/protocol";
import { createNormalizer } from "@omni-acp/core";
import { readStructuredPatch } from "../../../src/normalizer/vendor/dialects.js";
import { claudeAcpDescriptor } from "../support/claude-acp.js";

/**
 * CONTRACTS.md §12.5 / ruling M1-R11: `TurnResult.patch` stays NULL, and the verified vendor
 * reconstruction ships beside it as `TurnResult.vendorPatch`, clearly labelled.
 *
 * The claim being tested is not "we produce a patch-shaped string". It is that the string is a
 * patch **`git apply --check` accepts** — for the recorded EDIT and the recorded CREATION, both
 * of which are in the corpus and neither of which is a literal here. A real `git` in a real temp
 * repository is the only thing that can settle that.
 *
 * `skipIf(win32)` on the `git apply` assertion only (§11.6): the extractor assumes LF line
 * endings and text files, and there is no real Windows observation to write an expectation from.
 */

const D = claudeAcpDescriptor();
const POSIX = process.platform !== "win32";
const WORKER = "w_00000000000000000000000001" as WorkerId;
const TURN = "t_00000000000000000000000001" as TurnId;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A real git repository, with the given files committed. */
function repo(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "omni-patch-"));
  dirs.push(dir);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "--quiet");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "base", "--allow-empty");
  return dir;
}

function gitApplyCheck(dir: string, patch: string): { ok: boolean; error: string } {
  const file = join(dir, ".omni-patch");
  writeFileSync(file, patch);
  try {
    execFileSync("git", ["apply", "--check", "--verbose", ".omni-patch"], {
      cwd: dir,
      stdio: "pipe",
    });
    return { ok: true, error: "" };
  } catch (e) {
    return { ok: false, error: String((e as { stderr?: Buffer }).stderr ?? e) };
  }
}

/** The `_meta.claudeCode.toolResponse` block of the update at `index`, from the transcript. */
function toolResponseFrom(transcript: string, predicate: (u: Record<string, unknown>) => boolean) {
  const found = transcriptUpdates(transcript).filter(predicate);
  expect(found.length, `${transcript} has a toolResponse update`).toBeGreaterThan(0);
  const meta = found[found.length - 1]?.["_meta"] as {
    claudeCode: { toolResponse: Record<string, unknown> };
  };
  return meta.claudeCode.toolResponse;
}

const hasToolResponse = (u: Record<string, unknown>): boolean =>
  typeof u["_meta"] === "object" &&
  u["_meta"] !== null &&
  "claudeCode" in (u["_meta"] as object) &&
  "toolResponse" in
    ((u["_meta"] as { claudeCode: Record<string, unknown> }).claudeCode as object);

describe("§12.5 — the vendor patch, against a real git", () => {
  it("reconstructs the recorded EDIT (transcript 10) from `structuredPatch` + `originalFile`", () => {
    const response = toolResponseFrom("10-tool-edit-existing", hasToolResponse);
    expect(response["filePath"]).toBe("/tmp/acp-ws-edit-96xAuv/config.txt");
    expect(response["originalFile"]).toBe("mode = slow\nretries = 3\n");

    const patch = readStructuredPatch(response, "/tmp/acp-ws-edit-96xAuv");
    expect(patch).toEqual({
      format: "git_patch",
      source: "vendor",
      text: [
        "diff --git a/config.txt b/config.txt",
        "--- a/config.txt",
        "+++ b/config.txt",
        "@@ -1,2 +1,2 @@",
        "-mode = slow",
        "+mode = fast",
        " retries = 3",
        "",
      ].join("\n"),
    });
  });

  it.skipIf(!POSIX)("…and `git apply --check` accepts it in a temp repo", () => {
    const response = toolResponseFrom("10-tool-edit-existing", hasToolResponse);
    const patch = readStructuredPatch(response, "/tmp/acp-ws-edit-96xAuv");
    const dir = repo({ "config.txt": response["originalFile"] as string });
    const result = gitApplyCheck(dir, patch?.text ?? "");
    expect(`${String(result.ok)} ${result.error}`).toBe("true ");
  });

  it("reconstructs the recorded CREATION (transcript 03) from `content`, with no hunks at all", () => {
    const response = toolResponseFrom("03-tool-write-allowed", hasToolResponse);
    expect(response["structuredPatch"]).toEqual([]);
    expect(response["originalFile"]).toBeNull();

    const patch = readStructuredPatch(response, "/tmp/acp-ws-wa-VxS6ru");
    expect(patch).toEqual({
      format: "git_patch",
      source: "vendor",
      text: [
        "diff --git a/hello.txt b/hello.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/hello.txt",
        "@@ -0,0 +1,1 @@",
        "+hello",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    });
  });

  it.skipIf(!POSIX)("…and `git apply --check` accepts THAT in a temp repo too", () => {
    const response = toolResponseFrom("03-tool-write-allowed", hasToolResponse);
    const patch = readStructuredPatch(response, "/tmp/acp-ws-wa-VxS6ru");
    const dir = repo({ ".keep": "" });
    const result = gitApplyCheck(dir, patch?.text ?? "");
    expect(`${String(result.ok)} ${result.error}`).toBe("true ");
  });

  it("returns NULL rather than WRONG when the hunk counts disagree with the hunk", () => {
    // §11.6's accepted risk, made a check: the extractor assumes LF and text files, so the one
    // thing it must never do is emit a patch git will misapply.
    const broken = {
      filePath: "/tmp/ws/config.txt",
      originalFile: "a\nb\n",
      structuredPatch: [
        { oldStart: 1, oldLines: 9, newStart: 1, newLines: 2, lines: ["-a", "+A", " b"] },
      ],
    };
    expect(readStructuredPatch(broken, "/tmp/ws")).toBeNull();
  });

  it("returns NULL for a shape it does not understand, rather than guessing", () => {
    for (const bad of [
      null,
      7,
      {},
      { filePath: "/tmp/ws/a" },
      { filePath: "/tmp/ws/a", structuredPatch: "nope" },
      // A creation whose `originalFile` is NOT null is a contradiction we must not resolve.
      { filePath: "/tmp/ws/a", structuredPatch: [], originalFile: "x", content: "y" },
      // Hunks, but no original file to apply them to.
      {
        filePath: "/tmp/ws/a",
        originalFile: null,
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }],
      },
      // An unrecognized line marker.
      {
        filePath: "/tmp/ws/a",
        originalFile: "a\n",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["?a"] }],
      },
    ]) {
      expect(readStructuredPatch(bad, "/tmp/ws"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("keeps an absolute path applicable rather than emitting `a//tmp/...`", () => {
    // No `baseDir`, or a file outside it: the leading separator is dropped so the patch is still
    // applicable with git's default `-p1` from the filesystem root. Unreachable-but-honest beats
    // a header git cannot parse.
    const response = toolResponseFrom("03-tool-write-allowed", hasToolResponse);
    const patch = readStructuredPatch(response);
    expect(patch?.text).toContain("diff --git a/tmp/acp-ws-wa-VxS6ru/hello.txt");
    expect(patch?.text).not.toContain("a//tmp");
  });
});

describe("§12.5 — where the patch ends up, and where it must not", () => {
  /** The mapped stream of one transcript, as the log would hold it. */
  function envelopes(transcript: string): EventEnvelope[] {
    const norm = createNormalizer({
      quietMs: 250,
      hardMs: 5_000,
      descriptor: D,
      cwd: transcript === "03-tool-write-allowed" ? "/tmp/acp-ws-wa-VxS6ru" : "/tmp/acp-ws-edit-96xAuv",
    });
    const out: EventEnvelope[] = [];
    let seq = 0;
    const drive = (input: Parameters<typeof norm.step>[0]): void => {
      for (const e of norm.step(input).emit) {
        seq += 1;
        out.push({
          seq,
          ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
          daemonId: "d_00000000000000000000000001",
          workerId: WORKER,
          sessionId: "s",
          turnId: e.turnId ?? null,
          payloadVersion: e.payloadVersion,
          ...(e.replay === undefined ? {} : { replay: e.replay }),
          kind: e.kind,
          payload: e.payload,
        } as EventEnvelope);
      }
    };

    drive({ type: "prompt_sent", turnId: TURN, at: 0 });
    for (const update of transcriptUpdates(transcript)) {
      drive({ type: "agent_update", update, at: 1 });
    }
    drive({ type: "prompt_result", stopReason: "end_turn", at: 2 });
    drive({ type: "tick", at: 1_000 });
    return out;
  }

  it("`TurnResult.patch` is NULL and `vendorPatch` carries it, labelled", () => {
    const result = reduceTurn(TURN, envelopes("10-tool-edit-existing"));
    expect(result.patch).toBeNull();
    expect(result.vendorPatch).toEqual({
      format: "git_patch",
      source: "vendor",
      text: expect.stringContaining("diff --git a/config.txt b/config.txt") as unknown as string,
    });
  });

  it.skipIf(!POSIX)("and THAT string — the one a client actually receives — also applies", () => {
    const result = reduceTurn(TURN, envelopes("10-tool-edit-existing"));
    const dir = repo({ "config.txt": "mode = slow\nretries = 3\n" });
    const check = gitApplyCheck(dir, result.vendorPatch?.text ?? "");
    expect(`${String(check.ok)} ${check.error}`).toBe("true ");
  });

  it("the CREATION's patch survives the whole pipeline too, even though its update has no diff", () => {
    // The update that carries `structuredPatch` for a creation is `{toolCallId, sessionUpdate,
    // _meta}` and NOTHING else — no `content`, no diff block. So a design that read the patch off
    // the diff block would produce `null` here, which is why it is read at the update level and
    // carried on `state_update{idle}`.
    const result = reduceTurn(TURN, envelopes("03-tool-write-allowed"));
    expect(result.vendorPatch?.text).toContain("new file mode 100644");
    expect(result.patch).toBeNull();
  });

  it("`changes` is built from `omni/v1Diff`, with `fragment` true and no double-counting", () => {
    // §12.8 case `10-edit`: `content` WIDENS between updates, and `ToolCallUpdate.content`
    // replaces the collection — so the final content is folded once and there is exactly one
    // `FileChange`.
    const result = reduceTurn(TURN, envelopes("10-tool-edit-existing"));
    expect(result.changes).toEqual([
      {
        path: "/tmp/acp-ws-edit-96xAuv/config.txt",
        operation: "modify",
        oldText: "mode = slow\nretries = 3",
        newText: "mode = fast\nretries = 3",
        fragment: true,
      },
    ]);
  });
});
