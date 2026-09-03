import { describe, expect, it } from "vitest";
import {
  HEADER,
  OmniError,
  type Daemon,
  type WorkerRegistry,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
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

  it("records a CLASS-based override, whose methods live on the prototype", () => {
    // `Object.keys` on a class instance returns its FIELDS and nothing else, so a facade built
    // from own enumerable keys alone drops every method and records zero calls — while the test
    // it was written for still passes, because the override keeps working through the untouched
    // reference. `calls` is the assertion WP-5 leans on, so it has to see this.
    const snap = { workerId: `w_${"0".repeat(26)}`, state: "ready" } as unknown as WorkerSnapshot;

    class FakeRegistry {
      readonly seen: string[] = [];
      /** A prototype ACCESSOR, not a field: the other thing `Object.keys` cannot see. */
      get size(): number {
        return this.seen.length;
      }
      snapshot(): WorkerSnapshot {
        this.seen.push("snapshot");
        return snap;
      }
      list(): WorkerSnapshot[] {
        return [snap];
      }
    }

    const registry = new FakeRegistry();
    const daemon = stubDaemon({ workers: registry as unknown as WorkerRegistry });
    const auth = daemon.authContextFor("t");

    expect(daemon.workers.snapshot(`w_${"0".repeat(26)}`, auth)).toBe(snap);
    expect(daemon.workers.list(auth)).toEqual([snap]);
    expect(daemon.calls.map((c) => c.method)).toEqual([
      "authContextFor",
      "workers.snapshot",
      "workers.list",
    ]);
    // `this` still resolves to the instance, so the override's own state is intact...
    expect(registry.seen).toEqual(["snapshot"]);
    // ...and the accessor reads LIVE rather than being frozen at construction time.
    expect(daemon.workers.size).toBe(1);
  });

  it("keeps a class instance passed as the whole override, prototype methods and all", () => {
    class FakeDaemon {
      readonly stopped: boolean[] = [];
      stop(opts?: { graceful?: boolean }): Promise<void> {
        this.stopped.push(opts?.graceful === true);
        return Promise.resolve();
      }
    }
    const override = new FakeDaemon();
    const daemon = stubDaemon(override as unknown as Partial<Daemon>);
    return daemon.stop({ graceful: true }).then(() => {
      expect(override.stopped).toEqual([true]);
      expect(daemon.calls.map((c) => c.method)).toEqual(["stop"]);
    });
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
