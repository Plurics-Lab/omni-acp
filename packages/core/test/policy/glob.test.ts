import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import { compileGlob, globHead } from "@omni-acp/core";
import { normalizeSeparators, withinRoot } from "../../src/policy/glob.js";

/**
 * The glob primitive, as a TABLE. It is the piece every other file in `policy/` leans on, and it
 * is the one with no dependency at all — no clock, no filesystem, no package (Land criterion 7).
 *
 * `withinRoot` is imported from `src/` rather than the barrel because it is an internal of the
 * ceiling's prefix test; `compileGlob` and `globHead` are the two §5.8.9 exports.
 *
 * Owned by M2-B-WP-P.
 */

const matches = (pattern: string, path: string): boolean => compileGlob(pattern)(path);

describe("compileGlob — the pattern language (§20.3)", () => {
  const rows: readonly [pattern: string, path: string, expected: boolean, why: string][] = [
    ["/repo/src/**", "/repo/src/main.ts", true, "** matches one segment"],
    ["/repo/src/**", "/repo/src/a/b/c.ts", true, "** crosses separators"],
    ["/repo/src/**", "/repo/src", true, "a directory glob names the directory itself"],
    ["/repo/src/**", "/repo/srcx/main.ts", false, "and never a sibling with a longer name"],
    ["/repo/src/**", "/repo/main.ts", false, "nor anything above it"],
    ["/repo/*.ts", "/repo/main.ts", true, "* matches within one segment"],
    ["/repo/*.ts", "/repo/a/main.ts", false, "* never crosses a separator"],
    ["/repo/**/*.ts", "/repo/main.ts", true, "**/ may match zero segments"],
    ["/repo/**/*.ts", "/repo/a/b/main.ts", true, "or many"],
    ["/repo/?.ts", "/repo/a.ts", true, "? is exactly one character"],
    ["/repo/?.ts", "/repo/ab.ts", false, "and not two"],
    ["/repo/[abc].ts", "/repo/b.ts", true, "a character class"],
    ["/repo/[!abc].ts", "/repo/b.ts", false, "a negated class"],
    ["/repo/[!abc].ts", "/repo/z.ts", true, "a negated class, the other way"],
    ["/repo/a.b", "/repo/axb", false, "a dot is a literal, not a wildcard"],
    ["/repo/a+b", "/repo/a+b", true, "and so is every regex metacharacter"],
    ["/repo/(x)", "/repo/(x)", true, "parentheses included"],
    ["/repo/src*/**", "/repo/src-secrets/keys.txt", true, "the ceiling's blind spot, spelled out"],
    ["/repo/src*/**", "/repo/other/keys.txt", false, "which is still not everything"],
  ];

  for (const [pattern, path, expected, why] of rows) {
    it(`${pattern} vs ${path} => ${String(expected)} (${why})`, () => {
      expect(matches(pattern, path)).toBe(expected);
    });
  }

  it("a RELATIVE pattern is a load error, not a matcher that silently matches nothing", () => {
    for (const bad of ["src/**", "./src/**", "main.ts"]) {
      expect(() => compileGlob(bad), bad).toThrowError(OmniError);
      try {
        compileGlob(bad);
      } catch (e) {
        expect(OmniError.is(e, "bad_request")).toBe(true);
        expect((e as OmniError).message).toContain(bad);
      }
    }
  });

  it("an empty pattern and an over-long one are both load errors", () => {
    expect(() => compileGlob("")).toThrowError(OmniError);
    expect(() => compileGlob(`/${"a".repeat(600)}`)).toThrowError(OmniError);
  });

  it("BOTH separator spellings compile and match, so one rule file works on three OSes", () => {
    // The Windows branch is exercised by DATA rather than skipped: a backslash pattern and a
    // backslash path are the same shape after normalization, and a drive letter is absolute.
    expect(compileGlob("C:/repo/src/**")("C:\\repo\\src\\main.ts")).toBe(true);
    expect(compileGlob("C:\\repo\\src\\**")("C:/repo/src/main.ts")).toBe(true);
    expect(compileGlob("//server/share/**")("//server/share/a.txt")).toBe(true);
    expect(compileGlob("C:/repo/src/**")("D:/repo/src/main.ts")).toBe(false);
  });

  it("case folding is DIRECTIONAL: a grant is harder to satisfy, a restriction easier (§20.3)", () => {
    // The rule's ACTION picks the flag; `compileGlob` is handed the decision, which is what lets
    // `matchRule` apply §20.3's last row without a second glob implementation.
    expect(compileGlob("/repo/src/**", { caseInsensitive: false })("/repo/SRC/main.ts")).toBe(
      false,
    );
    expect(compileGlob("/repo/src/**", { caseInsensitive: true })("/repo/SRC/main.ts")).toBe(true);
  });
});

describe("globHead — what makes pathRoots decidable (M2-R11)", () => {
  const rows: readonly [pattern: string, head: string][] = [
    ["/repo/src/**", "/repo/src/"],
    ["src/**", "src/"],
    ["src*/**", "src"],
    ["**", ""],
    ["**/*.ts", ""],
    ["/etc/passwd", "/etc/passwd"],
    ["/repo/[abc]/x", "/repo/"],
    ["/repo/a?c", "/repo/a"],
  ];
  for (const [pattern, head] of rows) {
    it(`head of ${pattern} is "${head}"`, () => {
      expect(globHead(pattern)).toBe(head);
    });
  }

  it("normalizes separators, so a Windows pattern has a comparable head", () => {
    expect(globHead("C:\\repo\\src\\**")).toBe("C:/repo/src/");
  });
});

describe("withinRoot — the prefix test, with the segment boundary that makes it correct", () => {
  const rows: readonly [head: string, root: string, expected: boolean][] = [
    ["src/", "src", true],
    ["src", "src", true],
    ["src/a/", "src", true],
    ["src-secrets", "src", false],
    ["srcx/", "src", false],
    ["", "src", false],
    ["/etc/", "src", false],
    ["anything", "", true],
  ];
  for (const [head, root, expected] of rows) {
    it(`"${head}" inside "${root}" => ${String(expected)}`, () => {
      expect(withinRoot(head, root)).toBe(expected);
    });
  }

  it("FAILS if the segment boundary is dropped — the classic prefix bug, demonstrated", () => {
    // The planted-violation half of the rule: a prefix test WITHOUT the separator says
    // `src-secrets` is inside `src`, which is exactly the escape `pathRoots` exists to stop.
    const naive = (head: string, root: string): boolean => head.startsWith(root);
    expect(naive("src-secrets", "src")).toBe(true);
    expect(withinRoot("src-secrets", "src")).toBe(false);
  });
});

describe("normalizeSeparators", () => {
  it("folds backslashes and drops a trailing separator, but never from a bare root", () => {
    expect(normalizeSeparators("a\\b\\c")).toBe("a/b/c");
    expect(normalizeSeparators("a/b/")).toBe("a/b");
    expect(normalizeSeparators("/")).toBe("/");
  });
});
