import { mkdtemp, mkdir, rm, symlink, writeFile, realpath as fsRealpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchRule, toPolicySubject } from "@omni-acp/core";
import { PolicyRule } from "@omni-acp/protocol";
import { interactionRequest, identityRealpath } from "./support.js";

/**
 * `toPolicySubject` against a REAL filesystem, because the two things it exists to do are both
 * about inodes and neither is observable against a fake:
 *
 *  - realpath, THEN contain: a symlink inside `src/` that resolves outside it must not satisfy
 *    `src/**`, or a symlink is a way to author a permission;
 *  - a file that does not exist yet: a create names a path with no inode, and without the
 *    deepest-existing-ancestor walk every `allow` rule for `src/**` fails on exactly the writes
 *    it exists to permit.
 *
 * The tree is built under `mkdtemp`, and every expectation is written against the REALPATH of the
 * temp dir — on macOS `/var` is itself a symlink to `/private/var`, so a test that compared
 * against `tmpdir()` would pass on Linux and fail on a mac for a reason that has nothing to do
 * with policy.
 *
 * Owned by M2-B-WP-P.
 */

let root = "";
let outside = "";

beforeAll(async () => {
  root = await fsRealpath(await mkdtemp(join(tmpdir(), "omni-policy-subject-")));
  outside = join(root, "outside");
  await mkdir(join(root, "repo", "src"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "repo", "src", "main.ts"), "export {};\n");
  await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET-BETA\n");
  await symlink(join(outside, "secret.txt"), join(root, "repo", "src", "link.txt"));
});

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

const cwd = (): string => join(root, "repo");

const toolCallRequest = (locations: readonly string[], kind = "edit") =>
  interactionRequest({
    subject: {
      type: "tool_call",
      toolCall: {
        toolCallId: "call_1",
        kind,
        locations: locations.map((path) => ({ path })),
      },
    },
  });

const build = (locations: readonly string[], kind = "edit") =>
  toPolicySubject(toolCallRequest(locations, kind), {
    cwd: cwd(),
    agentId: "fixture",
    realpath: fsRealpath,
  });

const srcRule = PolicyRule.parse({
  id: "e1",
  match: { kind: ["edit"], path: ["src/**"] },
  action: "allow",
});

describe("toPolicySubject — realpath, then contain", () => {
  it("realpaths an existing file", async () => {
    const s = await build([join(cwd(), "src", "main.ts")]);
    expect(s.paths).toEqual([join(root, "repo", "src", "main.ts")]);
    expect(matchRule(srcRule, s)).toBe(true);
  });

  it("resolves a RELATIVE location against the worker's cwd", async () => {
    const s = await build(["src/main.ts"]);
    expect(s.paths).toEqual([join(root, "repo", "src", "main.ts")]);
    expect(matchRule(srcRule, s)).toBe(true);
  });

  it("a symlink INSIDE src/ that resolves outside it does NOT satisfy src/**", async () => {
    const s = await build([join(cwd(), "src", "link.txt")]);
    expect(s.paths).toEqual([join(outside, "secret.txt")]);
    expect(
      matchRule(srcRule, s),
      "the written path was inside src/, and the inode is not — the inode wins",
    ).toBe(false);
  });

  it("WOULD PASS if the realpath were skipped — the invariant, demonstrated", async () => {
    // The same subject built with an identity `realpath`: the symlink now satisfies the grant,
    // which is exactly the escape the canonicalization exists to close.
    const naive = await toPolicySubject(toolCallRequest([join(cwd(), "src", "link.txt")]), {
      cwd: cwd(),
      agentId: "fixture",
      realpath: identityRealpath,
    });
    expect(matchRule(srcRule, naive)).toBe(true);
  });
});

describe("toPolicySubject — a file that does not exist yet (a create)", () => {
  it("resolves through the deepest EXISTING ancestor and re-appends the remainder", async () => {
    const s = await build([join(cwd(), "src", "brand-new.ts")]);
    expect(s.paths).toEqual([join(root, "repo", "src", "brand-new.ts")]);
    expect(matchRule(srcRule, s), "an allow rule must permit the writes it exists for").toBe(true);
  });

  it("works through SEVERAL missing segments", async () => {
    const s = await build([join(cwd(), "src", "a", "b", "c.ts")]);
    expect(s.paths).toEqual([join(root, "repo", "src", "a", "b", "c.ts")]);
    expect(matchRule(srcRule, s)).toBe(true);
  });

  it("and the ancestor walk still canonicalizes: a create UNDER a symlink lands outside", async () => {
    await symlink(join(root, "outside"), join(root, "repo", "src", "linkdir"), "dir");
    const s = await build([join(cwd(), "src", "linkdir", "new.txt")]);
    expect(s.paths).toEqual([join(outside, "new.txt")]);
    expect(matchRule(srcRule, s)).toBe(false);
  });

  it("a path whose every ancestor is missing is still an ABSOLUTE, never a throw", async () => {
    const s = await toPolicySubject(toolCallRequest(["/nope-nothing-here/at/all.txt"]), {
      cwd: cwd(),
      agentId: "fixture",
      realpath: () => Promise.reject(new Error("ENOENT")),
    });
    expect(s.paths).toEqual(["/nope-nothing-here/at/all.txt"]);
  });
});

describe("toPolicySubject — the rest of the shape", () => {
  it("dedupes paths while keeping stream order", async () => {
    const p = join(cwd(), "src", "main.ts");
    const s = await build([p, p, join(cwd(), "src", "brand-new.ts")]);
    expect(s.paths).toEqual([
      join(root, "repo", "src", "main.ts"),
      join(root, "repo", "src", "brand-new.ts"),
    ]);
  });

  it("reads a command from the COMMAND arm and from nowhere else (F38)", async () => {
    const s = await toPolicySubject(
      interactionRequest({
        subject: { type: "command", command: "pnpm test", cwd: cwd() },
      }),
      { cwd: cwd(), agentId: "fixture", realpath: fsRealpath },
    );
    expect(s.type).toBe("command");
    expect(s.command).toBe("pnpm test");
    expect(s.kind).toBeNull();
    expect(s.paths).toEqual([]);

    // A tool call carrying a command-looking `rawInput` yields NO command: inventing a string to
    // match on is exactly what `no-agent-prose` forbids.
    const toolCall = await toPolicySubject(
      interactionRequest({
        subject: {
          type: "tool_call",
          toolCall: { toolCallId: "c", kind: "execute", rawInput: { command: "rm -rf /" } },
        },
      }),
      { cwd: cwd(), agentId: "fixture", realpath: fsRealpath },
    );
    expect(toolCall.command).toBeNull();
  });

  it("an ELICITATION gets its own tag, so D10's other half is addressable by a rule", async () => {
    const s = await toPolicySubject(
      interactionRequest({
        kind: "elicitation",
        method: "elicitation/create",
        subject: null,
        options: [],
      }),
      { cwd: cwd(), agentId: "fixture", realpath: fsRealpath },
    );
    expect(s.type).toBe("elicitation");
    expect(s.method).toBe("elicitation/create");
    expect(s.kind).toBeNull();
  });

  it("a PERMISSION with no readable subject falls to a tag no rule matches", async () => {
    const s = await toPolicySubject(interactionRequest({ subject: null }), {
      cwd: cwd(),
      agentId: "fixture",
      realpath: fsRealpath,
    });
    expect(s.type).toBe("unknown");
    expect(
      matchRule(PolicyRule.parse({ id: "r", match: { kind: ["*"] }, action: "allow" }), s),
    ).toBe(false);
  });

  it("carries the title for the audit record, and the cwd and agent from the context", async () => {
    const s = await build([]);
    expect(s.title).toBe("Write src/main.ts");
    expect(s.cwd).toBe(cwd());
    expect(s.agentId).toBe("fixture");
  });

  it("is TOTAL over a malformed locations array", async () => {
    const s = await toPolicySubject(
      interactionRequest({
        subject: {
          type: "tool_call",
          toolCall: { toolCallId: "c", kind: "edit", locations: [null, 7, {}, { path: 3 }] },
        },
      }),
      { cwd: cwd(), agentId: "fixture", realpath: fsRealpath },
    );
    expect(s.paths).toEqual([]);
  });
});
