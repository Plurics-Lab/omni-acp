import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { CreateRunRequest, CreateWorkerRequest } from "@omni-acp/protocol";
import {
  blankOutNonCode,
  identifierHits,
  locate,
  packageSources,
  sourceFile,
  type SourceFile,
} from "./scan.js";

/**
 * Architecture guard: `client-never-sends-a-command` (CONTRACTS.md §23.1, §27.4).
 *
 * Two halves, and §27.4 requires BOTH: `CreateWorkerRequest["mcp"]` and `CreateRunRequest["mcp"]`
 * are `string[]` at the TYPE level, and no route ever constructs an `McpServerPreset` from a
 * request body. Each half is demonstrated FAILING on a planted violation, per §10.2's rule.
 *
 * Owned by M2-B-WP-S.
 */

// ── the structural half, as a function so it can be run over planted sources ────────────────
//
// `packages/protocol/src/**` DECLARES every type in the system and re-exports most of them
// across the seam, so it necessarily names `McpServerPreset` and `CreateWorkerRequest` in one
// file. A declaration cannot construct anything, so those files are exempt from the
// preset-meets-a-body check below and subject only to the type-level rule, which is the fixture's
// job rather than the scanner's.
const DECLARES = (path: string): boolean => path.startsWith("packages/protocol/src/");

// The modules that RESOLVE a preset: the only three allowed to name the type outside protocol.
// Everything else in the repository must not know it exists, because knowing it is the first
// step to building one.
const RESOLVES = new Set([
  "packages/core/src/mcp/presets.ts", // reads it from `ResolvedDaemonConfig`
  "packages/core/src/mcp/capabilities.ts", // maps a resolved one onto the wire
  "packages/daemon/src/mcp.ts", // the daemon façade over the two above
]);

/**
 * The identifiers a request BODY arrives under. A module that names `McpServerPreset` and also
 * names one of these is a module where a preset and a body meet, which is the shape §23.1
 * forbids — the type is the control, and a route that reached around it would look exactly like
 * this.
 */
const BODY_IDENTIFIERS = ["body", "CreateWorkerRequest", "CreateRunRequest", "PromptRequestBody"];

/** Any module that constructs an MCP transport field at all, wherever the value came from. */
const TRANSPORT_FIELDS = ["command", "mcpServers"];

export interface Violation {
  readonly rule: string;
  readonly where: string;
}

export function auditClientNeverSendsACommand(sources: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];

  for (const file of sources) {
    const namesType = identifierHits(file, "McpServerPreset");
    if (namesType.length > 0 && DECLARES(file.path)) continue;

    // (a) The type is named where it is not allowed to be.
    if (namesType.length > 0 && !RESOLVES.has(file.path)) {
      out.push({ rule: "names-McpServerPreset", where: locate(file, namesType[0] as number) });
    }

    // (b) A module that RESOLVES a preset also knows a request body.
    if (namesType.length > 0) {
      for (const identifier of BODY_IDENTIFIERS) {
        const hits = identifierHits(file, identifier);
        if (hits.length > 0) {
          out.push({
            rule: `preset-meets-${identifier}`,
            where: locate(file, hits[0] as number),
          });
        }
      }
    }

    // (c) An HTTP route names a transport field. Routes are "parse -> ONE call -> serialize",
    //     and an MCP command has no business appearing in one under any spelling.
    if (file.path.startsWith("packages/daemon/src/http/")) {
      for (const field of TRANSPORT_FIELDS) {
        const hits = identifierHits(file, field);
        if (hits.length > 0) {
          out.push({ rule: `route-names-${field}`, where: locate(file, hits[0] as number) });
        }
      }
    }
  }

  return out;
}

describe("guard: client-never-sends-a-command — the TYPE half (§23.1)", () => {
  it("type-checks the fixture with ZERO diagnostics", () => {
    const fixture = join(
      dirname(fileURLToPath(import.meta.url)),
      "types",
      "client-never-sends-a-command.ts",
    );
    const program = ts.createProgram([fixture], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => {
      const where =
        d.file && d.start !== undefined
          ? `${d.file.fileName}:${String(d.file.getLineAndCharacterOfPosition(d.start).line + 1)}`
          : "<no file>";
      return `${where} TS${String(d.code)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
    expect(diagnostics).toEqual([]);
    // A generous budget, not a hidden retry: `ts.createProgram` reads the whole `protocol`
    // declaration graph, which is seconds on a loaded runner and would otherwise trip the
    // package's 5 s default.
  }, 60_000);

  it("fails on a PLANTED violation: a widened `mcp` that would accept a command", () => {
    // The fixture's `@ts-expect-error` lines are what carry the type half, so the way to
    // demonstrate the guard failing is to compile a fixture in which the forbidden assignment
    // COMPILES — the unused-directive error is the guard firing.
    const planted = join(
      dirname(fileURLToPath(import.meta.url)),
      "types",
      "planted-widened-mcp.ts",
    );
    const program = ts.createProgram([planted], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    const codes = ts.getPreEmitDiagnostics(program).map((d) => d.code);
    // TS2578: "Unused '@ts-expect-error' directive."
    expect(codes).toContain(2578);
  }, 60_000);

  it("refuses a command-shaped `mcp` entry AT RUNTIME too, on both request schemas", () => {
    for (const schema of [CreateWorkerRequest, CreateRunRequest]) {
      const base = {
        agent: "a",
        cwd: "/w",
        ...(schema === CreateRunRequest ? { prompt: [] } : {}),
      };
      expect(schema.safeParse({ ...base, mcp: [{ command: "sh" }] }).success).toBe(false);
      expect(schema.safeParse({ ...base, mcp: [{ type: "http", url: "u" }] }).success).toBe(false);
    }
    expect(CreateWorkerRequest.safeParse({ agent: "a", cwd: "/w", mcp: ["files"] }).success).toBe(
      true,
    );
  });
});

describe("guard: client-never-sends-a-command — the STRUCTURAL half (§23.1)", () => {
  const sources = packageSources();

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map((s) => s.path)).toContain("packages/daemon/src/mcp.ts");
    expect(sources.map((s) => s.path)).toContain("packages/daemon/src/http/routes/workers.ts");
  });

  it("no route constructs an McpServerPreset from a request body", () => {
    expect(auditClientNeverSendsACommand(sources)).toEqual([]);
  });

  it("fails on a PLANTED violation, in each of its three shapes", () => {
    const planted = (path: string, text: string): SourceFile => sourceFile(path, text);

    // (a) a module that has no business knowing the type
    expect(
      auditClientNeverSendsACommand([
        planted(
          "packages/daemon/src/http/routes/mcp.ts",
          "import type { McpServerPreset } from '@omni-acp/protocol';\nexport const x = 1;\n",
        ),
      ]).map((v) => v.rule),
    ).toContain("names-McpServerPreset");

    // (b) a preset built FROM A BODY, inside a module that is allowed to know the type
    expect(
      auditClientNeverSendsACommand([
        planted(
          "packages/daemon/src/mcp.ts",
          "import type { McpServerPreset } from '@omni-acp/protocol';\n" +
            "export const of = (body: { command: string }): McpServerPreset =>\n" +
            "  ({ type: 'stdio', command: body.command, args: [], headers: {}, env: {} });\n",
        ),
      ]).map((v) => v.rule),
    ).toContain("preset-meets-body");

    // (c) a route that names a transport field under any spelling
    expect(
      auditClientNeverSendsACommand([
        planted(
          "packages/daemon/src/http/routes/workers.ts",
          "export const route = (b: { command: string }) => ({ command: b.command });\n",
        ),
      ]).map((v) => v.rule),
    ).toContain("route-names-command");
  });

  it("does not fire on PROSE — the word `command` in a comment is not a call site", () => {
    const proseOnly = sourceFile(
      "packages/daemon/src/http/routes/workers.ts",
      "// a client can never put a command on this wire, and `mcpServers` is config-only\n" +
        "/* command command command */\nexport const route = () => 1;\n",
    );
    expect(auditClientNeverSendsACommand([proseOnly])).toEqual([]);
  });

  it("the scanner FAILS CLOSED on a stray quote rather than going quiet", () => {
    // A guard that stopped finding anything because one apostrophe blanked the rest of the file
    // is the one failure mode a guard may not have. An unterminated quote swallows its LINE.
    const blanked = blankOutNonCode("const a = 'oops\nconst command = body.command;\n");
    expect(blanked).toContain("command");
    expect(blanked.split("\n")).toHaveLength(3);
  });

  it("preserves offsets and line breaks, so a reported line number is a real one", () => {
    const text = "// c\nconst k = 'v';\nconst command = 1;\n";
    const file = sourceFile("packages/daemon/src/http/routes/x.ts", text);
    expect(file.code).toHaveLength(text.length);
    expect(identifierHits(file, "command")).toEqual([3]);
    expect(identifierHits(file, "v")).toEqual([]); // the string CONTENT is blanked
  });
});
