import { describe, expect, it } from "vitest";
import { blankOutNonCode, identifierHits, packageSources } from "./source-scan.js";

/**
 * The scanner every architecture guard is built on.
 *
 * These guards are the only thing standing between a contract clause and a silent regression,
 * so the scanner is held to one rule above all: when it cannot parse something, it must blank
 * LESS code, never more. Blanking more is how a guard goes quiet, and a quiet guard passes on
 * a tree that violates every clause it names.
 */

describe("blankOutNonCode", () => {
  it("keeps offsets and newlines so a hit maps back to a real line", () => {
    const source = 'const a = "hello";\nconst b = 1;\n';
    const code = blankOutNonCode(source);
    expect(code).toHaveLength(source.length);
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
    expect(code).toBe('const a = "     ";\nconst b = 1;\n');
  });

  it("blanks line comments, block comments and template literals", () => {
    expect(blankOutNonCode("a; // messageId\nb;")).toBe("a;             \nb;");
    expect(blankOutNonCode("a; /* messageId */ b;")).toBe("a;                 b;");
    expect(blankOutNonCode("const t = `a ${x} b`;")).toBe("const t = `        `;");
  });

  it("recognizes a regex literal, so a quote inside one opens no string", () => {
    // Before this, the `"` inside the character class opened a string literal that ran to the
    // end of the line — and `messageId` on the same line vanished from `code`.
    const source = 'const re = /^[^"]+$/; const messageId = 1;';
    const code = blankOutNonCode(source);
    expect(code).toBe("const re = /       /; const messageId = 1;");
    expect(code).toContain("messageId");
  });

  it("handles regex forms that look like division or comments", () => {
    // A `/` after an identifier or `)` is division and must not eat the rest of the line.
    expect(blankOutNonCode("const x = total / count; const y = 2;")).toBe(
      "const x = total / count; const y = 2;",
    );
    expect(blankOutNonCode("const x = (a + b) / 2; const y = 3;")).toBe(
      "const x = (a + b) / 2; const y = 3;",
    );
    // An escaped slash inside the literal does not terminate it.
    expect(blankOutNonCode("s.split(/a\\/b/); const k = 1;")).toBe("s.split(/    /); const k = 1;");
    // A class containing `/` does not terminate it either.
    expect(blankOutNonCode("const p = /[/'\"]/; const k = 1;")).toBe(
      "const p = /     /; const k = 1;",
    );
  });

  it("FAILS CLOSED on an unterminated quote: the rest of the LINE, and no more", () => {
    const source = "const bad = 'oops;\nconst messageId = 1;\n";
    const code = blankOutNonCode(source);
    expect(code).toBe("const bad = '     \nconst messageId = 1;\n");
    // The next line is still code: a scan-to-EOF would have blanked it and every guard
    // downstream would have passed by finding nothing.
    expect(code).toContain("messageId");
    expect(
      identifierHits({ path: "<planted>", absolute: "<planted>", text: source, code }, "messageId"),
    ).toEqual([2]);
  });

  it("still lets a template literal cross lines, which is the one that legally may", () => {
    const code = blankOutNonCode("const t = `line one\nline two`;\nconst messageId = 1;\n");
    expect(code).toBe("const t = `        \n        `;\nconst messageId = 1;\n");
  });

  it("does not blank an apostrophe inside a comment, because comments go first", () => {
    const code = blankOutNonCode("// don't read messageId\nconst ok = messageId;\n");
    expect(code.split("\n")[0]?.trim()).toBe("");
    expect(code).toContain("const ok = messageId;");
  });

  it("is exercised on the real tree: every package source parses to the same length", () => {
    const files = packageSources();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(`${file.path}: ${String(file.code.length)}`).toBe(
        `${file.path}: ${String(file.text.length)}`,
      );
      // Fail-closed means real code survives: every source file we ship imports or exports
      // something, and a scan-to-EOF bug would blank one of those keywords away.
      const survived = /\b(import|export|const|function)\b/.test(file.code);
      expect(`${file.path}: ${String(survived)}`).toBe(`${file.path}: true`);
    }
  });
});
