import { describe, expect, it } from "vitest";
import {
  OmniError,
  type AcpLinkLike,
  type ResumeReport,
  type SessionOpenResult,
  type SessionReopenOptions,
  type SessionStrategy,
  type SessionId,
} from "@omni-acp/protocol";
import { fakeRuntime } from "@omni-acp/testkit";
import { performWake } from "../../src/worker/wake.js";
import { OWNER } from "./support/harness.js";

/**
 * `performWake` — the composable half of §15.3's ladder.
 *
 * `Worker.wake()` is Land-written and frozen: it owns the single flight, the `starting`
 * admission and §15.5's failure mapping, and it calls `strategy.reopen` directly. What this
 * helper exists for is every OTHER caller of the same call — the compat suite, a registry-side
 * wake, a test — so the replay window and the error normalisation are not re-derived a second
 * time and allowed to drift.
 */

const SESSION = "sess_x" as SessionId;

const DEAD_LINK: AcpLinkLike = {
  request: () => Promise.reject(new Error("unused")),
  notify: () => {},
  closed: false,
};

function options(controls?: SessionReopenOptions["controls"]): SessionReopenOptions {
  return {
    cwd: "/tmp/ws",
    descriptor: fakeRuntime(),
    mcpServers: [],
    budgetMs: 1_000,
    sessionId: SESSION,
    capabilities: null,
    controls: controls ?? { replayWindow: () => () => {} },
  };
}

function counter(): {
  controls: SessionReopenOptions["controls"];
  readonly open: number;
  readonly closed: number;
} {
  let open = 0;
  let closed = 0;
  return {
    controls: {
      replayWindow: () => {
        open += 1;
        let done = false;
        return () => {
          if (done) return;
          done = true;
          closed += 1;
        };
      },
    },
    get open() {
      return open;
    },
    get closed() {
      return closed;
    },
  };
}

function strategy(reopen: SessionStrategy["reopen"]): SessionStrategy {
  return {
    open: () => Promise.reject(new Error("open is not part of a wake")),
    reopen,
    close: () => Promise.resolve(),
  };
}

const RESULT: SessionOpenResult = {
  capabilities: {
    protocolVersion: 1,
    raw: {},
    loadSession: true,
    promptCapabilities: null,
    supportsSessionClose: false,
    resume: { method: "session/load", replayFrom: false, requiresSameCwd: false },
    supportsSessionList: false,
    configOptions: null,
    modes: null,
    extensions: [],
  },
  sessionId: SESSION,
  resume: null,
};

describe("performWake", () => {
  it("passes the link and the options straight through and returns the strategy's result", async () => {
    const seen: { link: AcpLinkLike; o: SessionReopenOptions }[] = [];
    const s = strategy((link, o) => {
      seen.push({ link, o });
      return Promise.resolve(RESULT);
    });
    const o = options();
    expect(await performWake(DEAD_LINK, s, OWNER, o)).toBe(RESULT);
    expect(seen[0]?.link).toBe(DEAD_LINK);
    expect(seen[0]?.o).toBe(o);
  });

  it("holds the replay window OPEN across the reopen and closes it in a finally", async () => {
    const c = counter();
    let openDuringReopen = 0;
    const s = strategy(() => {
      openDuringReopen = c.open - c.closed;
      return Promise.resolve(RESULT);
    });
    await performWake(DEAD_LINK, s, OWNER, options(c.controls));
    expect(openDuringReopen).toBe(1);
    expect(c.open).toBe(1);
    expect(c.closed).toBe(1);
  });

  it("closes the window on the FAILURE edge — the one that would mark a live turn as replay", async () => {
    const c = counter();
    const s = strategy(() => Promise.reject(new OmniError("agent_error", "the agent died")));
    await expect(performWake(DEAD_LINK, s, OWNER, options(c.controls))).rejects.toThrow(
      "the agent died",
    );
    expect(c.open).toBe(1);
    expect(c.closed).toBe(1);
  });

  it("PRESERVES the ResumeReport an OmniError carries — §15.5's 422 body", async () => {
    const report: ResumeReport = {
      outcome: "rejected_permanent",
      hint: "not_found",
      rule: "rule2:session-not-found",
      method: "session/load",
      requested: SESSION,
      landedOn: null,
      historyLost: true,
      acp: { code: -32002, message: "session not found" },
      replayedEvents: 0,
      replayDropped: 0,
      durationMs: 5,
      at: "2026-09-04T00:00:00.000Z",
    };
    const s = strategy(() =>
      Promise.reject(
        new OmniError("not_resumable", "gone", { resume: report, acp: report.acp ?? undefined }),
      ),
    );
    const e = await performWake(DEAD_LINK, s, OWNER, options()).then(
      () => null,
      (err: unknown) => err as OmniError,
    );
    expect(e?.code).toBe("not_resumable");
    expect(e?.status).toBe(422);
    expect(e?.resume).toEqual(report);
    expect(e?.acp?.code).toBe(-32002);
    expect(e?.toBody().resume?.rule).toBe("rule2:session-not-found");
  });

  it("records WHO woke the worker in `detail`, which is logged and never returned on the wire", async () => {
    const s = strategy(() => Promise.reject(new OmniError("agent_error", "nope")));
    const e = await performWake(DEAD_LINK, s, OWNER, options()).then(
      () => null,
      (err: unknown) => err as OmniError,
    );
    expect(e?.detail?.["wokenBy"]).toBe(OWNER.clientId);
    // `toBody()` is the wire shape, and `detail` is deliberately absent from it (§9).
    expect(Object.keys(e?.toBody() ?? {})).toEqual(["code", "message"]);
  });

  it("normalises a non-OmniError rejection to `agent_error`, not `internal`", async () => {
    const s = strategy(() => Promise.reject(new Error("EPIPE")));
    const e = await performWake(DEAD_LINK, s, OWNER, options()).then(
      () => null,
      (err: unknown) => err as OmniError,
    );
    // Everything reachable from a reopen came back from — or died with — the agent process, and
    // §2.1 H5 maps that to 502.
    expect(e?.code).toBe("agent_error");
    expect(e?.status).toBe(502);
  });
});
