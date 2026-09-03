import type { IdGen, Logger } from "@omni-acp/protocol";

/** 26 digits, so the body still satisfies ULID_BODY and `ID_PATTERN` accepts the result. */
const body = (n: number): string => String(n).padStart(26, "0");

/** Deterministic ids: d_000...001, w_000...001, t_000...001. */
export function seqIds(): IdGen {
  let daemon = 0;
  let worker = 0;
  let turn = 0;
  let request = 0;
  return {
    daemon: () => `d_${body(++daemon)}`,
    worker: () => `w_${body(++worker)}`,
    turn: () => `t_${body(++turn)}`,
    // Not a ULID: `IdGen.request()` is an opaque string, and `r_` keeps it obvious in a log
    // that a request id is not addressable like the other three.
    request: () => `r_${body(++request)}`,
  };
}

export function nullLogger(): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return logger;
}
