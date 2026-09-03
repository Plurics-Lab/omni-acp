import { describe, expect, it } from "vitest";
import {
  AcpRequestError,
  ERROR_STATUS,
  OMNI_ERROR_CODES,
  OmniError,
  type OmniErrorCode,
} from "@omni-acp/protocol";

describe("ERROR_STATUS", () => {
  it("is total over OMNI_ERROR_CODES at runtime, with §9's exact table", () => {
    expect(ERROR_STATUS).toStrictEqual({
      bad_request: 400,
      unauthorized: 401,
      forbidden: 403,
      policy_exceeds_ceiling: 403,
      worker_not_found: 404,
      worker_busy: 409,
      worker_closed: 410,
      not_resumable: 422,
      lease_held: 423,
      worker_limit: 429,
      agent_error: 502,
      agent_timeout: 504,
      internal: 500,
    });
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...OMNI_ERROR_CODES].sort());
    for (const code of OMNI_ERROR_CODES) {
      expect(new OmniError(code, "x").status).toBe(ERROR_STATUS[code]);
    }
  });
});

describe("OmniError", () => {
  it("puts `detail` in the object and never in the body", () => {
    const e = new OmniError("forbidden", "cwd outside cwdRoots", {
      detail: { cwd: "/etc", pid: 4242 },
    });
    expect(e.toBody()).toStrictEqual({ code: "forbidden", message: "cwd outside cwdRoots" });
    expect(e.detail).toEqual({ cwd: "/etc", pid: 4242 });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("OmniError");
  });

  it("carries `acp` verbatim into the body when there is one", () => {
    const acp = { code: -32000, message: "model unavailable", data: { retryAfter: 30 } };
    expect(new OmniError("agent_error", "handshake failed", { acp }).toBody()).toStrictEqual({
      code: "agent_error",
      message: "handshake failed",
      acp,
    });
  });

  it("narrows with `is`, optionally by code", () => {
    const e = new OmniError("worker_busy", "a turn is already live");
    expect(OmniError.is(e)).toBe(true);
    expect(OmniError.is(e, "worker_busy")).toBe(true);
    expect(OmniError.is(e, "worker_closed")).toBe(false);
    expect(OmniError.is(new Error("plain"))).toBe(false);
    expect(OmniError.is(null)).toBe(false);
    expect(OmniError.is("worker_busy")).toBe(false);
  });
});

describe("OmniError.from", () => {
  it("maps an ACP RequestError to agent_error carrying `acp`", () => {
    const req = new AcpRequestError(-32601, "Method not found", { method: "session/unknown" });
    const e = OmniError.from(req);
    expect(e.code).toBe("agent_error");
    expect(e.status).toBe(502);
    expect(e.message).toBe("Method not found");
    expect(e.acp).toStrictEqual({
      code: -32601,
      message: "Method not found",
      data: { method: "session/unknown" },
    });
    expect(e.cause).toBe(req);
  });

  it("omits `data` when the RequestError carries none, so two bodies are deep-equal", () => {
    const e = OmniError.from(new AcpRequestError(-32603, "Internal error"));
    expect(e.toBody()).toStrictEqual({
      code: "agent_error",
      message: "Internal error",
      acp: { code: -32603, message: "Internal error" },
    });
  });

  it("maps AbortError and TimeoutError to agent_timeout", () => {
    const ac = new AbortController();
    ac.abort();
    expect(OmniError.from(ac.signal.reason).code).toBe("agent_timeout");
    expect(OmniError.from(new DOMException("took too long", "TimeoutError")).code).toBe(
      "agent_timeout",
    );
    const nodeStyle = Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
    expect(OmniError.from(nodeStyle).code).toBe("agent_timeout");
  });

  it("returns an OmniError unchanged, by identity", () => {
    const original = new OmniError("worker_limit", "too many workers");
    expect(OmniError.from(original)).toBe(original);
    expect(OmniError.from(original, "internal")).toBe(original);
  });

  it("maps anything else to `internal`, or to the caller's fallback", () => {
    expect(OmniError.from(new Error("boom")).code).toBe("internal");
    expect(OmniError.from(new Error("boom")).status).toBe(500);
    expect(OmniError.from(new TypeError("bad"), "bad_request").code).toBe("bad_request");
  });

  it("never throws, whatever it is handed", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const inputs: unknown[] = [
      undefined,
      null,
      0,
      "",
      "a string error",
      Symbol("s"),
      [],
      circular,
      { message: 42 },
      Object.create(null),
    ];
    for (const input of inputs) {
      const e = OmniError.from(input);
      expect(OMNI_ERROR_CODES).toContain(e.code as OmniErrorCode);
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
    expect(OmniError.from("a string error").message).toBe("a string error");
  });
});
