import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { createDaemon } from "@omni-acp/daemon";
import type { Daemon, DaemonConfig, EventEnvelope, WorkerHandle } from "@omni-acp/protocol";
import { reduceTurn, turnStatus } from "@omni-acp/protocol";
import { sdkExampleAgentPath, waitGone } from "@omni-acp/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempRoot } from "./support/harness.js";

/**
 * D15 constraint 1, proven at runtime rather than asserted in prose: with `listen: null` the
 * daemon binds no socket, `daemon.url === null`, and the FULL worker lifecycle still works
 * in-process. WP-6 owns this file.
 *
 * The in-process path takes its `AuthContext` from `daemon.authContextFor("local")` — never from
 * a forged `new Headers({ authorization: "Bearer …" })`, which would route the library path
 * through an HTTP-shaped credential and make "HTTP is only an adapter" false (review R10).
 */
describe("library-only daemon", () => {
  let daemon: Daemon;
  let root: string;
  let dataDir: string;
  let fetchCalls = 0;

  beforeAll(async () => {
    root = await tempRoot("omni-acp-lib-");
    dataDir = await tempRoot("omni-acp-lib-data-");

    const config: DaemonConfig = {
      dataDir,
      // The whole point: no socket.
      listen: null,
      tokens: [
        {
          id: "local",
          secret: randomBytes(32).toString("hex"),
          role: "admin",
          cwdRoots: [root],
        },
      ],
      agents: [{ id: "example", command: process.execPath, args: [sdkExampleAgentPath()] }],
    };

    daemon = await createDaemon(config);
    await daemon.start();

    // Count every use of the HTTP adapter, so "never calls daemon.fetch" is a measurement
    // rather than a claim.
    const original = daemon.fetch.bind(daemon);
    Object.defineProperty(daemon, "fetch", {
      configurable: true,
      value: (request: Request) => {
        fetchCalls += 1;
        return original(request);
      },
    });
  }, 30_000);

  afterAll(async () => {
    await daemon?.stop({ graceful: true }).catch(() => {});
    for (const dir of [root, dataDir])
      await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("binds no socket and reports url === null", () => {
    expect(daemon.url).toBeNull();
    // `fetch` is still AVAILABLE — module-graph purity here would be theatre that costs
    // `fetch()` without `start()`, which is what the whole route suite is built on (D27).
    expect(typeof daemon.fetch).toBe("function");
  });

  it("takes its AuthContext from daemon.authContextFor(tokenId), forging no Bearer header", () => {
    const auth = daemon.authContextFor("local");
    expect(auth.tokenId).toBe("local");
    expect(auth.role).toBe("admin");
    expect(auth.cwdRoots).toEqual([root]);
    expect(auth.asClientRef()).toEqual({ tokenId: "local", clientId: null });

    // An unknown token id is `unauthorized`, the same answer the header path gives — one
    // decision, two doors.
    expect(() => daemon.authContextFor("nobody")).toThrow(/unauthorized|token/i);
  });

  it("runs create -> prompt -> events -> turn -> delete with no socket bound", async () => {
    const auth = daemon.authContextFor("local");

    const handle: WorkerHandle = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    expect(handle.snapshot().state).toBe("ready");
    const pid = handle.snapshot().process?.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    const accepted = await handle.prompt(
      [{ type: "text", text: "who are you?" }],
      auth.asClientRef(),
    );
    expect(accepted.turnId).toMatch(/^t_/);

    // The same synchronous log every SSE subscriber reads, reached without a subscriber.
    const collected: EventEnvelope[] = [];
    await new Promise<void>((resolve) => {
      const subscription = handle.log.subscribe(accepted.seq - 1, (envelope) => {
        collected.push(envelope);
        const payload = envelope.payload as unknown as Record<string, unknown>;
        const idle =
          envelope.turnId === accepted.turnId &&
          payload["sessionUpdate"] === "state_update" &&
          payload["state"] === "idle";
        if (
          idle ||
          (envelope.kind === "omni.worker_state" && envelope.payload.state === "closed")
        ) {
          subscription.close();
          resolve();
        }
      });
    });

    // The library's aggregate and the pure reducer are one thing (DESIGN §5.5, L9).
    const status = handle.turn(accepted.turnId);
    expect(status.state).toBe("completed");
    expect(status.result?.stopReason).toBe("end_turn");
    expect(status.result?.text).toContain("I'll skip the configuration update");
    expect(status.result).toEqual(reduceTurn(accepted.turnId, collected));
    expect(status).toEqual(turnStatus(accepted.turnId, handle.log.read(0)));

    const closed = await daemon.workers.delete(handle.id, auth);
    expect(closed.state).toBe("closed");
    expect(closed.leaderExited).toBe(true);
    expect(await waitGone(pid, 10_000)).toBe(true);
    expect(daemon.supervisor.live.size).toBe(0);
  }, 60_000);

  it("never calls daemon.fetch on this path", () => {
    expect(fetchCalls).toBe(0);
  });
});
