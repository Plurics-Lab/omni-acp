import { OmniACP, OmniError } from "@omni-acp/client";
import { describe, expect, it } from "vitest";
import { createWireDaemon, fetchOf } from "./support/wire-daemon.js";

/**
 * WP-6 acceptance 1: the whole SDK runs against an in-process daemon with NO NETWORK AT ALL,
 * and `connect()` issues exactly one request.
 *
 * The single-request property is not a performance note. `GET /v1/whoami` is the one call that
 * tells a client what it may do (DESIGN §8); a client that had to probe several endpoints could
 * observe two different answers and act on the union of them.
 */
describe("OmniACP.connect", () => {
  it("issues exactly one request, GET /v1/whoami, and exposes the answer as server.me", async () => {
    const wire = createWireDaemon();

    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });

    expect(wire.requests).toEqual([{ method: "GET", path: "/v1/whoami" }]);
    expect(server.me.tokenId).toBe("wire");
    expect(server.me.role).toBe("admin");
    expect(server.me.policyCeiling).toBeNull();
    expect(server.daemonId).toBe(wire.daemonId);
    expect(server.url).toBe(wire.url);
  });

  it("touches no socket: every call goes through the injected fetch", async () => {
    const wire = createWireDaemon();
    const server = await OmniACP.connect({
      url: "http://never-resolved.invalid:1",
      token: wire.token,
      fetch: fetchOf(wire.daemon),
    });

    await server.info();
    await server.agents();

    expect(wire.requests.map((r) => r.path)).toEqual(["/v1/whoami", "/v1/info", "/v1/agents"]);
  });

  it("maps an unauthorized answer back to OmniError with the code intact", async () => {
    const wire = createWireDaemon();
    await expect(
      OmniACP.connect({ url: wire.url, token: "wrong", fetch: fetchOf(wire.daemon) }),
    ).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("rejects rather than throwing synchronously when url or token is missing", async () => {
    const wire = createWireDaemon();
    const bad = OmniACP.connect({ url: "", token: wire.token, fetch: fetchOf(wire.daemon) });
    await expect(bad).rejects.toBeInstanceOf(OmniError);
    await expect(bad).rejects.toMatchObject({ code: "bad_request" });

    await expect(
      OmniACP.connect({ url: wire.url, token: "", fetch: fetchOf(wire.daemon) }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("sends the token in the Authorization header and never in the URL", async () => {
    const seen: { url: string; auth: string | null; clientId: string | null }[] = [];
    const wire = createWireDaemon();

    const server = await OmniACP.connect({
      url: wire.url,
      token: wire.token,
      clientId: "c_test",
      fetch: (input, init) => {
        const request =
          input instanceof Request && init === undefined ? input : new Request(input, init);
        seen.push({
          url: request.url,
          auth: request.headers.get("authorization"),
          clientId: request.headers.get("omni-client-id"),
        });
        return fetchOf(wire.daemon)(request);
      },
    });
    const worker = wire.createWorker();
    const handle = await server.attach(worker.workerId);
    const iterator = handle.events()[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const call of seen) {
      expect(call.auth).toBe(`Bearer ${wire.token}`);
      expect(call.clientId).toBe("c_test");
      // Not even for SSE, where a query parameter would be convenient and would land in every
      // proxy log (CONTRACTS.md §8.4).
      expect(call.url).not.toContain(wire.token);
    }
    // The SSE call is in there: this is not passing because only /whoami was made.
    expect(seen.some((c) => c.url.includes("/events?"))).toBe(true);
  });
});
