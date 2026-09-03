import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel } from "../src/logger.js";

const SECRET = "s3cr3t-bearer-value-01234567890";

function capture(level: LogLevel): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return {
    lines,
    logger: createLogger(level, (line) => {
      lines.push(line);
    }),
  };
}

describe("createLogger", () => {
  it("writes one JSON object per line, newline-terminated", () => {
    const { lines, logger } = capture("info");
    logger.info("hello", { workerId: "w_1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed["level"]).toBe("info");
    expect(parsed["msg"]).toBe("hello");
    expect(parsed["workerId"]).toBe("w_1");
    expect(typeof parsed["time"]).toBe("string");
  });

  it("filters by level, and `silent` writes nothing at all", () => {
    const { lines, logger } = capture("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual(["warn", "error"]);

    const quiet = capture("silent");
    quiet.logger.error("nope");
    expect(quiet.lines).toEqual([]);
  });

  it("carries child bindings and merges per-call fields over them", () => {
    const { lines, logger } = capture("debug");
    logger.child({ mod: "registry", workerId: "w_1" }).child({ workerId: "w_2" }).debug("x", {
      turnId: "t_1",
    });
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      mod: "registry",
      workerId: "w_2",
      turnId: "t_1",
    });
  });

  it("NEVER lets a bearer token reach a log line (H13)", () => {
    const { lines, logger } = capture("debug");
    logger.info(`auth failed for Bearer ${SECRET}`, {
      authorization: `Bearer ${SECRET}`,
      token: SECRET,
      secret: SECRET,
      nested: { apiKey: SECRET, headers: { Authorization: `bearer ${SECRET}` } },
      list: [`Bearer ${SECRET}`],
    });
    logger.child({ token: SECRET }).warn("child binding");

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).not.toContain(SECRET);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    // Redacted, not dropped: the line still says a secret was present here.
    expect(parsed["token"]).toBe("[redacted]");
    expect(parsed["msg"]).toBe("auth failed for Bearer [redacted]");
  });

  it("truncates a cycle at the depth bound rather than following it forever", () => {
    const { lines, logger } = capture("info");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => logger.info("cycle", { cyclic })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[depth]");
  });

  it("drops a line it cannot serialize instead of taking the request down", () => {
    const { lines, logger } = capture("info");
    // A BigInt makes JSON.stringify throw — a bug in the CALLER, and losing this one line is
    // the cheapest possible consequence.
    expect(() => logger.info("bigint", { size: 1n })).not.toThrow();
    expect(lines).toEqual([]);
  });

  it("bounds how deep it walks a caller-supplied object", () => {
    const { lines, logger } = capture("info");
    logger.info("deep", { a: { b: { c: { d: { e: SECRET } } } } });
    expect(lines[0]).not.toContain(SECRET);
    expect(lines[0]).toContain("[depth]");
  });
});
