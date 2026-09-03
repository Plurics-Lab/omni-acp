import { describe, expect, it } from "vitest";
import { HEADER, OmniError, type Daemon, type WorkerSnapshot } from "@omni-acp/protocol";
import { stubDaemon } from "@omni-acp/testkit";

const bearer = (secret: string): Headers => new Headers({ [HEADER.auth]: `Bearer ${secret}` });

describe("stubDaemon", () => {
  it("structurally satisfies Daemon", () => {
    const daemon: Daemon = stubDaemon();
    expect(daemon.id).toMatch(/^d_/);
    expect(daemon.url).toBeNull();
    expect(daemon.info.protocolVersions).toEqual([1]);
    expect(daemon.info.ownership.kind).toBe("posix-process-group");
    expect(daemon.config.tokens[0]?.id).toBe("stub");
  });

  it("records every call, including the ones on the registry facade", async () => {
    const daemon = stubDaemon();
    daemon.authContextFor("local");
    expect(daemon.workers.list(daemon.authContextFor("local"))).toEqual([]);
    await daemon.start();
    await daemon.stop({ graceful: true });

    expect(daemon.calls.map((c) => c.method)).toEqual([
      "authContextFor",
      "authContextFor",
      "workers.list",
      "start",
      "stop",
    ]);
    expect(daemon.calls.at(-1)?.args).toEqual([{ graceful: true }]);
  });

  it("knows no workers: every id-addressed method is worker_not_found, never a leak", () => {
    const daemon = stubDaemon();
    const auth = daemon.authContextFor("t");
    const id = `w_${"0".repeat(26)}` as const;
    for (const call of [
      () => daemon.workers.get(id, auth),
      () => daemon.workers.snapshot(id, auth),
      () => daemon.workers.turn(id, auth, `t_${"0".repeat(26)}`),
      () => daemon.workers.logFor(id, auth),
    ]) {
      expect(call).toThrow(OmniError);
      try {
        call();
      } catch (e) {
        expect(OmniError.is(e, "worker_not_found")).toBe(true);
      }
    }
  });

  it("lets an override replace behaviour while still recording the call", () => {
    const snapshot = {
      workerId: `w_${"0".repeat(26)}`,
      state: "ready",
    } as unknown as WorkerSnapshot;
    const daemon = stubDaemon({
      workers: {
        ...stubDaemon().workers,
        snapshot: () => snapshot,
      },
    });
    const auth = daemon.authContextFor("t");
    expect(daemon.workers.snapshot(`w_${"0".repeat(26)}`, auth)).toBe(snapshot);
    expect(daemon.calls.map((c) => c.method)).toEqual(["authContextFor", "workers.snapshot"]);
  });

  it("authenticates a bearer header and rejects a missing one", () => {
    const daemon = stubDaemon();
    expect(daemon.authenticate(bearer("anything")).tokenId).toBe("stub");
    expect(() => daemon.authenticate(new Headers())).toThrow(OmniError);
    try {
      daemon.authenticate(new Headers({ [HEADER.auth]: "Basic xyz" }));
    } catch (e) {
      expect(OmniError.is(e, "unauthorized")).toBe(true);
    }
  });

  it("carries Omni-Client-Id into the AuthContext without making it a visibility boundary", () => {
    const daemon = stubDaemon();
    const auth = daemon.authenticate(
      new Headers({ [HEADER.auth]: "Bearer s", [HEADER.clientId]: "cli-7" }),
    );
    expect(auth.asClientRef()).toEqual({ tokenId: "stub", clientId: "cli-7" });
    expect(auth.canSee({} as WorkerSnapshot)).toBe(true); // D13 is the real daemon's job
  });

  it("whoami mirrors the AuthContext", () => {
    const daemon = stubDaemon();
    expect(daemon.whoami(daemon.authContextFor("t1", "c1"))).toEqual({
      tokenId: "t1",
      role: "admin",
      daemonId: daemon.id,
      agents: "*",
      cwdRoots: [],
      maxWorkers: 16,
      policyCeiling: null,
    });
  });

  it("has a fetch that is honest about being a stub", async () => {
    const daemon = stubDaemon();
    const res = await daemon.fetch(new Request("http://d/v1/health"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "internal" });
    expect(daemon.calls.map((c) => c.method)).toEqual(["fetch"]);
  });

  it("uses a fakeSupervisor, so a daemon test never touches a real process", () => {
    const daemon = stubDaemon();
    expect(daemon.supervisor.live.size).toBe(0);
    expect(daemon.catalog.list()).toEqual([]);
    expect(() => daemon.catalog.get("nope")).toThrow(/unknown agent "nope"/);
  });

  it("produces a SpawnSpec from a descriptor and a cwd, and nowhere else", () => {
    const daemon = stubDaemon();
    expect(
      daemon.catalog.toSpawnSpec(
        {
          id: "example",
          command: process.execPath,
          args: ["agent.js"],
          env: { A: "1" },
          protocolVersion: 1,
          shutdown: { signal: "SIGTERM", graceMs: 5_000 },
        },
        { cwd: "/tmp/work" },
      ),
    ).toEqual({
      command: process.execPath,
      args: ["agent.js"],
      cwd: "/tmp/work",
      env: { A: "1" },
      label: "example",
    });
  });
});
