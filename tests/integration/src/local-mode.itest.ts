import { describe, it } from "vitest";

/**
 * D14 end-to-end. The bad-token 401 is the point: it proves `local()` is real loopback HTTP and
 * not an in-memory shortcut, which is what makes D14 and D15 one code path. WP-6 owns this file.
 */
describe("OmniACP.local()", () => {
  it.todo("starts an embedded daemon on 127.0.0.1:0 and drives the SDK example agent end to end");
  it.todo("exposes server.url matching http://127.0.0.1:\\d+");
  it.todo("returns 401 to a raw fetch with a bad token");
  it.todo("stops the daemon and reclaims the trees on server.close()");
  it.todo("throws a message naming M3 for adopt:'prefer' | 'require' and detach:true");
  it.todo("throws a message naming `npm i @omni-acp/daemon` when the optional peer is absent");
});
