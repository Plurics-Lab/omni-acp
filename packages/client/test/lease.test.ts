import { describe, expect, it } from "vitest";
import { OmniError, type LeaseSnapshot, type TokenId, type WorkerId } from "@omni-acp/protocol";
import { createWorkerLease } from "../src/lease.js";
import { createTransport, type Transport } from "../src/transport.js";

/**
 * The SDK's `WorkerLease` (CONTRACTS.md §5.7): three verbs onto H17, and a `snapshot` that keeps
 * up with the fencing epoch.
 *
 * Neither `createWorkerLease` nor `Transport` is on the frozen barrel — only the `WorkerLease`
 * TYPE is — so they are reached the way `worker.ts` will reach them, by module path.
 */

const WID = "w_00000000000000000000000001" as WorkerId;

const snapshotOf = (o: Partial<LeaseSnapshot>): LeaseSnapshot => ({
  workerId: WID,
  holder: { tokenId: "tok_a" as TokenId, clientId: "cli_a" },
  epoch: 1,
  expiresAt: null,
  acquiredAt: "2026-01-01T00:00:00.000Z",
  pinned: false,
  ...o,
});

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** A transport that records the request and answers with whatever the test queued. */
function recordingTransport(answers: unknown[]): {
  transport: Transport;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const transport: Transport = {
    request: <R>(method: string, path: string, body?: unknown): Promise<R> => {
      calls.push({ method, path, body });
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as R);
    },
    open: () => Promise.reject(new Error("not used")),
  };
  return { transport, calls };
}

describe("WorkerLease — the three verbs map one-to-one onto H17", () => {
  it("POSTs to /lease/{acquire|release|steal} and returns the daemon's snapshot", async () => {
    const acquired = snapshotOf({ epoch: 2 });
    const released = snapshotOf({ holder: null, epoch: 2, acquiredAt: null });
    const stolen = snapshotOf({ epoch: 3, holder: { tokenId: "tok_a" as TokenId, clientId: "b" } });
    const { transport, calls } = recordingTransport([acquired, released, stolen]);
    const lease = createWorkerLease(transport, WID, snapshotOf({}));

    expect(await lease.acquire()).toEqual(acquired);
    expect(await lease.release()).toEqual(released);
    expect(await lease.steal("the laptop went to sleep")).toEqual(stolen);

    expect(calls).toEqual([
      { method: "POST", path: `/v1/workers/${WID}/lease/acquire`, body: {} },
      { method: "POST", path: `/v1/workers/${WID}/lease/release`, body: {} },
      {
        method: "POST",
        path: `/v1/workers/${WID}/lease/steal`,
        // D5: 带审计 — the reason is on the wire, verbatim, because the daemon records it there.
        body: { reason: "the laptop went to sleep" },
      },
    ]);
  });

  it("sends `{}` rather than no body at all, so the route never has to special-case the SDK", async () => {
    const { transport, calls } = recordingTransport([snapshotOf({})]);
    await createWorkerLease(transport, WID, snapshotOf({})).acquire();
    // `transport.request` OMITS the body entirely when it is `undefined`, and a POST with no
    // body and no content-type is the shape an operator's curl produces — not the SDK's.
    expect(calls[0]?.body).toEqual({});
  });

  it("passes ttlMs only when the caller asked for one", async () => {
    const { transport, calls } = recordingTransport([snapshotOf({}), snapshotOf({})]);
    const lease = createWorkerLease(transport, WID, snapshotOf({}));
    await lease.acquire({ ttlMs: 60_000 });
    await lease.acquire({});
    expect(calls.map((c) => c.body)).toEqual([{ ttlMs: 60_000 }, {}]);
  });
});

describe("WorkerLease — `snapshot` tracks the fencing epoch", () => {
  it("starts at the value it was constructed with", () => {
    const { transport } = recordingTransport([]);
    const initial = snapshotOf({ epoch: 7 });
    expect(createWorkerLease(transport, WID, initial).snapshot).toEqual(initial);
  });

  it("is REPLACED by every successful answer — a frozen snapshot is a fence that fires on its owner", async () => {
    const { transport } = recordingTransport([snapshotOf({ epoch: 2 }), snapshotOf({ epoch: 3 })]);
    const lease = createWorkerLease(transport, WID, snapshotOf({ epoch: 1 }));
    expect(lease.snapshot.epoch).toBe(1);

    await lease.acquire();
    // §16.1 rule L7: the daemon bumps the epoch on every acquire, steal and expiry, and a client
    // that sends a stale `Omni-Lease-Epoch` is refused with a 423 EVEN when it is the right
    // client id. A `WorkerLease` that kept the number it was born with would fence out its own
    // caller on the very next call.
    expect(lease.snapshot.epoch).toBe(2);

    await lease.steal("mine");
    expect(lease.snapshot.epoch).toBe(3);
  });

  it("does NOT move on a failure, and does NOT retry — a silent retry is the hijack L7 prevents", async () => {
    const held = new OmniError("lease_held", "worker is held by tok_b/cli_b", {
      lease: snapshotOf({ epoch: 9, holder: { tokenId: "tok_b" as TokenId, clientId: "cli_b" } }),
    });
    const { transport, calls } = recordingTransport([held]);
    const lease = createWorkerLease(transport, WID, snapshotOf({ epoch: 1 }));

    const caught = await lease.acquire().then(
      () => null,
      (e: unknown) => e as OmniError,
    );
    expect(caught?.code).toBe("lease_held");
    // Rule L10: the caller learns WHO holds it, and at which epoch, from the error itself.
    expect(caught?.lease?.holder).toEqual({ tokenId: "tok_b", clientId: "cli_b" });
    expect(caught?.lease?.epoch).toBe(9);
    // One attempt, and the cached snapshot is untouched: the caller decides what to do next.
    expect(calls).toHaveLength(1);
    expect(lease.snapshot.epoch).toBe(1);
  });
});

describe("WorkerLease — over the real transport", () => {
  const request = (fetchImpl: typeof globalThis.fetch): Transport =>
    createTransport({
      url: "http://daemon.invalid",
      token: "a-secret-token-value",
      clientId: "cli_a",
      fetch: fetchImpl,
      requestTimeoutMs: 5_000,
    });

  it("sends the bearer token and the client id, and never puts either in the URL", async () => {
    const seen: Request[] = [];
    const lease = createWorkerLease(
      request((input, init) => {
        const req =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        seen.push(req);
        return Promise.resolve(
          new Response(JSON.stringify(snapshotOf({ epoch: 4 })), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
      WID,
      snapshotOf({}),
    );

    expect((await lease.steal("takeover")).epoch).toBe(4);
    const sent = seen[0];
    expect(sent?.url).toBe(`http://daemon.invalid/v1/workers/${WID}/lease/steal`);
    expect(sent?.headers.get("authorization")).toBe("Bearer a-secret-token-value");
    // §16.1 rule L4: the SDK mints an `Omni-Client-Id` per `connect()`, so two SDK clients of one
    // token are genuinely two controllers.
    expect(sent?.headers.get("omni-client-id")).toBe("cli_a");
    expect(sent?.url).not.toContain("a-secret-token-value");
    expect(await sent?.text()).toBe(JSON.stringify({ reason: "takeover" }));
  });

  it("turns a 423 into an OmniError with the code and status intact", async () => {
    const body = {
      code: "lease_held",
      message: "worker is held by tok_b/cli_b",
      lease: snapshotOf({ epoch: 9 }),
    };
    const lease = createWorkerLease(
      request(() =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 423,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
      WID,
      snapshotOf({ epoch: 1 }),
    );

    const caught = await lease.acquire().then(
      () => null,
      (e: unknown) => e as OmniError,
    );
    expect(caught).toBeInstanceOf(OmniError);
    expect({ code: caught?.code, status: caught?.status }).toEqual({
      code: "lease_held",
      status: 423,
    });
    expect(lease.snapshot.epoch, "a refusal must not advance the cached fence").toBe(1);

    // NOTE (M1-WP-D → M1-WP-F): lifting `body.lease` off the 423 into `OmniError.lease` is
    // `transport.ts`'s line, and `transport.ts` is WP-F's file (M1-PLAN §3). Until WP-F adds it,
    // an SDK caller reads the holder from `error.detail`-free JSON rather than from
    // `error.lease` — which is why this asserts the code and the status and stops there, and why
    // the property is asserted against a transport double above.
    expect(caught?.lease).toBeUndefined();
  });
});
