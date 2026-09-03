import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import { openAcpLink, type AcpLink, type AcpLinkHandlers } from "@omni-acp/core";
import {
  AcpRequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";
import { memoryStreamPair, nullLogger } from "@omni-acp/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Peer {
  readonly link: AcpLink;
  /** The agent side of the same wire. */
  readonly cx: {
    request<R = unknown>(m: string, p?: unknown): Promise<R>;
    notify(m: string, p?: unknown): Promise<void>;
  };
  readonly updates: { sessionId: string; update: Record<string, unknown> }[];
  readonly permissions: RequestPermissionRequest[];
  readonly closes: (Error | null)[];
  closeAgent(err?: Error): void;
}

const links: AcpLink[] = [];

function peer(o?: {
  onPermission?: (req: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}): Peer {
  const [clientSide, agentSide] = memoryStreamPair();
  const updates: { sessionId: string; update: Record<string, unknown> }[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const closes: (Error | null)[] = [];

  const app = acpAgent({ name: "peer-agent" })
    .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .onRequest("session/new", () => ({ sessionId: "sess_peer" }));
  const connection = app.connect(agentSide);

  const handlers: AcpLinkHandlers = {
    onSessionUpdate: (n) => updates.push(n),
    onPermissionRequest: async (req) => {
      permissions.push(req);
      if (o?.onPermission !== undefined) return o.onPermission(req);
      return { outcome: { outcome: "selected", optionId: "reject" } };
    },
    onClosed: (err) => closes.push(err),
  };

  const link = openAcpLink(clientSide, handlers, { logger: nullLogger() });
  links.push(link);

  return {
    link,
    cx: {
      request: <R = unknown>(m: string, p?: unknown): Promise<R> =>
        connection.client.request<R>(m, p),
      notify: (m: string, p?: unknown): Promise<void> => connection.client.notify(m, p),
    },
    updates,
    permissions,
    closes,
    closeAgent(err) {
      connection.close(err);
    },
  };
}

afterEach(() => {
  for (const l of links.splice(0)) l.close();
});

describe("openAcpLink — requests and notifications", () => {
  it("round-trips a client->agent request", async () => {
    const p = peer();
    await expect(p.link.request("initialize", { protocolVersion: 1 })).resolves.toEqual({
      protocolVersion: 1,
      agentCapabilities: {},
    });
  });

  it("surfaces an agent's JSON-RPC error as acp.RequestError, with its code intact", async () => {
    const p = peer();
    await expect(p.link.request("session/load", {})).rejects.toMatchObject({ code: -32601 });
    await expect(p.link.request("session/load", {})).rejects.toBeInstanceOf(AcpRequestError);
  });

  it("notify resolves without waiting for a response", async () => {
    const p = peer();
    await expect(
      p.link.notify("session/cancel", { sessionId: "sess_peer" }),
    ).resolves.toBeUndefined();
  });
});

describe("openAcpLink — inbound from the agent", () => {
  it("forwards session/update by OBJECT IDENTITY, `_meta` and unknown fields intact (§7.5)", async () => {
    const p = peer();
    const update = {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" },
      _meta: { vendor: { trace: "abc" } },
      vendorOnlyField: 42,
    };
    await p.cx.notify("session/update", { sessionId: "sess_peer", update });

    expect(p.updates).toHaveLength(1);
    const received = p.updates[0]!;
    expect(received.sessionId).toBe("sess_peer");
    // Deep equality is not enough: a rebuilt object would drop `vendorOnlyField` and could keep
    // `_meta` only by accident. The contract is "forward the object, do not rebuild it".
    expect(received.update["_meta"]).toEqual({ vendor: { trace: "abc" } });
    expect(received.update["vendorOnlyField"]).toBe(42);
  });

  it("M0 LIMITATION: an update whose `sessionUpdate` the v1 schema does not know is dropped", async () => {
    // Pinned rather than papered over. `acp.client()` installs a session-update router that
    // parses every `session/update` against the v1 schema BEFORE any handler runs, so a vendor
    // extension never reaches us and §7.5's "forwarded byte-for-byte" has this one hole. M0 sees
    // no such traffic (§2.3 defers the vendor-extension registry to M1/M2); this test is here so
    // that whoever implements it discovers the constraint from a failing expectation and not
    // from a missing event in production.
    const noise = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const p = peer();
      await p.cx.notify("session/update", {
        sessionId: "sess_peer",
        update: { sessionUpdate: "vendor/thinking_harder", intensity: 11 },
      });
      await p.cx.notify("session/update", {
        sessionId: "sess_peer",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
      });
      expect(p.updates).toHaveLength(1);
      expect(p.updates[0]!.update["sessionUpdate"]).toBe("agent_message_chunk");
    } finally {
      noise.mockRestore();
    }
  });

  it("routes session/request_permission to the handler and returns its answer", async () => {
    const p = peer();
    const answer = await p.cx.request<{ outcome: { outcome: string; optionId: string } }>(
      "session/request_permission",
      {
        sessionId: "sess_peer",
        toolCall: { toolCallId: "call_1", title: "Write" },
        options: [{ optionId: "reject", name: "No", kind: "reject_once" }],
      },
    );
    expect(answer.outcome).toEqual({ outcome: "selected", optionId: "reject" });
    expect(p.permissions).toHaveLength(1);
  });

  it("delivers a permission request whose option `kind` the v1 schema does not know (D4 rule 6)", async () => {
    const p = peer();
    void p.cx.request("session/request_permission", {
      sessionId: "sess_peer",
      toolCall: { toolCallId: "call_1", title: "Write" },
      options: [{ optionId: "x", name: "X", kind: "allow_forever_and_ever" }],
    });
    await new Promise<void>((r) => setImmediate(r));
    // A schema parse would have rejected this frame outright, and rule 6 would be untestable.
    expect(p.permissions[0]?.options[0]?.kind).toBe("allow_forever_and_ever" as never);
  });

  it("maps a thrown acp.RequestError to that JSON-RPC code (D4 rule 4's -32603)", async () => {
    const p = peer({
      onPermission: () => {
        throw AcpRequestError.internalError({}, "nothing acceptable offered");
      },
    });
    await expect(
      p.cx.request("session/request_permission", {
        sessionId: "sess_peer",
        toolCall: { toolCallId: "c" },
        options: [],
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("maps a thrown NON-RequestError to -32603 as well, never a hang", async () => {
    const p = peer({
      onPermission: () => Promise.reject(new Error("boom")),
    });
    await expect(
      p.cx.request("session/request_permission", {
        sessionId: "sess_peer",
        toolCall: { toolCallId: "c" },
        options: [],
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("answers an UNREGISTERED agent->client request with -32601, never silence (DESIGN §6.2)", async () => {
    const p = peer();
    // fs/read_text_file is a real ACP client method we deliberately do not implement (D3).
    await expect(p.cx.request("fs/read_text_file", { path: "/etc/passwd" })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(p.cx.request("terminal/create", { command: "sh" })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(p.cx.request("vendor/whatever", {})).rejects.toMatchObject({ code: -32601 });

    // ...and the link is still usable afterwards, which is the whole point of not hanging.
    await expect(p.link.request("session/new", { cwd: "/tmp", mcpServers: [] })).resolves.toEqual({
      sessionId: "sess_peer",
    });
  });
});

describe("openAcpLink — closing", () => {
  it("fires onClosed exactly once, BEFORE `closed` resolves, with null when we closed", async () => {
    const p = peer();
    let closedResolvedWhileEmpty = false;
    const observed = p.link.closed.then(() => {
      closedResolvedWhileEmpty = p.closes.length === 0;
    });
    p.link.close();
    p.link.close();
    await observed;
    expect(closedResolvedWhileEmpty).toBe(false);
    expect(p.closes).toEqual([null]);
  });

  it("reports a transport EOF as an Error, not as our own close", async () => {
    // The real shape of an agent dying: its stdout reaches EOF. Built by hand rather than with
    // `peer()` because an SDK peer's `close()` does NOT end its writable — which is precisely
    // why the crash classifier watches the PROCESS and not the link (§6.7).
    const agentToClient = new TransformStream();
    const clientToAgent = new TransformStream();
    const closes: (Error | null)[] = [];
    const link = openAcpLink(
      { writable: clientToAgent.writable, readable: agentToClient.readable } as never,
      {
        onSessionUpdate: () => {},
        onPermissionRequest: () => Promise.reject(new RequestError(-32603, "no")),
        onClosed: (err) => closes.push(err),
      },
      { logger: nullLogger() },
    );
    links.push(link);

    await agentToClient.writable.close();
    await link.closed;
    expect(closes).toHaveLength(1);
    expect(closes[0]).toBeInstanceOf(Error);
  });

  it("rejects an in-flight request with a plain Error carrying no JSON-RPC code (§6.7)", async () => {
    const p = peer();
    const inflight = p.link.request("session/prompt", { sessionId: "sess_peer", prompt: [] });
    p.link.close();
    const err = await inflight.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    // This is exactly why the crash classifier refuses to classify from it: no code, no verdict.
    expect(err).not.toBeInstanceOf(AcpRequestError);
    expect((err as { code?: unknown }).code).toBeUndefined();
  });

  it("survives an onClosed handler that throws", async () => {
    const [clientSide] = memoryStreamPair();
    const link = openAcpLink(
      clientSide,
      {
        onSessionUpdate: () => {},
        onPermissionRequest: () => Promise.reject(new RequestError(-32603, "no")),
        onClosed: () => {
          throw new Error("listener blew up");
        },
      },
      { logger: nullLogger() },
    );
    link.close();
    await expect(link.closed).resolves.toBeUndefined();
  });
});
