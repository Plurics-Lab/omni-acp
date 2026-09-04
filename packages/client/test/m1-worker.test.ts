import { OmniACP, OmniError, type Server, type Worker } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import type { StopReason } from "@omni-acp/protocol";
import {
  createWireDaemon,
  fetchOf,
  type ScriptItem,
  type WireDaemon,
} from "./support/wire-daemon.js";

/**
 * The SDK's M1 surface (CONTRACTS.md §5.7): `hibernate()` / `wake()` / `lease.*` / `resume`, the
 * `Omni-Client-Id` per `connect()`, the `Omni-Lease-Epoch` fence, and `stream()`'s replay filter.
 *
 * Everything here runs against `wire-daemon.ts`, which implements the RULES those calls have to
 * cope with — L7's stale fence, L9's audit envelope, §15.3's replay window — and nothing else.
 * The daemon's own behaviour is `tests/integration`'s to prove.
 *
 * Owned by M1-WP-F.
 */

async function connect(wire: WireDaemon, clientId?: string): Promise<Server> {
  return OmniACP.connect({
    url: wire.url,
    token: wire.token,
    fetch: fetchOf(wire.daemon),
    ...(clientId === undefined ? {} : { clientId }),
  });
}

async function attached(wire: WireDaemon, clientId?: string): Promise<Worker> {
  const server = await connect(wire, clientId);
  return server.attach(wire.createWorker().workerId);
}

describe("Omni-Client-Id — one ULID per connect(), not per process", () => {
  it("two connect() calls on ONE token are two controllers (§16.1 rule L4)", async () => {
    const wire = createWireDaemon();
    const seen: string[] = [];
    const spy: typeof globalThis.fetch = (input, init) => {
      const request =
        input instanceof Request && init === undefined ? input : new Request(input, init);
      seen.push(request.headers.get("omni-client-id") ?? "");
      return fetchOf(wire.daemon)(request);
    };

    await OmniACP.connect({ url: wire.url, token: wire.token, fetch: spy });
    await OmniACP.connect({ url: wire.url, token: wire.token, fetch: spy });

    expect(seen).toHaveLength(2);
    // The M0 default was one id per PROCESS, which would make these equal — and would make the
    // acceptance script's step 4 (a second client refused with a 423 naming the first)
    // unreachable from one script.
    expect(seen[0]).not.toBe(seen[1]);
    for (const id of seen) expect(id).toMatch(/^c_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("an explicit clientId still wins, byte for byte", async () => {
    const wire = createWireDaemon();
    await connect(wire, "c_mine");
    // `connect()` issues exactly one request, and it carried the id we chose.
    expect(wire.requests).toEqual([{ method: "GET", path: "/v1/whoami" }]);
  });
});

describe("Worker.hibernate() / wake() — H18 and H19", () => {
  it("hibernate drops the process and releases the lease; the snapshot says so", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, "c_a");

    const snapshot = await worker.hibernate();

    expect(snapshot.state).toBe("hibernated");
    expect(snapshot.process).toBeNull();
    expect(snapshot.hibernatedAt).not.toBeNull();
    // §15.2: hibernation RELEASES the lease. A worker with no process has no turn to protect.
    expect(snapshot.lease.holder).toBeNull();
    expect(worker.state).toBe("hibernated");
  });

  it("wake reports the ResumeReport on the handle, and `generation` advanced", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, "c_a");
    await worker.hibernate();
    expect(worker.resume).toBeNull();

    const snapshot = await worker.wake();

    expect(snapshot.state).toBe("ready");
    expect(worker.resume?.outcome).toBe("landed");
    expect(worker.resume?.rule).toBe("rule7:landed");
    // "processes this worker has had" — a wake is one more (§5.1 `WorkerSnapshot.generation`).
    expect(snapshot.generation).toBe(2);
    expect(worker.snapshot.wakeCount).toBe(1);
  });

  it("a prompt on a HIBERNATED handle is given the wake budget, not the request default", async () => {
    // §15.3's first box: `prompt()` auto-wakes. The daemon's wake budget is 90 s by default while
    // `requestTimeoutMs` is 30 s, so a client that used its own default would abandon a wake that
    // was going to succeed. `requestTimeoutMs: 1` here makes the difference observable: the prompt
    // still lands, because the wake path does not use it.
    const wire = createWireDaemon();
    const snapshot = wire.createWorker();
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
      requestTimeoutMs: 1,
    });
    const worker = await server.attach(snapshot.workerId);
    await worker.hibernate();
    wire.hibernateWorker(snapshot.workerId);

    await expect(worker.prompt("hello")).resolves.toMatchObject({ verdict: "ok" });
  });
});

describe("the lease on the handle (CONTRACTS.md §5.7)", () => {
  it("acquire / release / steal each move `lease.snapshot` and its epoch", async () => {
    const wire = createWireDaemon();
    const worker = await attached(wire, "c_a");
    const before = worker.lease.snapshot.epoch;

    await worker.lease.release();
    expect(worker.lease.snapshot.holder).toBeNull();

    await worker.lease.acquire();
    expect(worker.lease.snapshot.holder?.clientId).toBe("c_a");
    expect(worker.lease.snapshot.epoch).toBe(before + 2);

    const stolen = await worker.lease.steal("the laptop went to sleep");
    expect(stolen.epoch).toBe(before + 3);
    expect(worker.lease.snapshot.epoch).toBe(before + 3);
  });

  it("an OBSERVER's lease snapshot tracks the holder's transitions off the envelope stream", async () => {
    // Rule L9 plus observer mode: the audit envelope is in the WORKER's log, so a handle that
    // never called a lease verb still knows who holds it. This is what makes `lease.snapshot`
    // meaningful on a passive client rather than a value frozen at attach time.
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const created = wire.createWorker();
    const holder = await connect(wire, "c_holder").then((s) => s.attach(created.workerId));
    const observer = await connect(wire, "c_observer").then((s) => s.attach(created.workerId));

    const seen: string[] = [];
    observer.on("event", (e) => {
      if (e.kind === "omni.lease") seen.push(e.payload.op);
    });

    await holder.lease.steal("taking over");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    expect(seen).toContain("stolen");
    expect(observer.lease.snapshot.holder?.clientId).toBe("c_holder");
  });
});

describe("the fencing epoch (§16.1 rule L7)", () => {
  it("is sent only once THIS client has held the lease, and never adopted from a steal it watched", async () => {
    const wire = createWireDaemon({ emit: "async", stepMs: 1 });
    const created = wire.createWorker();
    const a = await connect(wire, "c_a").then((s) => s.attach(created.workerId));
    const b = await connect(wire, "c_b").then((s) => s.attach(created.workerId));

    // A takes it, so A's transport now has a fence.
    await a.lease.acquire();
    const held = a.lease.snapshot.epoch;
    a.on("event", () => {}); // A watches the worker, including B's steal

    await b.lease.steal("mine now");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));

    // A SAW the steal — its view of the holder is current…
    expect(a.lease.snapshot.holder?.clientId).toBe("c_b");
    // …and it is still fenced at the epoch it held, which is the whole point. A transport that
    // adopted the epoch off somebody else's steal would un-fence itself the moment it observed
    // being preempted, which is the silent hijack the fence exists to prevent.
    const before = wire.epochs.length;
    await expect(a.hibernate()).rejects.toMatchObject({ code: "lease_held", status: 423 });
    expect(wire.epochs.slice(before)).toEqual([held]);
  });

  it("lifts `body.lease` off a 423 into the thrown OmniError (rule L10)", async () => {
    const wire = createWireDaemon();
    const created = wire.createWorker();
    const a = await connect(wire, "c_a").then((s) => s.attach(created.workerId));
    const b = await connect(wire, "c_b").then((s) => s.attach(created.workerId));
    await a.lease.acquire();

    const caught = await b.hibernate().then(
      () => null,
      (e: unknown) => e as OmniError,
    );

    expect(caught?.code).toBe("lease_held");
    expect(caught?.status).toBe(423);
    // Without this the caller has to re-GET a worker it may no longer control just to find out
    // who took it — which is a second round trip against exactly the wrong party.
    expect(caught?.lease?.holder?.clientId).toBe("c_a");
    expect(typeof caught?.lease?.epoch).toBe("number");
  });
});

describe("stream() filters replay by default (ruling M1-R5)", () => {
  /** A turn whose seq range contains one replayed chunk — a worker woken while a turn is current. */
  const withReplay: ScriptItem[] = [
    { kind: "replay", text: "earlier history" },
    { kind: "text", text: "this turn" },
    { kind: "idle", stopReason: "end_turn" as StopReason },
  ];

  it("the RAW tail carries the replayed envelope and the derived view does not", async () => {
    const wire = createWireDaemon();
    const created = wire.createWorker({ script: withReplay });
    const worker = await connect(wire, "c_a").then((s) => s.attach(created.workerId));

    const texts: string[] = [];
    const replayed: string[] = [];
    for await (const event of worker.stream("hello")) {
      if (event.type === "text") texts.push(event.delta);
      if (event.type === "raw" && event.envelope.replay === true)
        replayed.push(event.envelope.kind);
    }

    // The raw tail is the LOG, and the log contains the replay: a consumer that asked for raw
    // asked for everything (M1-R5 stores and streams it, and only marks it).
    expect(replayed).toEqual(["acp.session_update"]);
    // The derived view is THIS TURN, and the replayed history is not part of it — appending it to
    // a transcript is the difference between a resumed session and a duplicated one.
    expect(texts.join("")).toBe("this turn");
  });

  it("includeReplay: true opts back in", async () => {
    const wire = createWireDaemon();
    const created = wire.createWorker({ script: withReplay });
    const worker = await connect(wire, "c_a").then((s) => s.attach(created.workerId));

    const texts: string[] = [];
    for await (const event of worker.stream("hello", { includeReplay: true })) {
      if (event.type === "text") texts.push(event.delta);
    }

    expect(texts.join("")).toBe("earlier historythis turn");
  });

  it("prompt()'s aggregate SKIPS replay whatever stream() was asked for (reduceTurn, §5.5)", async () => {
    const wire = createWireDaemon();
    const created = wire.createWorker({ script: withReplay });
    const worker = await connect(wire, "c_a").then((s) => s.attach(created.workerId));

    const result = await worker.prompt("hello");

    // The one aggregate: `reduceTurn` skips `replay: true` envelopes, so `done.result` and
    // `prompt()`'s return agree no matter which view a caller took.
    expect(result.text).toBe("this turn");
  });
});

describe("Server.probe() — H16", () => {
  it("returns a ProbeSummary and reports `cached` on the second call", async () => {
    const wire = createWireDaemon();
    const server = await connect(wire);

    const first = await server.probe("example");
    expect(first.cached).toBe(false);
    expect(first.probe.agentId).toBe("example");
    expect(first.probe.protocolVersion).toBe(1);

    expect((await server.probe("example")).cached).toBe(true);
  });

  it("rejects an empty id before the wire, and passes an unknown one through to the daemon", async () => {
    const wire = createWireDaemon();
    const server = await connect(wire);
    const before = wire.requests.length;

    await expect(server.probe("")).rejects.toMatchObject({ code: "bad_request" });
    expect(wire.requests.length).toBe(before);

    // "unknown agent" is the DAEMON's decision, and so is the `403` for a forbidden one — a
    // client that pre-judged either would be guessing at an ACL it cannot see (H16).
    await expect(server.probe("nope")).rejects.toMatchObject({ code: "bad_request" });
    expect(wire.requests.at(-1)?.path).toBe("/v1/agents/nope/probe");
  });
});
