import { describe, expect, it } from "vitest";
import {
  ERROR_STATUS,
  OMNI_ERROR_CODES,
  OmniError,
  CreateWorkerRequest,
  type OmniErrorCode,
} from "@omni-acp/protocol";
import { toErrorResponse } from "../../src/http/errors.js";

describe("toErrorResponse — the ONE mapper (§9)", () => {
  it("maps every OmniErrorCode through ERROR_STATUS and nothing else", () => {
    for (const code of OMNI_ERROR_CODES) {
      const mapped = toErrorResponse(new OmniError(code, `${code} happened`));
      expect(mapped.status).toBe(ERROR_STATUS[code]);
      expect(mapped.body).toEqual({ code, message: `${code} happened` });
    }
  });

  it("covers the codes M0 never returns, so the table cannot rot (D29)", () => {
    // `policy_exceeds_ceiling`, `not_resumable` and `lease_held` are reserved: they are wired
    // here, and no M0 path produces them.
    const reserved: OmniErrorCode[] = ["policy_exceeds_ceiling", "not_resumable", "lease_held"];
    expect(reserved.map((c) => ERROR_STATUS[c])).toEqual([403, 422, 423]);
  });

  it("passes the agent's JSON-RPC error through in `acp`, verbatim and unreshaped", () => {
    const acp = { code: -32603, message: "internal", data: { detail: ["a", 1], nested: {} } };
    const mapped = toErrorResponse(new OmniError("agent_error", "handshake failed", { acp }));
    expect(mapped.status).toBe(502);
    expect(mapped.body).toEqual({ code: "agent_error", message: "handshake failed", acp });
    expect(mapped.body.acp).toEqual(acp);
  });

  it("omits `acp` entirely when there is none, so two bodies for one failure are deep-equal", () => {
    expect(toErrorResponse(new OmniError("worker_busy", "busy")).body).toEqual({
      code: "worker_busy",
      message: "busy",
    });
    expect("acp" in toErrorResponse(new OmniError("worker_busy", "busy")).body).toBe(false);
  });

  it("never returns `detail` — the half of an OmniError that is logged, not sent", () => {
    const mapped = toErrorResponse(
      new OmniError("forbidden", "nope", { detail: { cwd: "/home/secret", pid: 12 } }),
    );
    expect(JSON.stringify(mapped.body)).not.toContain("/home/secret");
  });

  it("maps a zod failure to 400, naming the field and not the value", () => {
    let thrown: unknown;
    try {
      CreateWorkerRequest.parse({ agent: "a", cwd: "/tmp", bogus: "sensitive-value" });
    } catch (e) {
      thrown = e;
    }
    const mapped = toErrorResponse(thrown);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe("bad_request");
    expect(mapped.body.message).toMatch(/bogus/);
    expect(mapped.body.message).not.toContain("sensitive-value");
  });

  it("maps malformed JSON to 400 rather than 500", () => {
    let thrown: unknown;
    try {
      JSON.parse("{oops");
    } catch (e) {
      thrown = e;
    }
    expect(toErrorResponse(thrown)).toEqual({
      status: 400,
      body: { code: "bad_request", message: "malformed JSON body" },
    });
  });

  it("maps an abort/timeout to 504 agent_timeout", () => {
    const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(toErrorResponse(aborted).status).toBe(504);
    expect(toErrorResponse(aborted).body.code).toBe("agent_timeout");
  });

  it("genericises an unclassified throw: 500, with the detail logged and not returned", () => {
    for (const raw of [new Error("ECONNRESET at /home/me/secret.ts:12"), "boom", 42, null]) {
      const mapped = toErrorResponse(raw);
      expect(mapped.status).toBe(500);
      expect(mapped.body).toEqual({ code: "internal", message: "internal error" });
    }
  });

  it("keeps a deliberate internal OmniError's own message — the author chose it", () => {
    expect(toErrorResponse(new OmniError("internal", "event log driver is unavailable"))).toEqual({
      status: 500,
      body: { code: "internal", message: "event log driver is unavailable" },
    });
  });
});
