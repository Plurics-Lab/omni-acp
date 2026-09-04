import { OmniACP, type Server } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf, type WireDaemon } from "./support/wire-daemon.js";

async function connected(wire: WireDaemon): Promise<Server> {
  return OmniACP.connect({ url: wire.url, token: wire.token, fetch: fetchOf(wire.daemon) });
}

describe("Server handle", () => {
  it("reads the catalog and the daemon info off the wire", async () => {
    const wire = createWireDaemon();
    const server = await connected(wire);

    const agents = await server.agents();
    expect(agents).toEqual([
      {
        id: "example",
        command: process.execPath,
        args: ["agent.js"],
        source: "config",
        // M1 — present and null, so the field never appears and disappears.
        probed: null,
      },
    ]);

    const info = await server.info();
    expect(info.daemonId).toBe(wire.daemonId);
    expect(info.protocolVersions).toEqual([1]);
    expect(info.ownership.confirmsTreeGone).toBe(process.platform !== "win32");
  });

  it("creates a worker that is synchronously ready, with real handshake capabilities", async () => {
    // H5: the 201 already carries `state:"ready"`, so there is nothing for the SDK to poll.
    const wire = createWireDaemon();
    const server = await connected(wire);

    const worker = await server.createAgent("example", { cwd: "/tmp/wire", label: "a" });

    expect(worker.state).toBe("ready");
    // The fixture's agent advertises `loadSession` and a resume spelling, because M1's
    // hibernate/wake surface needs an agent that can be woken (§15.2, ruling M1-R15). What this
    // asserts is that the 201 carried the REAL handshake answer through unchanged.
    expect(worker.snapshot.capabilities?.loadSession).toBe(true);
    expect(worker.snapshot.capabilities?.resume.method).toBe("session/resume");
    expect(worker.snapshot.process?.pid).toBeGreaterThan(0);
    expect(wire.requests.at(-1)).toEqual({ method: "POST", path: "/v1/workers" });
  });

  it("returns SNAPSHOTS from workers(), never live handles (D31)", async () => {
    // A listing that returned handles would open N SSE streams for a page nobody scrolled.
    const wire = createWireDaemon();
    const server = await connected(wire);
    const a = wire.createWorker();
    const b = wire.createWorker();

    const listed = await server.workers();

    expect(listed.map((w) => w.workerId).sort()).toEqual([a.workerId, b.workerId].sort());
    for (const snapshot of listed) {
      expect(snapshot).not.toHaveProperty("prompt");
    }
    expect(wire.connections).toEqual([]);
  });

  it("attaches to an existing worker and rejects a malformed id before the wire", async () => {
    const wire = createWireDaemon();
    const server = await connected(wire);
    const snapshot = wire.createWorker();

    const worker = await server.attach(snapshot.workerId);
    expect(worker.id).toBe(snapshot.workerId);

    await expect(server.attach("nope")).rejects.toMatchObject({ code: "bad_request" });
    await expect(server.attach("w_00000000000000000000009999")).rejects.toMatchObject({
      code: "worker_not_found",
      status: 404,
    });
  });

  it("closes local streams on close() and leaves the remote worker alone", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 5 });
    const server = await connected(wire);
    const snapshot = wire.createWorker();
    const worker = await server.attach(snapshot.workerId);
    worker.on("event", () => {}); // opens the background tail
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(wire.subscriberCount(snapshot.workerId)).toBe(1);

    await server.close();

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(wire.subscriberCount(snapshot.workerId)).toBe(0);
    // The worker itself survives — that is what `attach()` is for.
    const listed = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    }).then((s) => s.workers());
    expect(listed.map((w) => w.state)).toEqual(["ready"]);
  });

  it("refuses further calls once closed, rather than half-working", async () => {
    const wire = createWireDaemon();
    const server = await connected(wire);
    await server.close();

    await expect(server.info()).rejects.toMatchObject({ code: "bad_request" });
    await expect(server.workers()).rejects.toMatchObject({ code: "bad_request" });
    // Idempotent: a second close is a no-op, not an error.
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("rejects an empty agent id or cwd before building a request", async () => {
    const wire = createWireDaemon();
    const server = await connected(wire);
    const before = wire.requests.length;

    await expect(server.createAgent("", { cwd: "/tmp" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(server.createAgent("example", { cwd: "" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(wire.requests.length).toBe(before);
  });
});
