import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLIENT_ROOT,
  clientSources,
  staticImportsOf,
  stripComments,
} from "./support/import-scan.js";

const DAEMON = "@omni-acp/daemon";

/**
 * Architecture guard: `client-has-no-daemon-import` (CONTRACTS.md §10.2, D14).
 *
 * `@omni-acp/client` must be installable into a browser bundle or a lambda without dragging an
 * HTTP server, a supervisor and `node:child_process` along. That is a property of the MODULE
 * GRAPH, so it is checked on imports — and, in the second half of this file, on a real import of
 * the built package from a directory where the daemon genuinely is not present.
 */
describe("guard: client-has-no-daemon-import", () => {
  it("finds no static import of @omni-acp/daemon anywhere in packages/client/src", () => {
    const violations = clientSources().flatMap((file) =>
      staticImportsOf(file.text, DAEMON).map((line) => `${file.path}:${String(line)}`),
    );
    expect(violations).toEqual([]);
  });

  it("still sees the dynamic import that local() depends on, so the scan is not vacuous", () => {
    // A guard that passes because it scans nothing is worse than no guard. This asserts the
    // scanner is looking at a file that really does name the module.
    const local = clientSources().find((f) => f.path.endsWith("src/local.ts"));
    expect(local).toBeDefined();
    expect(local?.text).toContain(`import("${DAEMON}")`);
  });

  it("fires on a planted static import and stays quiet on prose", () => {
    // Demonstrated failing on a planted violation, which is what separates a guard from a
    // comment (CONTRACTS.md §11.3).
    expect(staticImportsOf(`import { createDaemon } from "${DAEMON}";\n`, DAEMON)).toEqual([1]);
    expect(staticImportsOf(`export { createDaemon } from "${DAEMON}";\n`, DAEMON)).toEqual([1]);
    expect(staticImportsOf(`import "${DAEMON}";\n`, DAEMON)).toEqual([1]);
    expect(staticImportsOf(`const d = require("${DAEMON}");\n`, DAEMON)).toEqual([1]);
    expect(staticImportsOf(`import {\n  createDaemon,\n} from "${DAEMON}";\n`, DAEMON)).toEqual([
      3,
    ]);

    // Legal: the dynamic import, and the module name in prose.
    expect(staticImportsOf(`await import("${DAEMON}");\n`, DAEMON)).toEqual([]);
    expect(staticImportsOf(`const m = await import(\n  "${DAEMON}",\n);\n`, DAEMON)).toEqual([]);
    expect(staticImportsOf(`// run \`npm i ${DAEMON}\` first\n`, DAEMON)).toEqual([]);
    expect(staticImportsOf(`/** peer: "${DAEMON}" */\n`, DAEMON)).toEqual([]);
  });

  it("fails closed: an unterminated quote blanks its line and no more", () => {
    // A scan-to-EOF would blank the planted import below and the guard would go quiet on
    // exactly the tree it exists to catch.
    const source = `const bad = 'oops;\nimport x from "${DAEMON}";\n`;
    expect(stripComments(source)).toContain(DAEMON);
    expect(staticImportsOf(source, DAEMON)).toEqual([2]);
  });

  it("does not let a quote inside a regex literal open a string", () => {
    const source = `const re = /^[^"]+$/;\nimport x from "${DAEMON}";\n`;
    expect(staticImportsOf(source, DAEMON)).toEqual([2]);
  });
});

/**
 * WP-6 acceptance 7, second half.
 *
 * The absence is SYNTHESIZED, not arranged in the tree: `packages/client` keeps
 * `@omni-acp/daemon` as a devDependency (the dependency freeze, M0-PLAN §1.2), so pnpm always
 * links it there and no amount of test setup inside the workspace can make it missing. So the
 * built `dist` is copied to a scratch directory that has `@omni-acp/protocol` and nothing else,
 * and imported from there (review R3).
 */
describe("local() without the optional peer installed", () => {
  it("throws a message naming `npm i @omni-acp/daemon`, not a module-not-found stack", async () => {
    const dist = join(CLIENT_ROOT, "dist");
    // Tests run against the built dist (D25); a missing one is a broken build, not a skip.
    expect(
      existsSync(join(dist, "index.js")),
      "packages/client/dist is missing — run `pnpm -r build` first (CONTRACTS.md §11 D25)",
    ).toBe(true);

    const scratch = await mkdtemp(join(tmpdir(), "omni-acp-no-daemon-"));
    try {
      await writeFile(
        join(scratch, "package.json"),
        JSON.stringify({ name: "no-daemon-probe", private: true, type: "module" }),
      );
      // No `.map` files, and no `sourceMappingURL` pointing at one: their `sources` name
      // `packages/client/src`, which does not exist here, and every loader in the chain then
      // logs about it. The probe is about resolution, not about source maps.
      const copied = join(scratch, "client");
      await cp(dist, copied, { recursive: true, filter: (s) => !s.endsWith(".map") });
      for (const entry of await readdir(copied)) {
        if (!entry.endsWith(".js")) continue;
        const file = join(copied, entry);
        const text = await readFile(file, "utf8");
        await writeFile(file, text.replace(/^\/\/# sourceMappingURL=.*$/gm, ""));
      }

      // A one-line re-export shim, so `@omni-acp/protocol` resolves to the REAL built module
      // (and therefore to its own zod and SDK) without copying a dependency tree. Absolute
      // `file:` URL rather than a symlink: junctions need privileges on Windows.
      const shim = join(scratch, "node_modules", "@omni-acp", "protocol");
      await mkdir(shim, { recursive: true });
      await writeFile(
        join(shim, "package.json"),
        JSON.stringify({
          name: "@omni-acp/protocol",
          version: "0.0.0",
          type: "module",
          exports: { ".": "./index.js" },
        }),
      );
      await writeFile(
        join(shim, "index.js"),
        `export * from ${JSON.stringify(
          pathToFileURL(join(CLIENT_ROOT, "..", "protocol", "dist", "index.js")).href,
        )};\n`,
      );

      // No `@omni-acp/daemon` anywhere above this directory.
      const probe = (await import(
        pathToFileURL(join(scratch, "client", "index.js")).href
      )) as typeof import("@omni-acp/client");

      const failure = await probe.OmniACP.local().then(
        () => null,
        (e: unknown) => e,
      );

      expect(failure).not.toBeNull();
      const message = (failure as { message?: string }).message ?? "";
      expect(message).toMatch(/npm i @omni-acp\/daemon/);
      // Not the resolver's own words: a stack that names an algorithm instead of the fix.
      expect(message).not.toMatch(/Cannot find package/);
      expect((failure as { code?: string }).code).toBe("bad_request");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});
