import { OmniACP, OmniError } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf } from "./support/wire-daemon.js";

/**
 * The transport is not exported from the frozen barrel, so it is exercised the way a user
 * reaches it: through `connect()`. These are the properties a caller depends on and cannot see.
 */
describe("transport", () => {
  it("maps an omni error body back to OmniError with the code, status and acp detail intact", async () => {
    const body = {
      code: "agent_error",
      message: "the agent said no",
      acp: { code: -32000, message: "no", data: { why: "policy" } },
    };
    const server = await OmniACP.connect({
      url: "http://x.invalid",
      token: "t",
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        if (request.url.endsWith("/v1/whoami")) {
          return Promise.resolve(
            new Response(JSON.stringify({ tokenId: "t", daemonId: "d_1" }), { status: 200 }),
          );
        }
        return Promise.resolve(new Response(JSON.stringify(body), { status: 502 }));
      },
    });

    await expect(server.info()).rejects.toMatchObject({
      name: "OmniError",
      code: "agent_error",
      status: 502,
      message: "the agent said no",
      acp: { code: -32000, message: "no", data: { why: "policy" } },
    });
  });

  it("falls back to the status when the far end is not an omni daemon", async () => {
    // A reverse proxy's HTML 502 must not become `internal` — the status is still information,
    // and losing it is how "the agent crashed" turns into "something went wrong".
    const server = await OmniACP.connect({
      url: "http://x.invalid",
      token: "t",
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        return Promise.resolve(
          request.url.endsWith("/v1/whoami")
            ? new Response(JSON.stringify({ tokenId: "t" }), { status: 200 })
            : new Response("<html>502 Bad Gateway</html>", { status: 502 }),
        );
      },
    });

    await expect(server.info()).rejects.toMatchObject({ code: "agent_error", status: 502 });
  });

  it("turns its own deadline into agent_timeout and a caller's abort into the caller's reason", async () => {
    const never = new Promise<Response>(() => {});
    const server = await OmniACP.connect({
      url: "http://x.invalid",
      token: "t",
      requestTimeoutMs: 20,
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        if (request.url.endsWith("/v1/whoami")) {
          return Promise.resolve(new Response(JSON.stringify({ tokenId: "t" }), { status: 200 }));
        }
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => {
            reject(request.signal.reason as Error);
          });
          void never;
        });
      },
    });

    await expect(server.info()).rejects.toMatchObject({
      code: "agent_timeout",
      status: 504,
    });
  });

  it("preserves a path prefix, because a daemon can live behind one", async () => {
    // `new URL("/v1/whoami", "http://h/omni")` silently drops `/omni`; concatenation does not.
    const seen: string[] = [];
    await OmniACP.connect({
      url: "http://h.invalid/omni/",
      token: "t",
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        seen.push(new URL(request.url).pathname);
        return Promise.resolve(new Response(JSON.stringify({ tokenId: "t" }), { status: 200 }));
      },
    });
    expect(seen).toEqual(["/omni/v1/whoami"]);
  });

  it("accepts an empty body for a 202 and does not try to parse it", async () => {
    const wire = createWireDaemon();
    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        return request.url.endsWith("/cancel")
          ? Promise.resolve(new Response(null, { status: 202 }))
          : fetchOf(wire.daemon)(request);
      },
    });
    const worker = await server.attach(wire.createWorker().workerId);

    await expect(worker.cancel()).resolves.toBeUndefined();
  });

  it("reports a non-JSON 200 as an OmniError rather than throwing a SyntaxError", async () => {
    const server = await OmniACP.connect({
      url: "http://x.invalid",
      token: "t",
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        return Promise.resolve(
          request.url.endsWith("/v1/whoami")
            ? new Response(JSON.stringify({ tokenId: "t" }), { status: 200 })
            : new Response("not json", { status: 200 }),
        );
      },
    });

    const failure = await server.info().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OmniError);
    expect((failure as OmniError).code).toBe("internal");
  });
});
