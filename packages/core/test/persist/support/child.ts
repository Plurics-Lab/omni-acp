import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The BUILT barrel, addressed by path rather than by package name.
 *
 * The child runs outside the workspace (its script lives under `mkdtemp`), so `@omni-acp/core`
 * is not resolvable from there — and loading `dist` is the more faithful test anyway: it is
 * exactly the module graph an embedder's `import { OmniACP } from "@omni-acp/client"` pulls in,
 * which is whose process §14.2 is protecting.
 */
export function coreDistUrl(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return pathToFileURL(join(here, "..", "..", "..", "dist", "index.js")).href;
}

export interface ChildWarning {
  readonly name: string;
  readonly message: string;
}

export interface ChildRun {
  readonly warnings: readonly ChildWarning[];
  readonly result: unknown;
  readonly stderr: string;
}

/**
 * Runs `body` in a FRESH node process and reports every warning it emitted.
 *
 * A fresh process is not a stylistic choice: `node:sqlite`'s `ExperimentalWarning` fires exactly
 * once, at first import, for the life of a process — so "zero warnings" is only a statement
 * about `driver:"memory"` if nothing else in the run has already loaded the module. In-process
 * this test would pass for the wrong reason on any file that ran after a SQLite test.
 *
 * `body` is the source of an async function taking `(core, ctx)`; whatever it returns is JSON'd
 * back to the caller.
 */
export async function runInFreshNode(body: string): Promise<ChildRun> {
  const dir = await mkdtemp(join(tmpdir(), "omni-acp-child-"));
  const script = join(dir, "probe.mjs");
  await writeFile(
    script,
    `
const warnings = [];
process.on("warning", (w) => warnings.push({ name: String(w.name), message: String(w.message) }));

const core = await import(${JSON.stringify(coreDistUrl())});
const ctx = { dir: ${JSON.stringify(dir)} };

const body = async (core, ctx) => {
${body}
};

let result = null;
try {
  result = await body(core, ctx);
} catch (e) {
  result = { error: e instanceof Error ? e.message : String(e) };
}

// 'warning' is emitted on the next tick, so a synchronous print would race the very thing this
// harness exists to observe.
await new Promise((r) => setTimeout(r, 100));
process.stdout.write("<<<" + JSON.stringify({ warnings, result }) + ">>>");
`,
    "utf8",
  );

  try {
    const { stdout, stderr } = await run(process.execPath, [script], {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const start = stdout.indexOf("<<<");
    const end = stdout.lastIndexOf(">>>");
    if (start === -1 || end === -1) {
      throw new Error(`child produced no report:\n${stdout}\n${stderr}`);
    }
    const parsed = JSON.parse(stdout.slice(start + 3, end)) as {
      warnings: ChildWarning[];
      result: unknown;
    };
    return { warnings: parsed.warnings, result: parsed.result, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const experimentalWarnings = (r: ChildRun): readonly ChildWarning[] =>
  r.warnings.filter((w) => w.name === "ExperimentalWarning");

export const sqliteWarnings = (r: ChildRun): readonly ChildWarning[] =>
  experimentalWarnings(r).filter((w) => /\bSQLite\b/.test(w.message));
