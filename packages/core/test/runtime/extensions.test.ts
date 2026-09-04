import { describe, expect, it } from "vitest";
import { readExtension, readPointer } from "../../src/runtime/extensions.js";
import { BUILTIN_RUNTIMES } from "../../src/runtime/known.js";

const CLAUDE = BUILTIN_RUNTIMES[0]!.descriptor;

describe("readPointer — RFC-6901, and nothing more", () => {
  const doc = {
    claudeCode: { toolResponse: { structuredPatch: [{ oldStart: 1 }] } },
    "_claude/rateLimit": { status: "allowed" },
    "a~b": 1,
    list: ["zero", "one"],
    nulled: null,
  };

  it("the empty pointer is the whole document", () => {
    expect(readPointer(doc, "")).toBe(doc);
  });

  it("walks nested objects", () => {
    expect(readPointer(doc, "/claudeCode/toolResponse/structuredPatch/0/oldStart")).toBe(1);
  });

  it("`~1` is a literal slash inside a key — the whole reason the escape exists", () => {
    expect(readPointer(doc, "/_claude~1rateLimit")).toEqual({ status: "allowed" });
  });

  it("`~0` is a literal tilde", () => {
    expect(readPointer(doc, "/a~0b")).toBe(1);
  });

  it("unescapes `~1` BEFORE `~0`, so `~01` is `~1` and not a slash", () => {
    expect(readPointer({ "~1": "tilde-one" }, "/~01")).toBe("tilde-one");
  });

  it("indexes an array with a decimal index, and refuses a leading zero or `-`", () => {
    expect(readPointer(doc, "/list/1")).toBe("one");
    expect(readPointer(doc, "/list/01")).toBeUndefined();
    expect(readPointer(doc, "/list/-")).toBeUndefined();
    expect(readPointer(doc, "/list/2")).toBeUndefined();
  });

  it("returns undefined for a pointer that does not resolve — a missing vendor field is NORMAL", () => {
    expect(readPointer(doc, "/nope")).toBeUndefined();
    expect(readPointer(doc, "/claudeCode/nope/deeper")).toBeUndefined();
    expect(readPointer(undefined, "/anything")).toBeUndefined();
    expect(readPointer(null, "/anything")).toBeUndefined();
  });

  it("distinguishes a key whose VALUE is null from a key that is absent", () => {
    expect(readPointer(doc, "/nulled")).toBeNull();
    expect(readPointer(doc, "/absent")).toBeUndefined();
  });

  it("refuses a pointer that does not start with `/` (RFC-6901 requires it)", () => {
    expect(readPointer(doc, "claudeCode")).toBeUndefined();
  });

  it("never reads something off Object.prototype", () => {
    expect(readPointer({}, "/constructor")).toBeUndefined();
    expect(readPointer({}, "/__proto__")).toBeUndefined();
    expect(readPointer({}, "/toString")).toBeUndefined();
  });
});

describe("readExtension — the descriptor's registered vendor slots (§17.3)", () => {
  it("promotes claudeCode.toolResponse out of `_meta` for the patch dialect (corpus 10)", () => {
    const meta = { claudeCode: { toolResponse: { structuredPatch: [] } } };
    expect(readExtension(meta, CLAUDE.extensions["patch"]!)).toEqual({ structuredPatch: [] });
  });

  it("promotes `_claude/rateLimit`, whose key contains the slash `~1` escapes", () => {
    const meta = {
      "_claude/rateLimit": { status: "allowed", unifiedRateLimitFallbackAvailable: false },
    };
    expect(readExtension(meta, CLAUDE.extensions["rateLimit"]!)).toEqual({
      status: "allowed",
      unifiedRateLimitFallbackAvailable: false,
    });
  });

  it("an update with no `_meta` at all is undefined, not an error", () => {
    expect(readExtension(undefined, CLAUDE.extensions["patch"]!)).toBeUndefined();
  });
});
