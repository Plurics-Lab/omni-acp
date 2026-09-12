import {
  CredentialCheckBody,
  CredentialInput,
  RestartRequestBody,
  SetCredentialBody,
} from "@omni-acp/protocol";
import type { Context, Hono } from "hono";
import type { Daemon } from "../../types.js";
import { authMiddleware, authOf } from "../auth-middleware.js";
import { readJson, workerId } from "./index.js";

/**
 * M3-WP1's seven routes (docs/M3-WP1-CREDENTIALS.md §线上协议).
 *
 * Five on `/v1/credentials` and two on a worker, in ONE module beside `workers.ts` — which is M1's
 * routes split reused unchanged, so this work package adds routes without editing a frozen file.
 *
 * Same three moves as everything else under `http/`: parse with zod, call ONE daemon method,
 * serialize. Every decision this feature makes is somewhere else on purpose:
 *
 *  - ownership (`403 credential_forbidden`) is the STORE's, because it is the path;
 *  - the transport check (`403 insecure_transport`) is the STORE's, because it is the one place
 *    that knows a body carries a plaintext secret;
 *  - `409` for a credential in use is the STORE's, because only it can count the links;
 *  - the lease gate and the state checks on the two worker routes are the HANDLE's, exactly as
 *    they are for `prompt`, `answer` and `setConfig`.
 *
 * A route that made any of them would be the adapter deciding policy, and `http-has-no-logic`
 * would say so.
 */
export function registerCredentialRoutes(app: Hono, daemon: Daemon): void {
  const auth = authMiddleware(daemon);

  // GET /v1/credentials — this token's credentials; an admin's answer covers the machine, with
  // every content still unreadable (D13, §凭据仓库: admin 可 list 不可读内容).
  app.get("/v1/credentials", auth, async (c) =>
    c.json(await daemon.credentials.list(authOf(c.req.raw))),
  );

  /**
   * PUT /v1/credentials/{agent}/{name} — create, or UPDATE IN PLACE.
   *
   * The body is the one request in the repository that carries a plaintext secret, which is why
   * the store refuses it over a non-loopback, non-TLS connection. The RESULT is a summary plus
   * `workersAffected` / `restartRequired`, because an in-place update re-points nothing by itself:
   * every live worker's home already links at the file that just changed.
   */
  app.put("/v1/credentials/:agent/:name", auth, async (c) =>
    c.json(
      await daemon.credentials.put(
        authOf(c.req.raw),
        agentOf(c),
        nameOf(c),
        CredentialInput.parse(await readJson(c)),
      ),
    ),
  );

  app.get("/v1/credentials/:agent/:name", auth, async (c) =>
    c.json(await daemon.credentials.get(authOf(c.req.raw), agentOf(c), nameOf(c))),
  );

  // `200 {}` rather than `204`: the body is where a future field goes, and M1's `DELETE
  // /v1/workers/{wid}` set the precedent for the same reason (§6.6, D32).
  app.delete("/v1/credentials/:agent/:name", auth, async (c) => {
    await daemon.credentials.remove(authOf(c.req.raw), agentOf(c), nameOf(c));
    return c.json({});
  });

  // An empty body is legal — both fields of `CredentialCheckBody` are optional — so a bare POST
  // with no content-type must not be a 400 (the `optionalJson` rule `agents.ts` already sets).
  app.post("/v1/credentials/:agent/:name/check", auth, async (c) =>
    c.json(
      await daemon.credentials.check(
        authOf(c.req.raw),
        agentOf(c),
        nameOf(c),
        CredentialCheckBody.parse(await optionalJson(c)),
      ),
    ),
  );

  // PUT /v1/workers/{wid}/credential → `200 CredentialApplied`.
  app.put("/v1/workers/:wid/credential", auth, async (c) =>
    c.json(
      await daemon.workers.setCredential(
        workerId(c),
        authOf(c.req.raw),
        SetCredentialBody.parse(await readJson(c)),
      ),
    ),
  );

  // POST /v1/workers/{wid}/restart → `200 RestartResult`. Every other answer — `409 worker_busy`
  // for a live turn with no `force`, `422 not_resumable`, `423 lease_held`, `410 worker_closed` —
  // is an `OmniError` the registry throws and the ONE mapper turns into a status (§9).
  app.post("/v1/workers/:wid/restart", auth, async (c) =>
    c.json(
      await daemon.workers.restart(
        workerId(c),
        authOf(c.req.raw),
        RestartRequestBody.parse(await optionalJson(c)),
      ),
    ),
  );
}

/**
 * The two path parameters, read the way every other route reads one.
 *
 * They are NOT validated here beyond being non-empty: an agent id is whatever an operator
 * configured and a credential name's shape is the STORE's rule (`assertName`), enforced in one
 * place so that the in-process entry point and the wire cannot diverge. The `?? ""` is the same
 * line `workerId()` carries — the router types every param as possibly absent, and an empty string
 * is exactly what the downstream check rejects.
 */
function agentOf(c: Context): string {
  return c.req.param("agent") ?? "";
}

function nameOf(c: Context): string {
  return c.req.param("name") ?? "";
}

/** `agents.ts`'s rule, and the same reason: a call with NOTHING to configure need send no body. */
async function optionalJson(c: Context): Promise<unknown> {
  const contentType = c.req.header("content-type");
  if (contentType === undefined || contentType.trim() === "") return {};
  return await readJson(c);
}
