import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPromptContent } from "@omni-acp/core";
import { OmniError, type PromptCapabilities } from "@omni-acp/protocol";
import { packageSources, sourceFile, type SourceFile } from "../mcp/scan.js";

/**
 * `assertPromptContent` — H28's moved gate. Realpath FIRST, then contain, and always BEFORE the
 * prompt reaches the wire.
 *
 * WP-S acceptance 8, the unit half; `tests/integration/src/prompt-content.itest.ts` carries the
 * half that proves the agent recorded ZERO `session/prompt` calls.
 *
 * The two shapes under test are the recorded ones (F37, F38, corpus claude 17 / codex 09):
 * `resource_link(file://<cwd>/inside.txt)` beside `resource_link(file://<other tmpdir>/outside.txt)`,
 * accepted by both agents and contained by neither.
 *
 * Owned by M2-B-WP-S.
 */

/** claude-acp 0.73.0's recorded `promptCapabilities`, mapped to v2 (§12.3 row 21). */
const CLAUDE: PromptCapabilities = { image: {}, embeddedContext: {} } as PromptCapabilities;

let root: string;
let other: string;
let inside: string;
let outside: string;
let escapingLink: string;
let innocentLink: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "omni-pc-root-")));
  other = await realpath(await mkdtemp(join(tmpdir(), "omni-pc-other-")));
  inside = join(root, "inside.txt");
  outside = join(other, "outside.txt");
  await writeFile(inside, "INSIDE-OK\n");
  await writeFile(outside, "OUTSIDE-SECRET-BETA\n");

  // The case a string-prefix check passes and this must not: a link INSIDE cwd whose target is
  // not. This is the whole reason the order is realpath-then-contain.
  escapingLink = join(root, "escape.txt");
  await symlink(outside, escapingLink);
  innocentLink = join(root, "innocent.txt");
  await symlink(inside, innocentLink);
});

afterAll(async () => {
  for (const dir of [root, other]) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const link = (path: string) => ({
  type: "resource_link",
  uri: pathToFileURL(path).href,
  name: "n",
});
const embedded = (path: string) => ({
  type: "resource",
  resource: { uri: pathToFileURL(path).href, text: "…" },
});
const text = (t = "hello") => ({ type: "text", text: t });

function gate(
  content: readonly unknown[],
  over?: Partial<Parameters<typeof assertPromptContent>[0]>,
) {
  return assertPromptContent({
    content,
    cwd: root,
    cwdRoots: [root],
    promptCapabilities: CLAUDE,
    realpath,
    ...over,
  });
}

async function failure(p: Promise<unknown>): Promise<OmniError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OmniError)) throw new Error(`expected an OmniError, got ${String(e)}`);
  return e;
}

describe("assertPromptContent (§26, H28) — the M0 path is unchanged", () => {
  it("accepts text and returns the content BY IDENTITY", async () => {
    const content = [text("who are you?"), text("and again")];
    await expect(gate(content)).resolves.toBe(content);
  });

  it("still refuses an empty array and a block that is not an object with a string type", async () => {
    expect((await failure(gate([]))).message).toContain("empty");
    expect((await failure(gate([null]))).message).toContain("not an object");
    expect((await failure(gate([[]]))).message).toContain("not an object");
    expect((await failure(gate([{ text: "no type" }]))).message).toContain('no string "type"');
    expect((await failure(gate([{ type: "text" }]))).message).toContain("no string text");
  });

  it("names the type of a block it does not know", async () => {
    const e = await failure(gate([{ type: "terminal" }]));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain('"terminal"');
    expect(e.detail).toStrictEqual({ blockIndex: 0, blockType: "terminal" });
  });

  it("costs ZERO syscalls for a text-only prompt", async () => {
    // The gate builds its root set lazily, so the M0 path does not pay a realpath per prompt —
    // and, since a text-only prompt never reaches the disk, an un-resolvable cwd cannot fail it.
    let calls = 0;
    await gate([text()], {
      realpath: (p) => {
        calls += 1;
        return Promise.resolve(p);
      },
    });
    expect(calls).toBe(0);
  });
});

describe("assertPromptContent — promptCapabilities gates image and audio, and nothing else", () => {
  it("accepts an advertised image and refuses an unadvertised audio", async () => {
    await expect(gate([{ type: "image", data: "", mimeType: "image/png" }])).resolves.toBeTruthy();
    const e = await failure(gate([{ type: "audio", data: "", mimeType: "audio/wav" }]));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("promptCapabilities");
  });

  it("refuses BOTH when the agent advertised nothing at all", async () => {
    for (const type of ["image", "audio"]) {
      const e = await failure(
        gate([{ type, data: "", mimeType: "x/y" }], { promptCapabilities: null }),
      );
      expect(e.code, type).toBe("bad_request");
    }
  });

  it("does NOT gate resource links on embeddedContext — neither agent advertises anything", async () => {
    // F37/F38: gating on `embeddedContext` would break both real agents for no security gain,
    // because containment is the control and neither agent declares a resource-link capability.
    await expect(gate([link(inside)], { promptCapabilities: null })).resolves.toBeTruthy();
    await expect(gate([embedded(inside)], { promptCapabilities: null })).resolves.toBeTruthy();
  });
});

describe("assertPromptContent — containment, realpath FIRST", () => {
  it("accepts a link inside cwdRoots (corpus 17's inside.txt)", async () => {
    await expect(gate([text(), link(inside)])).resolves.toBeTruthy();
  });

  it("refuses a link OUTSIDE cwdRoots (corpus 17's outside.txt)", async () => {
    const e = await failure(gate([text(), link(outside)]));
    expect(e.code).toBe("bad_request");
    expect(e.status).toBe(400);
    expect(e.detail).toStrictEqual({ blockIndex: 1, blockType: "resource_link" });
  });

  it("refuses a SYMLINK inside cwd that realpaths outside it — a string check would pass it", async () => {
    // The link's own path starts with the root, so `uri.startsWith(root)` is true and every
    // prefix comparison anybody would write accepts it.
    expect(escapingLink.startsWith(root)).toBe(true);
    expect((await failure(gate([link(escapingLink)]))).code).toBe("bad_request");
    // …and a symlink that stays inside is still fine, so the rule is containment and not "no
    // symlinks".
    await expect(gate([link(innocentLink)])).resolves.toBeTruthy();
  });

  it("ELIDES the path — from the message AND from the logged detail", async () => {
    for (const block of [link(outside), embedded(outside), link(escapingLink)]) {
      const e = await failure(gate([block]));
      const seen = `${e.message} ${JSON.stringify(e.detail)}`;
      expect(seen).not.toContain(outside);
      expect(seen).not.toContain(other);
      expect(seen).not.toContain("outside.txt");
      expect(seen).not.toContain("OUTSIDE-SECRET-BETA");
    }
  });

  it("answers a MISSING path and an OUTSIDE path with the same sentence — no filesystem oracle", async () => {
    const missing = await failure(gate([link(join(root, "no-such-file.txt"))]));
    const escaped = await failure(gate([link(outside)]));
    expect(missing.message.replace(/block \d+/, "block")).toBe(
      escaped.message.replace(/block \d+/, "block"),
    );
  });

  it("applies the identical rule to an EMBEDDED resource block", async () => {
    await expect(gate([embedded(inside)])).resolves.toBeTruthy();
    expect((await failure(gate([embedded(outside)]))).code).toBe("bad_request");
    expect((await failure(gate([embedded(escapingLink)]))).code).toBe("bad_request");
    expect((await failure(gate([{ type: "resource", resource: {} }]))).message).toContain(
      "no string uri",
    );
    expect((await failure(gate([{ type: "resource" }]))).message).toContain("no string uri");
  });

  it("canonicalises the ROOTS too, so a symlinked root does not reject everything under it", async () => {
    const alias = await mkdtemp(join(tmpdir(), "omni-pc-alias-"));
    const aliasRoot = join(alias, "link-to-root");
    await symlink(root, aliasRoot);
    try {
      // `/tmp` is a symlink to `/private/tmp` on macOS; a root that did not canonicalise would
      // reject every path underneath it.
      await expect(
        gate([link(inside)], { cwdRoots: [aliasRoot], cwd: aliasRoot }),
      ).resolves.toBeTruthy();
    } finally {
      await rm(alias, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("takes the FIRST matching root out of several", async () => {
    await expect(
      gate([link(outside)], { cwdRoots: [other, root], cwd: root }),
    ).resolves.toBeTruthy();
    await expect(
      gate([link(inside)], { cwdRoots: [other, root], cwd: root }),
    ).resolves.toBeTruthy();
  });

  it("does NOT confuse a sibling directory whose name shares a prefix", async () => {
    // `<root>-evil` starts with `<root>` and is not inside it.
    const sibling = `${root}-evil`;
    await mkdtemp(sibling).catch(() => undefined);
    const evil = join(other, "evil.txt");
    await writeFile(evil, "x");
    expect((await failure(gate([link(evil)]))).code).toBe("bad_request");
  });
});

describe("assertPromptContent — the uri itself", () => {
  it("refuses a relative uri, a non-file scheme, a host, and a `..` traversal", async () => {
    const cases: Record<string, unknown> = {
      relative: { type: "resource_link", uri: "notes.txt" },
      dotSlash: { type: "resource_link", uri: "./notes.txt" },
      bareAbsolute: { type: "resource_link", uri: "/etc/shadow" },
      https: { type: "resource_link", uri: "https://example.invalid/x" },
      data: { type: "resource_link", uri: "data:text/plain,hi" },
      unc: { type: "resource_link", uri: "file://server/share/x" },
      traversal: { type: "resource_link", uri: `file://${root}/../../etc/shadow` },
      encodedTraversal: { type: "resource_link", uri: `file://${root}/%2e%2e/x` },
      nul: { type: "resource_link", uri: `file://${root}/a%00b` },
      empty: { type: "resource_link", uri: "" },
      notAString: { type: "resource_link", uri: 42 },
    };
    for (const [name, block] of Object.entries(cases)) {
      const e = await failure(gate([block]));
      expect(e.code, name).toBe("bad_request");
      expect(e.status, name).toBe(400);
    }
  });

  it("accepts `file://localhost/...`, which RFC 8089 says is this machine", async () => {
    const href = pathToFileURL(inside).href.replace("file://", "file://localhost");
    await expect(gate([{ type: "resource_link", uri: href }])).resolves.toBeTruthy();
  });

  it("decodes percent-escapes before resolving, so a spaced filename works", async () => {
    const spaced = join(root, "two words.txt");
    await writeFile(spaced, "x");
    const href = pathToFileURL(spaced).href;
    expect(href).toContain("%20");
    await expect(gate([{ type: "resource_link", uri: href, name: "n" }])).resolves.toBeTruthy();
  });
});

describe("assertPromptContent — Windows path shapes, with an injected platform and a fake realpath", () => {
  // `node:url`'s `fileURLToPath` answers by the platform the PROCESS runs on, so a Windows-shape
  // test on a Linux runner would exercise the posix branch and pass for the wrong reason. The
  // platform is injected instead — the same rule `resolveWorkerEnv` follows — and the realpath
  // is a fake, because a Linux runner has no `C:\`.
  const WIN_ROOT = "C:\\Users\\runner\\work";
  const winRealpath = (p: string): Promise<string> => {
    // One recorded escape: a junction inside the workspace pointing at the profile directory.
    if (p === "C:\\Users\\runner\\work\\junction") {
      return Promise.resolve("C:\\Users\\runner\\.ssh");
    }
    return Promise.resolve(p);
  };
  const win = (uri: string) =>
    assertPromptContent({
      content: [{ type: "resource_link", uri, name: "n" }],
      cwd: WIN_ROOT,
      cwdRoots: [WIN_ROOT],
      promptCapabilities: CLAUDE,
      realpath: winRealpath,
      platform: "win32",
    });

  it("accepts a drive-rooted file uri inside the root", async () => {
    await expect(win("file:///C:/Users/runner/work/notes.txt")).resolves.toBeTruthy();
  });

  it("folds case, because Windows does", async () => {
    await expect(win("file:///c:/users/RUNNER/Work/notes.txt")).resolves.toBeTruthy();
  });

  it("refuses a path outside the root, and a junction that resolves outside it", async () => {
    expect((await failure(win("file:///C:/Windows/System32/config/SAM"))).code).toBe("bad_request");
    expect((await failure(win("file:///C:/Users/runner/work/junction"))).code).toBe("bad_request");
  });

  it("refuses a pathname with no drive letter — inventing one would be guessing", async () => {
    expect((await failure(win("file:///Users/runner/work/notes.txt"))).code).toBe("bad_request");
  });

  it("refuses a `..` traversal written with either separator", async () => {
    expect((await failure(win("file:///C:/Users/runner/work/../../.ssh/id_rsa"))).code).toBe(
      "bad_request",
    );
  });

  it("and the SAME uri reads as a posix path under a posix platform", async () => {
    // The two branches disagree about `file:///C:/…`, which is exactly why the platform is a
    // parameter: on posix that pathname IS `/C:/…`, a perfectly ordinary relative-to-root path.
    const posixGate = assertPromptContent({
      content: [
        { type: "resource_link", uri: "file:///C:/Users/runner/work/notes.txt", name: "n" },
      ],
      cwd: "/C:/Users/runner/work",
      cwdRoots: ["/C:/Users/runner/work"],
      promptCapabilities: CLAUDE,
      realpath: (p) => Promise.resolve(p),
      platform: "linux",
    });
    await expect(posixGate).resolves.toBeTruthy();
  });
});

describe("assertPromptContent — a mis-bound gate fails LOUDLY, not permissively", () => {
  it("is `internal` when there are no cwdRoots at all", async () => {
    const e = await failure(gate([link(inside)], { cwdRoots: [] }));
    expect(e.code).toBe("internal");
    expect(e.status).toBe(500);
    expect(e.message).toContain("mis-bound");
  });

  it("is `internal` when the bound cwd is outside every root", async () => {
    const e = await failure(gate([link(inside)], { cwd: other, cwdRoots: [root] }));
    expect(e.code).toBe("internal");
    expect(e.message).toContain("cwd is outside cwdRoots");
  });

  it("resolves the root set ONCE per call, however many blocks carry a path", async () => {
    const count = async (content: readonly unknown[]): Promise<number> => {
      let roots = 0;
      await gate(content, {
        realpath: (p) => {
          if (p === root) roots += 1;
          return realpath(p);
        },
      });
      return roots;
    };
    // Two lookups of `root` per CALL — once as a `cwdRoot`, once as the bound `cwd` — and the
    // number does not grow with the content. A gate that rebuilt its root set per block would
    // pay a realpath per block on the hot path and would still be correct, which is exactly the
    // kind of regression only a counting test catches.
    const one = await count([link(inside)]);
    const three = await count([link(inside), link(innocentLink), embedded(inside)]);
    expect(one).toBe(2);
    expect(three).toBe(one);
  });
});

// ── guard: assert-prompt-content-is-called (§26.2, §27.4, review R2) ─────────────────────────
//
// STRUCTURAL, NOT NAME-BASED, and that distinction is the whole guard. `worker.ts`'s M0 fallback
// is deliberately spelled `assertTextOnlyContent` precisely so that a guard matching on the NAME
// `assertPromptContent` could pass while the real check was never injected — which §11.9 calls
// the single most dangerous hunk in M2, because a schema that silently stopped enforcing
// containment looks exactly like a schema that got more capable.
//
// So the guard asserts the WIRING: `Worker.prompt` awaits the INJECTED validator before anything
// reaches the wire, the deleted zod refine really is gone, the fallback is not the gate, and the
// daemon's worker-creation path passes `deps.validateContent` bound to the token's `cwdRoots` and
// the worker's `promptCapabilities`.

interface InjectionReport {
  /** `Worker.prompt` awaits `this.#deps.validateContent` (with the fallback behind `??`). */
  readonly workerAwaitsInjected: boolean;
  /** …and it does so BEFORE `session/prompt` reaches the link. */
  readonly awaitsBeforeTheWire: boolean;
  /** `worker.ts` never names `assertPromptContent`, so a name match cannot stand in for it. */
  readonly fallbackIsSpeltDifferently: boolean;
  /** `PromptRequestBody` carries no content-type refine any more (H28's deletion). */
  readonly refineIsGone: boolean;
  /** The daemon's worker-creation path passes `validateContent`… */
  readonly creationPathInjects: boolean;
  /** …bound to the token's `cwdRoots`… */
  readonly boundToCwdRoots: boolean;
  /** …and to the worker's `promptCapabilities`. */
  readonly boundToPromptCapabilities: boolean;
}

const AWAIT_INJECTED = /await\s*\(\s*this\.#deps\.validateContent\s*\?\?/;
/** A `validateContent:` PROPERTY, i.e. a value being passed in — not a declaration or a read. */
const PASSES_VALIDATE_CONTENT = /\bvalidateContent\s*:/;

export function auditPromptContentInjection(sources: readonly SourceFile[]): InjectionReport {
  const find = (path: string): SourceFile =>
    sources.find((s) => s.path === path) ?? sourceFile(path, "");

  const worker = find("packages/core/src/worker/worker.ts");
  const registry = find("packages/daemon/src/registry.ts");
  const controlPlane = find("packages/protocol/src/control-plane.ts");

  const awaitAt = worker.code.search(AWAIT_INJECTED);
  // The FIRST `session/prompt` on the link. It lives in a string literal, which `code` blanks, so
  // this one reads `text` — and it is an offset comparison rather than a name check, which is
  // what makes "before anything reaches the wire" a property rather than a claim.
  const wireAt = worker.text.indexOf('link.request<unknown>("session/prompt"');

  // `PromptRequestBody = z.strictObject({...})` with no `.refine` / `.superRefine` chained onto
  // it: H28 DELETED the text-only refine rather than widening it, because zod holds neither this
  // worker's `promptCapabilities` nor this token's `cwdRoots`.
  const declaration = /PromptRequestBody\s*=\s*z\.strictObject\(\{[\s\S]*?\}\)\s*;/.exec(
    controlPlane.code,
  );

  const registryCall = PASSES_VALIDATE_CONTENT.exec(registry.code);
  // The binding is looked for in the SAME statement, so that a `validateContent` passed with a
  // hand-rolled always-true closure is not mistaken for the real gate.
  const window =
    registryCall === null ? "" : registry.code.slice(registryCall.index, registryCall.index + 600);

  return {
    workerAwaitsInjected: awaitAt !== -1,
    awaitsBeforeTheWire: awaitAt !== -1 && wireAt !== -1 && awaitAt < wireAt,
    fallbackIsSpeltDifferently:
      !worker.code.includes("assertPromptContent") && worker.code.includes("assertTextOnlyContent"),
    refineIsGone: declaration !== null && !/\.(superR|r)efine\(/.test(declaration[0]),
    creationPathInjects: registryCall !== null,
    boundToCwdRoots: /\bcwdRoots\b/.test(window),
    boundToPromptCapabilities: /\bpromptCapabilities\b/.test(window),
  };
}

describe("guard: assert-prompt-content-is-called (§26.2, review R2)", () => {
  const sources = packageSources();
  const report = auditPromptContentInjection(sources);

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map((s) => s.path)).toContain("packages/core/src/worker/worker.ts");
    expect(sources.map((s) => s.path)).toContain("packages/daemon/src/registry.ts");
  });

  it("`Worker.prompt` awaits the INJECTED validator, before anything reaches the wire", () => {
    expect(report.workerAwaitsInjected).toBe(true);
    expect(report.awaitsBeforeTheWire).toBe(true);
  });

  it("the fallback is spelt DIFFERENTLY, so a name match cannot stand in for the injection", () => {
    expect(report.fallbackIsSpeltDifferently).toBe(true);
  });

  it("the deleted `PromptRequestBody` refine is gone and has not been quietly restored", () => {
    expect(report.refineIsGone).toBe(true);
  });

  /**
   * UNBLOCKED at the join (M2-WP-J). `packages/daemon/src/registry.ts` was M2-WP-J's file and
   * frozen for M2-B-WP-S, which is why this assertion shipped `.skip`'d beside a checker that was
   * already complete and already demonstrated failing. The wiring landed with the join, so the
   * assertion runs — and the honesty test that stood guard over the skip (it asserted the live
   * registry did NOT inject, so the skip could not rot into a lie) is GONE rather than inverted:
   * a test that asserts the feature is absent has no meaning once it is present, and this one
   * below says the same thing the right way round.
   */
  it("the daemon's worker-creation path passes deps.validateContent bound to cwdRoots and promptCapabilities", () => {
    expect(report.creationPathInjects).toBe(true);
    expect(report.boundToCwdRoots).toBe(true);
    expect(report.boundToPromptCapabilities).toBe(true);
  });

  it("is demonstrated FAILING on each planted violation", () => {
    const worker = sources.find((s) => s.path === "packages/core/src/worker/worker.ts");
    expect(worker).toBeDefined();
    const workerText = worker?.text ?? "";

    // (1) The injection removed — `prompt()` calls the M0 fallback unconditionally, which is
    //     exactly what "the real check was never injected" looks like in a diff.
    const removed = sourceFile(
      "packages/core/src/worker/worker.ts",
      workerText.replace(
        "await (this.#deps.validateContent ?? assertTextOnlyContent)(content);",
        "await assertTextOnlyContent(content);",
      ),
    );
    expect(removed.text).not.toBe(workerText);
    expect(auditPromptContentInjection([removed]).workerAwaitsInjected).toBe(false);

    // (2) The fallback RENAMED to the real gate's name — the failure §26.2 says a name-matching
    //     guard would pass. This one does not.
    const renamed = sourceFile(
      "packages/core/src/worker/worker.ts",
      workerText.split("assertTextOnlyContent").join("assertPromptContent"),
    );
    expect(auditPromptContentInjection([renamed]).fallbackIsSpeltDifferently).toBe(false);

    // (3) The zod refine restored, which would put containment back in the one place that holds
    //     neither `cwdRoots` nor `promptCapabilities`.
    const refined = sourceFile(
      "packages/protocol/src/control-plane.ts",
      "export const PromptRequestBody = z.strictObject({ content: z.array(x) })" +
        ".refine((b) => b.content.every((c) => c.type === 'text'));\n",
    );
    expect(auditPromptContentInjection([refined]).refineIsGone).toBe(false);

    // (4) `validateContent` passed, but NOT bound to either input — a closure that always says
    //     yes looks identical at the call site and is the gate's absence wearing its name.
    const unbound = sourceFile(
      "packages/daemon/src/registry.ts",
      "const deps = { validateContent: () => undefined };\nexport const x = deps;\n",
    );
    const report4 = auditPromptContentInjection([unbound]);
    expect(report4.creationPathInjects).toBe(true);
    expect(report4.boundToCwdRoots).toBe(false);
    expect(report4.boundToPromptCapabilities).toBe(false);

    // …and the shape the hunk must take, which the checker DOES accept.
    const wired = sourceFile(
      "packages/daemon/src/registry.ts",
      "const deps = {\n" +
        "  validateContent: (content: readonly unknown[]) =>\n" +
        "    assertPromptContent({ content, cwd, cwdRoots: auth.cwdRoots,\n" +
        "      promptCapabilities: built?.snapshot().capabilities?.promptCapabilities ?? null,\n" +
        "      realpath }).then(() => undefined),\n" +
        "};\nexport const x = deps;\n",
    );
    expect(auditPromptContentInjection([wired])).toMatchObject({
      creationPathInjects: true,
      boundToCwdRoots: true,
      boundToPromptCapabilities: true,
    });
  });
});
