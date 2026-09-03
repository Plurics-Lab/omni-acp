import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HEADER } from "@omni-acp/protocol";
import { fakeSupervisor, nullLogger, seqIds } from "@omni-acp/testkit";
import { createDaemon } from "../../src/create-daemon.js";
import type { Daemon } from "../../src/types.js";
import { someWorkerId } from "../fake-core.js";

vi.mock("@omni-acp/core", async (importOriginal) => {
  const { fakeCoreModule } = await import("./../fake-core.js");
  return await fakeCoreModule(importOriginal as never);
});

const SECRET = "the-only-valid-secret-0123456789";
const WID = someWorkerId(1);

/** Every authenticated route, addressed with a well-formed id so auth is what decides. */
const AUTHENTICATED: { method: string; path: string }[] = [
  { method: "GET", path: "/v1/info" },
  { method: "GET", path: "/v1/whoami" },
  { method: "GET", path: "/v1/agents" },
  { method: "GET", path: "/v1/workers" },
  { method: "POST", path: "/v1/workers" },
  { method: "GET", path: `/v1/workers/${WID}` },
  { method: "POST", path: `/v1/workers/${WID}/prompt` },
  { method: "POST", path: `/v1/workers/${WID}/cancel` },
  { method: "GET", path: `/v1/workers/${WID}/events` },
  { method: "GET", path: `/v1/workers/${WID}/turns/t_${"0".repeat(25)}1` },
  { method: "DELETE", path: `/v1/workers/${WID}` },
];

async function daemonWithToken(): Promise<Daemon> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "omni-http-auth-")));
  return await createDaemon(
    {
      dataDir: join(root, "data"),
      listen: null,
      tokens: [{ id: "local", secret: SECRET, role: "admin", cwdRoots: [root] }],
      logLevel: "silent",
    },
    { supervisor: fakeSupervisor(), ids: seqIds(), logger: nullLogger() },
  );
}

const call = (
  daemon: Daemon,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<Response> =>
  daemon.fetch(new Request(`http://daemon.invalid${path}`, { method, headers }));

describe("auth over the wire (H13, acceptance 4)", () => {
  it("answers 401 {code:'unauthorized'} for missing / malformed / unknown / near-miss secrets", async () => {
    const daemon = await daemonWithToken();
    const headers: Record<string, string>[] = [
      {},
      { [HEADER.auth]: SECRET },
      { [HEADER.auth]: `Basic ${SECRET}` },
      { [HEADER.auth]: "Bearer" },
      { [HEADER.auth]: `Bearer ${SECRET}x` },
      { [HEADER.auth]: `Bearer ${SECRET.slice(0, -1)}` },
    ];
    for (const route of AUTHENTICATED) {
      for (const h of headers) {
        const res = await call(daemon, route.method, route.path, h);
        expect({ route: route.path, status: res.status }).toEqual({
          route: route.path,
          status: 401,
        });
        const body = (await res.json()) as { code: string; message: string };
        expect(body.code).toBe("unauthorized");
        // The secret never travels back out, not even in the failure it caused.
        expect(JSON.stringify(body)).not.toContain(SECRET.slice(0, 12));
      }
    }
    await daemon.stop();
  });

  it("lets the right secret through — auth is the only thing the loop above changed", async () => {
    const daemon = await daemonWithToken();
    const res = await call(daemon, "GET", "/v1/whoami", { [HEADER.auth]: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tokenId: "local", role: "admin" });
    await daemon.stop();
  });

  it("is re-evaluated per request: removing the token 401s the very next call (acceptance 5)", async () => {
    const daemon = await daemonWithToken();
    const headers = { [HEADER.auth]: `Bearer ${SECRET}` };
    expect((await call(daemon, "GET", "/v1/info", headers)).status).toBe(200);
    daemon.config.tokens.length = 0;
    expect((await call(daemon, "GET", "/v1/info", headers)).status).toBe(401);
    await daemon.stop();
  });

  it("never accepts a token from the query string — header only (§8.4)", async () => {
    const daemon = await daemonWithToken();
    const res = await daemon.fetch(
      new Request(`http://daemon.invalid/v1/workers/${WID}/events?token=${SECRET}`),
    );
    expect(res.status).toBe(401);
    await daemon.stop();
  });

  it("keeps /v1/health as the ONLY unauthenticated route", async () => {
    const daemon = await daemonWithToken();
    const health = await daemon.fetch(new Request("http://daemon.invalid/v1/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    // Nothing else answers without a token — asserted by the loop above over every other route.
    await daemon.stop();
  });

  it("rejects an over-long Omni-Client-Id with 400 rather than recording it", async () => {
    const daemon = await daemonWithToken();
    const res = await call(daemon, "GET", "/v1/whoami", {
      [HEADER.auth]: `Bearer ${SECRET}`,
      [HEADER.clientId]: "x".repeat(500),
    });
    expect(res.status).toBe(400);
    await daemon.stop();
  });

  it("answers 401 — not 400 — when the secret is wrong AND the client id is over-long", async () => {
    // Auth is decided FIRST (§9). An anonymous caller learns only that it is unauthenticated; the
    // 400 about header bounds is reachable only once a valid secret has been presented.
    const daemon = await daemonWithToken();
    const res = await call(daemon, "GET", "/v1/whoami", {
      [HEADER.auth]: "Bearer totally-wrong-secret-xxxxxxxxxx",
      [HEADER.clientId]: "x".repeat(300),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthorized" });
    await daemon.stop();
  });
});
