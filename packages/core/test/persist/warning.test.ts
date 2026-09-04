import { afterEach, describe, expect, it } from "vitest";
import { withSuppressedSqliteWarning } from "../../src/persist/warning.js";

type EmitArgs = readonly unknown[];

/**
 * A recorder in place of the real `process.emitWarning`, so these tests observe exactly what
 * would have escaped rather than racing the `'warning'` event.
 */
function record(): { calls: EmitArgs[]; restore(): void } {
  const original = process.emitWarning;
  const calls: EmitArgs[] = [];
  process.emitWarning = ((...args: unknown[]): void => {
    calls.push(args);
  }) as typeof process.emitWarning;
  return {
    calls,
    restore(): void {
      process.emitWarning = original;
    },
  };
}

describe("withSuppressedSqliteWarning — surgical, both directions (§14.2)", () => {
  let outer: { calls: EmitArgs[]; restore(): void } | null = null;

  afterEach(() => {
    outer?.restore();
    outer = null;
  });

  it("swallows node:sqlite's own ExperimentalWarning", () => {
    outer = record();
    withSuppressedSqliteWarning(() => {
      process.emitWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
    });
    expect(outer.calls).toEqual([]);
  });

  it("lets an UNRELATED ExperimentalWarning through — this is not --no-warnings", () => {
    outer = record();
    withSuppressedSqliteWarning(() => {
      process.emitWarning("Type stripping is an experimental feature", "ExperimentalWarning");
      process.emitWarning("The agent said something", "AgentWarning");
      // Names SQLite, but is not experimental: the match is on BOTH halves, so a real SQLite
      // deprecation still reaches the operator.
      process.emitWarning("SQLite will drop this API", "DeprecationWarning");
    });
    expect(outer.calls.map((c) => String(c[0]))).toEqual([
      "Type stripping is an experimental feature",
      "The agent said something",
      "SQLite will drop this API",
    ]);
  });

  it("matches an Error-shaped warning by name and message, both ways", () => {
    outer = record();
    withSuppressedSqliteWarning(() => {
      const ours = new Error("SQLite is an experimental feature and might change at any time");
      ours.name = "ExperimentalWarning";
      process.emitWarning(ours);

      const theirs = new Error("Something else entirely is experimental");
      theirs.name = "ExperimentalWarning";
      process.emitWarning(theirs);
    });
    expect(outer.calls.map((c) => (c[0] as Error).message)).toEqual([
      "Something else entirely is experimental",
    ]);
  });

  it("honours the options-object overload", () => {
    outer = record();
    withSuppressedSqliteWarning(() => {
      process.emitWarning("SQLite is an experimental feature", { type: "ExperimentalWarning" });
      process.emitWarning("something else", { type: "ExperimentalWarning" });
    });
    expect(outer.calls.map((c) => String(c[0]))).toEqual(["something else"]);
  });

  it("restores process.emitWarning on the way out, and on a throw", () => {
    outer = record();
    const installed = process.emitWarning;
    withSuppressedSqliteWarning(() => undefined);
    expect(process.emitWarning).toBe(installed);

    expect(() =>
      withSuppressedSqliteWarning(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(process.emitWarning).toBe(installed);
  });

  it("holds the interposer across an ASYNC body until it settles", async () => {
    outer = record();
    const installed = process.emitWarning;

    const done = withSuppressedSqliteWarning(async () => {
      // The real caller is `await import("node:sqlite")`, whose module evaluation — and whose
      // warning — happen after the first tick. A `finally` that restored on the synchronous
      // return would miss it entirely.
      await new Promise((r) => setTimeout(r, 5));
      process.emitWarning("SQLite is an experimental feature", "ExperimentalWarning");
      process.emitWarning("late but unrelated", "ExperimentalWarning");
      return "ok";
    });
    expect(process.emitWarning).not.toBe(installed);

    await expect(done).resolves.toBe("ok");
    expect(process.emitWarning).toBe(installed);
    expect(outer.calls.map((c) => String(c[0]))).toEqual(["late but unrelated"]);
  });

  it("restores after an async body REJECTS", async () => {
    outer = record();
    const installed = process.emitWarning;
    const done = withSuppressedSqliteWarning(async () => {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error("async boom");
    });
    await expect(done).rejects.toThrow("async boom");
    expect(process.emitWarning).toBe(installed);
  });

  it("does not clobber an interposer somebody else installed while ours was up", () => {
    outer = record();
    const theirs = ((): void => {}) as typeof process.emitWarning;
    withSuppressedSqliteWarning(() => {
      process.emitWarning = theirs;
    });
    // Ours is gone from the chain, but we do not put ours back over a stranger's — this whole
    // function's justification is that it does not do that to anybody.
    expect(process.emitWarning).toBe(theirs);
  });
});
