/**
 * The one warning we are allowed to swallow, matched on BOTH halves: the type must be exactly
 * `ExperimentalWarning`, and the text must name SQLite as a word. Anything else — the agent's
 * warnings, a deprecation, another experimental builtin someone adds later — passes through.
 */
const SQLITE_TEXT = /\bSQLite\b/;

type EmitWarning = typeof process.emitWarning;

function isSqliteExperimental(args: readonly unknown[]): boolean {
  const [warning, second] = args;
  const text = warning instanceof Error ? warning.message : String(warning ?? "");
  const type =
    typeof second === "string"
      ? second
      : typeof second === "object" && second !== null
        ? String((second as { type?: unknown }).type ?? "")
        : warning instanceof Error
          ? warning.name
          : "";
  return type === "ExperimentalWarning" && SQLITE_TEXT.test(text);
}

/**
 * `node:sqlite` prints exactly ONE `ExperimentalWarning` at first import (F12). Suppressing it
 * with `--no-warnings` would silence every other warning in the user's process, and
 * `OmniACP.local()` runs inside somebody else's script.
 *
 * So the suppression is SURGICAL (§14.2): a `process.emitWarning` interposer that drops only the
 * one warning naming SQLite, for only the duration of the import, and passes everything else
 * through untouched. Both directions are tested — zero of ours, and an unrelated
 * `ExperimentalWarning` still gets out.
 *
 * `fn` may be async — `await import("node:sqlite")` is the only caller that matters, and the
 * module is evaluated after the first tick — so a thenable result holds the interposer until it
 * settles instead of restoring on the synchronous return and missing the warning entirely.
 *
 * The restore is conditional: if something else replaced `process.emitWarning` while we held it,
 * putting ours back would clobber a stranger's interposer, and this function's whole justification
 * is that it does not do that to anybody.
 *
 * Owned by M1-WP-A.
 */
export function withSuppressedSqliteWarning<T>(fn: () => T): T {
  const original = process.emitWarning;

  const interposer = ((...args: Parameters<EmitWarning>): void => {
    if (isSqliteExperimental(args)) return;
    (original as (...a: unknown[]) => void).apply(process, args);
  }) as EmitWarning;

  const restore = (): void => {
    if (process.emitWarning === interposer) process.emitWarning = original;
  };

  process.emitWarning = interposer;
  let settled = false;
  try {
    const out = fn();
    if (isThenable(out)) {
      settled = true;
      return out.then(
        (v: unknown) => {
          restore();
          return v;
        },
        (e: unknown) => {
          restore();
          throw e;
        },
      ) as T;
    }
    return out;
  } finally {
    if (!settled) restore();
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> & {
  then(onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown): unknown;
} {
  return (
    (typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function") ||
    (typeof v === "function" && typeof (v as { then?: unknown }).then === "function")
  );
}
