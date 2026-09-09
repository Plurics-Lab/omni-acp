import { client as acpClient } from "@agentclientprotocol/sdk";
import {
  type AcpStream,
  type Logger,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";

export interface AcpLinkHandlers {
  onSessionUpdate(n: { sessionId: string; update: Record<string, unknown> }): void;
  /** MUST resolve or throw acp.RequestError. Throwing anything else maps to -32603. */
  onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  /**
   * M2, D10's second arm. Same rule as `onPermissionRequest`: resolve, or throw
   * `acp.RequestError`. The params arrive VERBATIM — see the registration below.
   *
   * OPTIONAL, so every M1 caller of `openAcpLink` compiles unedited; absent, the method falls
   * through to the SDK's `-32601`, which is exactly M1's behaviour.
   */
  onElicitation?(params: unknown): Promise<unknown>;
  /** Fires exactly once, before `closed` resolves. */
  onClosed(err: Error | null): void;
}

export interface AcpLink {
  request<R = unknown>(method: string, params: unknown): Promise<R>;
  notify(method: string, params: unknown): Promise<void>;
  readonly closed: Promise<void>;
  close(): void;
}

const SESSION_UPDATE = "session/update";
const REQUEST_PERMISSION = "session/request_permission";
const ELICITATION_CREATE = "elicitation/create";

/**
 * The identity params parser.
 *
 * Registering the two inbound methods with a parser of our own instead of the SDK's generated
 * zod schema is deliberate and load-bearing twice over:
 *
 *  - `session/update` must be forwarded BYTE-FOR-BYTE with `_meta` preserved by forwarding the
 *    object rather than rebuilding it (CONTRACTS.md §7.5). `z.object` strips every key the v1
 *    schema does not enumerate, which is the opposite of that.
 *  - `session/request_permission` carries `options[].kind`, which the schema models as a closed
 *    enum. D4 rule 6 requires an UNKNOWN kind to reach the responder so it can be treated as a
 *    non-grant; a schema parse would reject exactly the frame that rule exists for
 *    (`protocol/src/events.ts` makes the same choice for the same reason).
 */
const verbatim = (params: unknown): unknown => params;

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "ACP connection closed");
}

function readNotification(
  params: unknown,
): { sessionId: string; update: Record<string, unknown> } | null {
  if (typeof params !== "object" || params === null) return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  const update = (params as { update?: unknown }).update;
  if (typeof sessionId !== "string") return null;
  if (typeof update !== "object" || update === null) return null;
  // The SAME object, not a copy: identity is what preserves `_meta` and every field this
  // milestone has not enumerated (CONTRACTS.md §7.5).
  return { sessionId, update: update as Record<string, unknown> };
}

/**
 * Wraps an `AgentProcess.stream` in `acp.client(...)`.
 *
 * Unknown agent->client requests are answered `-32601`, never left hanging (DESIGN §6.2) — a
 * silent drop is how a turn ends up waiting forever on an agent that asked us something we do
 * not implement. The SDK's connection does this for every method no handler claims, which is
 * why the two we DO claim are the only ones registered here. `clientCapabilities` is `{}` in M0
 * (D3) — declared by the handshake, not here — so nothing can be asked of us that we would have
 * to refuse.
 */
export function openAcpLink(stream: AcpStream, h: AcpLinkHandlers, o: { logger: Logger }): AcpLink {
  const logger = o.logger.child({ component: "acp-link" });

  let closedFired = false;
  let closedBySelf = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const app = acpClient({ name: "omni-acp" })
    .onNotification(SESSION_UPDATE, verbatim, (ctx) => {
      const n = readNotification(ctx.params);
      if (n === null) {
        logger.warn("dropping a malformed session/update notification");
        return;
      }
      h.onSessionUpdate(n);
    })
    .onRequest(REQUEST_PERMISSION, verbatim, (ctx) =>
      // Rejections are NOT translated here: `acp.RequestError` reaches the wire with its own
      // code, and anything else is mapped to -32603 by the SDK. Wrapping would only hide which
      // of the two happened.
      h.onPermissionRequest(ctx.params as RequestPermissionRequest),
    );

  // M2, ONE registration (M2-PLAN §1.2, hunk 3) — and `verbatim` is the single most important
  // word in it.
  //
  // A `z.object` parse would strip `_meta._askUserQuestionCustomAnswer`, the marker that decides
  // WHICH of two schema properties the agent will actually read (F30: our accept filled both and
  // the agent created `omni-choice.txt` instead of `notes.md`), and it would strip the FLAT
  // `sessionId` / `toolCallId`, which are the only scope this request carries (F29). The same
  // choice is already made for `session/request_permission` (F43), so this is a registration and
  // not a mechanism; the `no-elicitation-schema-parse` guard fails the build on any regression.
  //
  // It is registered UNCONDITIONALLY and gated by the CAPABILITY instead (D10): a handler that
  // appeared and disappeared with a config flag would make "the agent asked anyway" unobservable.
  // With no `onElicitation` supplied the method falls through to the SDK's `-32601`, which is
  // M1's behaviour exactly.
  const onElicitation = h.onElicitation?.bind(h);
  if (onElicitation !== undefined) {
    app.onRequest(ELICITATION_CREATE, verbatim, (ctx) => onElicitation(ctx.params));
  }

  const connection = app.connect(stream);

  void connection.closed.then(() => {
    if (closedFired) return;
    closedFired = true;
    // The SDK resolves `closed` for every ending — EOF, a transport error and our own `close()`
    // alike — and stashes the reason on the connection's signal. `null` means WE asked, which
    // is the distinction the crash classifier needs (CONTRACTS.md §6.7): an in-flight RPC that
    // rejects with a plain `Error("ACP connection closed")` is not evidence of anything.
    const err = closedBySelf ? null : toError(connection.signal.reason);
    try {
      h.onClosed(err);
    } catch (e) {
      logger.error("onClosed handler threw", { error: String(e) });
    } finally {
      resolveClosed();
    }
  });

  return {
    request<R = unknown>(method: string, params: unknown): Promise<R> {
      return connection.agent.request<R>(method, params);
    },

    notify(method: string, params: unknown): Promise<void> {
      return connection.agent.notify(method, params);
    },

    closed,

    close(): void {
      closedBySelf = true;
      connection.close();
    },
  };
}
