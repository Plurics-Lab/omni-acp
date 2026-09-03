import type { Logger } from "@omni-acp/protocol";

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

/**
 * Structured JSON lines on stderr. A bearer token must never reach a log line
 * (CONTRACTS.md §2.1 H13), so this is also where redaction lives.
 *
 * Redaction is by KEY and by SHAPE, and both are needed: a field called `token` is redacted
 * whatever it holds, and any string carrying an `Authorization: Bearer …` header value is
 * rewritten wherever it appears — including inside a message that some caller built by
 * interpolation. Fields are redacted, never dropped, so a log line still says that a secret was
 * present at that point.
 */
const LEVEL_ORDER: { readonly [L in LogLevel]: number } = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const SECRET_KEY =
  /^(authorization|auth|token|secret|secret_?sha256|bearer|api_?key|password|pass|credential|cookie|set-cookie)$/i;

/** `Bearer <secret>` in any casing, plus the raw header form. Replaced, never truncated. */
const BEARER = /\b(bearer)\s+[\w~+/=._-]+/gi;

const REDACTED = "[redacted]";

function redactString(value: string): string {
  return value.replace(BEARER, "$1 [redacted]");
}

/**
 * Depth-bounded: a log field is diagnostics, not a heap dump, and an unbounded walk over a
 * caller-supplied object is how a logger becomes the slowest thing in a request.
 */
function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(v, depth + 1);
  }
  return out;
}

function redactFields(fields: Record<string, unknown>): Record<string, unknown> {
  return redactValue(fields, 0) as Record<string, unknown>;
}

/**
 * `write` is injectable so the redaction rules can be asserted without capturing the process's
 * stderr — the assertion "this token never appears in a log line" is only worth having if a test
 * can read every line that was written.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => {
    process.stderr.write(line);
  },
): Logger {
  const threshold = LEVEL_ORDER[level];

  const make = (bindings: Record<string, unknown>): Logger => {
    const emit = (
      lvl: Exclude<LogLevel, "silent">,
      msg: string,
      fields?: Record<string, unknown>,
    ): void => {
      if (threshold < LEVEL_ORDER[lvl]) return;
      const line = {
        level: lvl,
        time: new Date().toISOString(),
        msg: redactString(msg),
        ...bindings,
        ...(fields === undefined ? {} : redactFields(fields)),
      };
      try {
        write(`${JSON.stringify(line)}\n`);
      } catch {
        // A logger that throws takes the request down with it. A field that will not serialize
        // (a cycle, a BigInt) is a bug in the CALLER, and losing that one line is the cheapest
        // possible consequence.
      }
    };

    return {
      child: (extra) => make({ ...bindings, ...redactFields(extra) }),
      debug: (msg, fields) => {
        emit("debug", msg, fields);
      },
      info: (msg, fields) => {
        emit("info", msg, fields);
      },
      warn: (msg, fields) => {
        emit("warn", msg, fields);
      },
      error: (msg, fields) => {
        emit("error", msg, fields);
      },
    };
  };

  return make({});
}
