import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "types", "id-discrimination.ts");

/**
 * WP-1 acceptance 4. `tsc -b` compiles `src` only, so a `@ts-expect-error` sitting in a test
 * file would never be checked by the build and would silently rot. Running the compiler over
 * one fixture is what turns "the ids discriminate" into an assertion.
 */
describe("template-literal ids discriminate at compile time", () => {
  it("type-checks the fixture with zero diagnostics", () => {
    const program = ts.createProgram([FIXTURE], {
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
          ? `${relative(HERE, d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}`
          : "<no file>";
      return `${where} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });

    expect(diagnostics).toEqual([]);
  });

  it("would fail if the ids stopped discriminating", () => {
    // The mechanism, asserted directly: an unnecessary directive is itself an error (TS2578),
    // so the assertion above cannot pass vacuously.
    const source = `const s: string = "x";\n// @ts-expect-error\nconst t: string = s;\n`;
    const host = ts.createCompilerHost({});
    const original = host.getSourceFile.bind(host);
    const virtual = join(HERE, "types", "__unused-directive.ts");
    host.getSourceFile = (name, ...rest) =>
      name === virtual
        ? ts.createSourceFile(name, source, ts.ScriptTarget.ES2022, true)
        : original(name, ...rest);
    host.fileExists = (name) => name === virtual || ts.sys.fileExists(name);
    host.readFile = (name) => (name === virtual ? source : ts.sys.readFile(name));

    // `noLib` keeps this to one tiny file: the directive check needs no standard library.
    const program = ts.createProgram(
      [virtual],
      { strict: true, noEmit: true, noLib: true, types: [] },
      host,
    );
    const codes = ts.getPreEmitDiagnostics(program).map((d) => d.code);
    expect(codes).toContain(2578); // "Unused '@ts-expect-error' directive."
  });
});
