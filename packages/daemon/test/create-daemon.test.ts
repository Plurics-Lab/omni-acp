import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DaemonConfig,
  HEADER,
  ID_PATTERN,
  OmniError,
  type DaemonConfig as DaemonConfigInput,
  type EventEnvelope,
  type TurnId,
} from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, seqIds, type FakeSupervisor } from "@omni-acp/testkit";
import { createDaemon } from "../src/create-daemon.js";
import { DAEMON_ID_FILE } from "../src/ids-file.js";
import type { Daemon, DaemonEvent } from "../src/types.js";
import { coreScript } from "./fake-core.js";
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

/** ~800 leaked `/tmp` directories per full run without this; see `support/temp-dirs.ts`. */
afterEach(async () => {
  await removeTempRoots();
});

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const SECRET = "local-secret-0123456789abc";

/** Every member of `Daemon` (CONTRACTS.md §5.4), so acceptance 14 has runtime teeth too. */
const DAEMON_MEMBERS = [
  "id",
  "config",
  "info",
  "url",
  "workers",
  "catalog",
  "supervisor",
  "authContextFor",
  "authenticate",
  "whoami",
  "fetch",
  "on",
  "start",
  "stop",
] as const;

async function build(over?: Partial<DaemonConfigInput>): Promise<{
  daemon: Daemon;
  supervisor: FakeSupervisor;
  root: string;
  dataDir: string;
}> {
  const root = await tempRoot("omni-daemon-");
  const dataDir = join(root, "data");
  const supervisor = fakeSupervisor();
  const daemon = await createDaemon(
    {
      dataDir,
      listen: null,
      tokens: [{ id: "local", secret: SECRET, role: "admin", cwdRoots: [root] }],
      agents: [{ id: "example", command: process.execPath, args: ["agent.js"] }],
      logLevel: "silent",
      ...over,
    },
    { supervisor, ids: seqIds(), logger: nullLogger() },
  );
  return { daemon, supervisor, root, dataDir };
}

beforeEach(() => {
  coreScript.reset();
});

describe("createDaemon — the library IS the product (D15, acceptance 1)", () => {
  it("runs the WHOLE worker lifecycle with listen: null, no socket and no Bearer header", async () => {
    const { daemon, supervisor, root } = await build();

    const sockets = () =>
      process.getActiveResourcesInfo().filter((r) => r === "TCPSERVERWRAP").length;
    const before = sockets();
    await daemon.start();
    expect(daemon.url).toBeNull();
    expect(sockets()).toBe(before); // D15 constraint 1, proven rather than asserted in prose

    // review R10: the in-process caller takes its AuthContext from the daemon, and forges no
    // HTTP-shaped credential to reach the library.
    const auth = daemon.authContextFor("local");
    expect(auth.tokenId).toBe("local");

    // create
    const handle = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    expect(handle.snapshot().state).toBe("ready");
    expect(daemon.workers.list(auth)).toHaveLength(1);

    // prompt
    const accepted = await daemon.workers.prompt(handle.id, auth, {
      content: [{ type: "text", text: "who are you?" }],
    });
    coreScript.workers.at(-1)?.chunk("I am a fake");
    coreScript.workers.at(-1)?.finishTurn("end_turn");

    // events — the log is reachable in-process, with no SSE in the loop
    const log = daemon.workers.logFor(handle.id, auth);
    expect(log.read(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.read(accepted.seq - 1)[0]?.turnId).toBe(accepted.turnId);

    // turn
    const status = daemon.workers.turn(handle.id, auth, accepted.turnId);
    expect(status.state).toBe("completed");
    expect(status.result?.text).toBe("I am a fake");

    // delete
    const closed = await daemon.workers.delete(handle.id, auth);
    expect(closed).toMatchObject({ workerId: handle.id, state: "closed" });
    expect(supervisor.allTreesReclaimed()).toBe(true);

    await daemon.stop();
  });

  it("exposes a WORKING fetch even though no port was ever bound (D27)", async () => {
    const { daemon } = await build();
    // Not `start()`ed, `listen: null`, no socket — and the adapter answers anyway. This is the
    // property the entire route suite is built on.
    const res = await daemon.fetch(new Request("http://daemon.invalid/v1/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await daemon.stop();
  });

  it("structurally satisfies the Daemon interface (acceptance 14)", async () => {
    const { daemon } = await build();
    // The compile-time half of the claim…
    const typed: Daemon = daemon;
    // …and the runtime half, which survives a test file that nothing typechecks.
    for (const member of DAEMON_MEMBERS) expect(typed).toHaveProperty(member);
    expect(daemon.id).toMatch(ID_PATTERN.daemon);
    expect(daemon.catalog.list()).toHaveLength(1);
    expect(daemon.supervisor.platform.ownership).toBeDefined();
    await daemon.stop();
  });
});

describe("createDaemon config resolution", () => {
  it("rejects an invalid config as bad_request, naming the offending field", async () => {
    await expect(createDaemon({ tokens: [] } as never)).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
    await expect(
      createDaemon({ tokens: [{ id: "t", secret: "x" }] } as never),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it('ACCEPTS eventLog.driver "sqlite" and opens persistence with it (M1, §8.1)', async () => {
    // M0 parsed this and then refused it at runtime. M1 is the milestone that removes the
    // refusal: the config SHAPE never changed, only that one line, and `createDaemon` now hands
    // the driver to `openPersistence` — which, with M1-WP-A landed, opens a real database.
    expect(() =>
      DaemonConfig.parse({
        tokens: [{ id: "t", secret: SECRET }],
        eventLog: { driver: "sqlite" },
      }),
    ).not.toThrow();
    const { daemon, dataDir } = await build({ eventLog: { driver: "sqlite" } });
    try {
      expect(daemon.config.eventLog.driver).toBe("sqlite");
      // The driver reached the STORE, not just the config object: `GET /v1/info` reports the
      // file that is actually open, which is the difference between wiring and a parsed field.
      expect(daemon.info.persistence.driver).toBe("sqlite");
      expect(daemon.info.persistence.file).toBe(join(dataDir, "events.db"));
      expect(existsSync(join(dataDir, "events.db"))).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('keeps "memory" as the default, so createDaemon() leaves no database behind (M1-R17)', async () => {
    const { daemon, dataDir } = await build();
    expect(daemon.config.eventLog.driver).toBe("memory");
    expect(daemon.info.persistence.driver).toBe("memory");
    expect(daemon.info.persistence.file).toBeNull();
    await daemon.stop();
    // `omni-acp start` is what writes "sqlite"; an embedded `OmniACP.local()` must not.
    expect(existsSync(join(dataDir, "events.db"))).toBe(false);
  });

  it("resolves dataDir to an absolute, ~-expanded path on daemon.config", async () => {
    const { daemon, dataDir } = await build();
    expect(daemon.config.dataDir).toBe(dataDir);
    await daemon.stop();
  });
});

describe("daemonId (acceptance 13)", () => {
  it("is a d_-prefixed ULID persisted in dataDir and stable across createDaemon calls", async () => {
    const { daemon, dataDir, root } = await build();
    expect(daemon.id).toMatch(ID_PATTERN.daemon);
    expect((await readFile(join(dataDir, DAEMON_ID_FILE), "utf8")).trim()).toBe(daemon.id);
    await daemon.stop();

    const again = await createDaemon(
      {
        dataDir,
        listen: null,
        tokens: [{ id: "local", secret: SECRET, role: "admin", cwdRoots: [root] }],
        logLevel: "silent",
      },
      { supervisor: fakeSupervisor(), logger: nullLogger() },
    );
    expect(again.id).toBe(daemon.id);
    expect(again.info.daemonId).toBe(daemon.id);
    await again.stop();
  });

  it("honours a configured daemonId and refuses one that is not a d_ ULID", async () => {
    const id = `d_${"0".repeat(25)}5`;
    const { daemon } = await build({ daemonId: id });
    expect(daemon.id).toBe(id);
    await daemon.stop();

    await expect(
      createDaemon({ daemonId: "nope", tokens: [{ id: "t", secret: SECRET }] }),
    ).rejects.toThrow(/d_.*ULID/);
  });
});

describe("daemon.info (H2, §6.6)", () => {
  it("reports the honesty fields from the Supervisor's own platform", async () => {
    const { daemon, supervisor } = await build();
    expect(daemon.info).toMatchObject({
      daemonId: daemon.id,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      protocolVersions: [1],
    });
    expect(daemon.info.ownership).toBe(supervisor.platform.ownership);
    expect(typeof daemon.info.version).toBe("string");
    expect(daemon.info.startedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    await daemon.stop();
  });
});

describe("daemon.authenticate / whoami (H3, H13, acceptance 5)", () => {
  it("is a thin wrapper over the same table authContextFor uses", async () => {
    const { daemon } = await build();
    const viaHeader = daemon.authenticate(new Headers({ [HEADER.auth]: `Bearer ${SECRET}` }));
    expect(viaHeader.tokenId).toBe("local");
    expect(daemon.whoami(viaHeader)).toEqual({
      tokenId: "local",
      role: "admin",
      daemonId: daemon.id,
      agents: "*",
      cwdRoots: viaHeader.cwdRoots,
      maxWorkers: 16,
      policyCeiling: null,
    });
    await daemon.stop();
  });

  it("re-evaluates every call: removing the token changes the next verdict, no restart", async () => {
    const { daemon } = await build();
    const headers = new Headers({ [HEADER.auth]: `Bearer ${SECRET}` });
    expect(daemon.authenticate(headers).tokenId).toBe("local");
    daemon.config.tokens.length = 0;
    expect(() => daemon.authenticate(headers)).toThrow(OmniError);
    expect(() => daemon.authContextFor("local")).toThrow(/unknown token id/);
    await daemon.stop();
  });
});

describe("daemon.on (worker.state | worker.event)", () => {
  it("routes lifecycle envelopes and content envelopes to their own channels", async () => {
    const { daemon, root } = await build();
    const auth = daemon.authContextFor("local");
    const states: DaemonEvent[] = [];
    const events: DaemonEvent[] = [];
    const off = daemon.on("worker.state", (e) => states.push(e));
    daemon.on("worker.event", (e) => events.push(e));

    const handle = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    await daemon.workers.prompt(handle.id, auth, {
      content: [{ type: "text", text: "hi" }],
    });

    expect(states.map((e) => (e.envelope as EventEnvelope).kind)).toEqual([
      "omni.worker_state",
      "omni.worker_state",
    ]);
    expect(states.every((e) => e.type === "worker.state" && e.workerId === handle.id)).toBe(true);
    expect(events.map((e) => e.envelope.kind)).toEqual(["acp.session_update"]);

    off();
    coreScript.workers.at(-1)?.finishTurn();
    await daemon.workers.delete(handle.id, auth);
    // Unsubscribed: the close did not reach the removed handler.
    expect(states).toHaveLength(2);
    await daemon.stop();
  });

  it("survives a listener that throws", async () => {
    const { daemon, root } = await build();
    const auth = daemon.authContextFor("local");
    daemon.on("worker.state", () => {
      throw new Error("listener bug");
    });
    await expect(
      daemon.workers.create({ agent: "example", cwd: root }, auth),
    ).resolves.toBeDefined();
    await daemon.stop();
  });
});

describe("daemon.stop (acceptance 12)", () => {
  it("closes every worker and every subscription, and leaves zero live processes", async () => {
    const { daemon, supervisor, root } = await build();
    const auth = daemon.authContextFor("local");
    const a = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    const b = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    const subscription = a.log.subscribe(0, () => {});

    await daemon.stop({ graceful: true });

    expect(a.snapshot().state).toBe("closed");
    expect(b.snapshot().state).toBe("closed");
    expect(subscription.closed).toBe(true);
    expect(a.log.subscriberCount).toBe(0);
    expect(supervisor.live.size).toBe(0);
    expect(supervisor.allTreesReclaimed()).toBe(true);
    expect(daemon.workers.size).toBe(0);
    expect(daemon.url).toBeNull();
  });

  it("is idempotent, including when called concurrently", async () => {
    const { daemon, root } = await build();
    const auth = daemon.authContextFor("local");
    await daemon.workers.create({ agent: "example", cwd: root }, auth);
    await Promise.all([daemon.stop(), daemon.stop({ graceful: false })]);
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("stops cleanly with no workers and no start()", async () => {
    const { daemon } = await build();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });

  it("still answers a turn query for a worker closed by shutdown (the log outlives it)", async () => {
    const { daemon, root } = await build();
    const auth = daemon.authContextFor("local");
    const handle = await daemon.workers.create({ agent: "example", cwd: root }, auth);
    const accepted = await daemon.workers.prompt(handle.id, auth, {
      content: [{ type: "text", text: "hi" }],
    });
    await daemon.stop();
    const status = daemon.workers.turn(handle.id, auth, accepted.turnId as TurnId);
    // Terminal on `worker_state{closed}`, never on a fabricated `idle` (§7.3, D8).
    expect(status.state).toBe("failed");
    expect(status.stopReason).toBeNull();
    expect(status.result?.error?.code).toBe("worker_closed");
  });
});

describe("createDaemon with a socket (D15's other half)", () => {
  it("binds an ephemeral port on start(), serves the app, and releases it on stop()", async () => {
    // Port 0 everywhere: a fixed port is a suite that fails on somebody else's machine.
    const { daemon } = await build({ listen: { host: "127.0.0.1", port: 0 } });
    expect(daemon.url).toBeNull(); // null until start()

    await daemon.start();
    const url = daemon.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await daemon.start(); // idempotent: no second bind, same url
    expect(daemon.url).toBe(url);

    const health = await fetch(`${url}/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    // Real loopback HTTP, not an in-memory shortcut: a bad token is refused over the wire.
    expect(
      (await fetch(`${url}/v1/info`, { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);

    await daemon.stop();
    expect(daemon.url).toBeNull();
    await expect(fetch(`${url}/v1/health`)).rejects.toThrow();
  });

  it("REJECTS start() when the bind fails instead of dying of an uncaught error event", async () => {
    // A failed listen is reported asynchronously as an `error` event on the http server. With no
    // listener Node re-raises it as an uncaught exception, which kills the daemon process with a
    // stack trace and makes the CLI's "failed to start" path unreachable — the operator sees a
    // crash instead of one line naming the port. `192.0.2.1` is TEST-NET-1 (RFC 5737): no machine
    // on any of the three OSes owns it, so the bind fails with EADDRNOTAVAIL and never depends on
    // what else is listening on this box.
    const { daemon } = await build({ listen: { host: "192.0.2.1", port: 0 } });

    await expect(daemon.start()).rejects.toThrow(/EADDRNOTAVAIL|EACCES|EINVAL|ENOTFOUND/);
    // A failed bind is not remembered as "started": url stays null and stop() is still clean.
    expect(daemon.url).toBeNull();
    await daemon.stop();
  });
});
