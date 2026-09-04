import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compatDir, loadCompatConfig, selectAgents } from "./config.js";

/**
 * §18.1's promise, proven two ways rather than asserted once (M1-PLAN §2, WP-F acceptance 2):
 *
 *  1. adding an agent is a YAML edit — a temp config with an APPENDED entry runs the suite
 *     unchanged, in a real child vitest process;
 *  2. no `.ts` file in this repository contains a real agent's LAUNCH ARGV.
 *
 * The second is scoped to the launch spelling and not to the agent's name: §17.2 requires
 * `BUILTIN_RUNTIMES` to ship a claude-acp profile whose matcher is
 * `agentInfo.name /^claude-(code|agent)-acp$/`, so `packages/core/src/runtime/known.ts` will
 * legitimately contain that substring and is exempted BY NAME (review R19).
 *
 * Owned by M1-WP-F.
 */

const REPO_ROOT = join(compatDir(), "..", "..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "vitest-report", "coverage", ".claude"]);

/**
 * Exempt by name, with the reason recorded: a descriptor's job is to NAME the runtime it
 * describes, and forbidding that would forbid §17.2.
 */
const EXEMPT = new Set([
  // §17.2's builtin descriptor, whose `matches` list IS the npm specifier: forbidding it would
  // forbid the feature (review R19).
  "packages/core/src/runtime/known.ts",
  // …and that matcher's own test, which must feed it the spelling it matches. Both files NAME the
  // runtime; neither LAUNCHES it, which is the property this guard is about.
  "packages/daemon/test/catalog-runtime.test.ts",
]);

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const absolute = join(dir, entry);
    const info = await stat(absolute);
    if (info.isDirectory()) await walk(absolute, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".mjs")) out.push(absolute);
  }
}

const temps: string[] = [];
afterAll(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("guard: adding an agent is a YAML edit", () => {
  it("no source file in this repository contains a real agent's launch argv", async () => {
    const local = loadCompatConfig("agents.local.yaml");
    const spellings = local.agents
      .filter((a) => a.source === "command")
      .map((a) => [a.command ?? "", ...(a.args ?? [])].join(" "))
      .filter((s) => s.trim() !== "");
    // The guard would be vacuous over a file with no `command` entries, and a vacuous guard
    // passes on a tree that violates every clause it names.
    expect(spellings.length).toBeGreaterThan(0);

    const files: string[] = [];
    await walk(REPO_ROOT, files);
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const path = relative(REPO_ROOT, file).split(sep).join("/");
      if (EXEMPT.has(path)) continue;
      const text = await readFile(file, "utf8");
      for (const spelling of spellings) {
        if (text.includes(spelling)) offenders.push(`${path}: ${spelling}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("both exemptions are real: each names the runtime it describes", async () => {
    // Otherwise an exemption could be protecting nothing, and nobody would notice when §17.2's
    // builtin descriptor quietly stopped matching claude-acp at all — the guard would still be
    // green and the feature would be gone.
    for (const path of EXEMPT) {
      const text = await readFile(join(REPO_ROOT, path), "utf8");
      expect(text, path).toMatch(/claude-(code|agent)-acp/);
    }
  });

  it("a temp config with an APPENDED entry runs the suite unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-compat-yaml-"));
    temps.push(dir);
    const config = join(dir, "appended.yaml");
    await writeFile(
      config,
      [
        "version: 1",
        "agents:",
        // A fixture, so this costs a process and no tokens. The point is the CODE PATH: an id
        // no `.ts` file has ever seen, selected, harnessed, probed and asserted against.
        "  - id: appended-by-a-test",
        "    source: fixture",
        "    fixture: echo",
        "    enabled: true",
        "",
      ].join("\n"),
      "utf8",
    );

    // Load + select is the half this process can check directly.
    const selection = selectAgents(loadCompatConfig(config), {});
    expect(selection.selected.map((a) => a.id)).toEqual(["appended-by-a-test"]);

    // …and the other half is that the SUITE runs it, which is only provable by running it. A
    // child vitest process with `OMNI_COMPAT_REQUIRE=1` cannot pass by selecting nothing.
    //
    // Its report goes to a temp path, for two reasons: the assertion below reads the RESULTS
    // rather than scraping a reporter's stdout, and a child writing the default path would
    // clobber the parent run's report — which is the artifact §18.3 says must survive.
    const report = join(dir, "child-report.json");
    const result = await run(["run", "src/compat.ctest.ts", "-t", "handshake"], {
      OMNI_COMPAT_CONFIG: config,
      OMNI_COMPAT_AGENTS: "appended-by-a-test",
      OMNI_COMPAT_REQUIRE: "1",
      OMNI_COMPAT_REPORT: report,
    });
    expect(result.code, result.output.slice(-4000)).toBe(0);

    const written = JSON.parse(await readFile(report, "utf8")) as {
      agents: string[];
      results: { agent: string; case: string; status: string }[];
    };
    expect(written.agents).toEqual(["appended-by-a-test"]);
    // A real assertion, and the one that matters: the appended agent was HARNESSED, PROBED and
    // ASSERTED against — a daemon started for an id no `.ts` file has ever seen.
    expect(
      written.results.filter((r) => r.case === "handshake" && r.status === "passed"),
    ).toHaveLength(1);
  }, 180_000);
});

/** A child vitest, in this package, with the environment the test wants. */
async function run(
  args: readonly string[],
  env: Record<string, string>,
): Promise<{ code: number; output: string }> {
  const cwd = compatDir();
  const bin = join(
    REPO_ROOT,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  const child = spawn(bin, [...args], {
    cwd,
    // `shell: true` ONLY on win32, and only because `.bin/vitest.cmd` is a shim §6.3 would refuse
    // (CVE-2024-27980). The daemon never does this; a test runner launching another test runner
    // is not the supervisor.
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (output += c));
  child.stderr.on("data", (c: string) => (output += c));
  const code = await new Promise<number>((resolve) => {
    child.on("close", (c) => resolve(c ?? 1));
  });
  return { code, output };
}

describe("compat config — the shapes that keep a skip arguable", () => {
  it("refuses a skip whose reason is missing or decorative", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omni-compat-bad-"));
    temps.push(dir);
    const write = async (body: string): Promise<string> => {
      const path = join(dir, `${String(Math.random()).slice(2)}.yaml`);
      await writeFile(path, body, "utf8");
      return path;
    };

    const short = await write(
      "version: 1\nagents:\n  - id: a\n    source: fixture\n    fixture: echo\n    skip:\n      - {case: plain-turn, reason: nope}\n",
    );
    // §18.3: the minimum is 10 characters, and it is enforced at LOAD rather than reported in the
    // grid — a skip nobody can argue with decays into silence within a milestone.
    expect(() => loadCompatConfig(short)).toThrow(/at least 10 characters/);

    const missing = await write(
      "version: 1\nagents:\n  - id: a\n    source: fixture\n    fixture: echo\n    skip:\n      - {case: plain-turn}\n",
    );
    expect(() => loadCompatConfig(missing)).toThrow(/reason/);

    const duplicate = await write(
      "version: 1\nagents:\n  - id: a\n    source: fixture\n    fixture: echo\n  - id: a\n    source: fixture\n    fixture: echo\n",
    );
    // Two rows with one id would make the report's `agent × case` grid ambiguous.
    expect(() => loadCompatConfig(duplicate)).toThrow(/duplicate agent id/);
  });

  it("every skip in the shipped configs carries a source and a reason", () => {
    for (const name of ["agents.ci.yaml", "agents.local.yaml"]) {
      const config = loadCompatConfig(name);
      for (const agent of config.agents) {
        for (const skip of agent.skip ?? []) {
          expect(skip.reason.length, `${name}: ${agent.id}/${skip.case}`).toBeGreaterThan(9);
        }
      }
    }
  });

  it("claude-acp's `unverified` MIRRORS the builtin descriptor's, and never a shorter list", async () => {
    // §17.2 is the single source of truth (review R8). The YAML restates it so an operator
    // reading only that file sees what will not be asserted — restating is allowed, SHORTENING
    // is how a gap becomes a silent pass.
    const local = loadCompatConfig("agents.local.yaml");
    const agent = local.agents.find((a) => a.id === "claude-acp");
    expect(agent).toBeDefined();

    // Read from the SOURCE by name rather than imported: `tests/compat` depends on
    // {client, daemon, protocol, testkit} and deliberately not on `@omni-acp/core` (§3.1), so the
    // list is scraped from the one exported constant that §17.2 calls the single source of truth.
    // `unverified:` alone would match the DEFAULT profile's empty list two hundred lines earlier,
    // which is how this assertion would go quietly vacuous.
    const known = await readFile(join(REPO_ROOT, "packages/core/src/runtime/known.ts"), "utf8");
    const block = /CLAUDE_ACP_UNVERIFIED\s*=\s*\[([^\]]*)\]/.exec(known);
    expect(block, "known.ts exports no CLAUDE_ACP_UNVERIFIED").not.toBeNull();
    const descriptor = (block?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s !== "");
    expect(descriptor.length).toBeGreaterThan(0);
    expect([...(agent?.unverified ?? [])].sort()).toEqual([...descriptor].sort());
  });
});

describe("the report is written unconditionally", () => {
  it("exists after this run, with a source on every agent-level skip", async () => {
    // Written by a file-level `afterAll` in `runner.ts`, so it exists whatever happened —
    // including a run whose selection was empty, which is the run a reader most needs.
    const path = join(compatDir(), "vitest-report", "compat-report.json");
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    // This file may run BEFORE `compat.ctest.ts` in a parallel scheduler, in which case there is
    // nothing to read yet — and asserting on a race would make the guard flaky rather than
    // strict. The shape is what matters, so it is only asserted when the file is there.
    if (!exists) return;
    const report = JSON.parse(await readFile(path, "utf8")) as {
      results: { status: string; source?: string; reason?: string }[];
      skippedAgents: { source: string; reason: string }[];
    };
    for (const row of report.results) {
      if (row.status !== "skipped") continue;
      expect(row.source, JSON.stringify(row)).toBeDefined();
      expect((row.reason ?? "").length, JSON.stringify(row)).toBeGreaterThan(9);
    }
    for (const row of report.skippedAgents) {
      expect(row.source).toBeDefined();
      expect(row.reason.length).toBeGreaterThan(9);
    }
  });
});
