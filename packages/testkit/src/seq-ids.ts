import type { IdGen, Logger } from "@omni-acp/protocol";

/** 26 digits, so the body still satisfies ULID_BODY and `ID_PATTERN` accepts the result. */
const body = (n: number): string => String(n).padStart(26, "0");

/** Deterministic ids: d_000...001, w_000...001, t_000...001, x_/r_/dl_ from M2 on. */
export function seqIds(): IdGen {
  let daemon = 0;
  let worker = 0;
  let turn = 0;
  let request = 0;
  let interaction = 0;
  let run = 0;
  let delivery = 0;
  return {
    daemon: () => `d_${body(++daemon)}`,
    worker: () => `w_${body(++worker)}`,
    turn: () => `t_${body(++turn)}`,
    // Not a ULID: `IdGen.request()` is an opaque string, and the `q_` prefix keeps it obvious in
    // a log that a request id is not addressable like the others.
    //
    // It USED to be `r_`, which M2 took for `RunId` (§5.8.1) — and a fake whose opaque request
    // ids look exactly like real run ids is the kind of collision an `assertRunId` test would
    // pass for the wrong reason. `seq-ids.test.ts` moves with it, and it is the only assertion
    // on the value.
    request: () => `q_${body(++request)}`,
    // ── M2 (§5.8.1) ────────────────────────────────────────────────────────
    interaction: () => `x_${body(++interaction)}`,
    run: () => `r_${body(++run)}`,
    delivery: () => `dl_${body(++delivery)}`,
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
