import { afterEach, describe, expect, it } from "vitest";
import {
  AcpRequestError,
  type Logger,
  type MappedPermissionRequest,
  type PermissionOption,
  type PolicyEngine,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";
import {
  BUILTIN_POLICIES,
  createPolicyEngine,
  openAcpLink,
  resolvePolicySelection,
  selectOption,
  toPolicySubject,
} from "@omni-acp/core";
import { permissionScript, scriptedAgent, type ScriptedAgent } from "@omni-acp/testkit";
import { ALLOW_ALWAYS, ALLOW_ONCE, OPTION, REJECT_ONCE, identityRealpath } from "./support.js";

/**
 * §20.1's chain over a REAL JSON-RPC link, with menus no real agent sends.
 *
 * The unit tables prove each box; this file proves the wire between them — that an answer the
 * engine could not select leaves the link as JSON-RPC `-32603` and not as an invented id, a
 * cancelled turn, or a hang. `permissionScript` is the fixture that makes the three degenerate
 * menus reachable at all: no agent offers an empty menu, an unknown-kind-only menu, or an
 * `allow_always`-only one, and those are exactly the rows D4 rules 3, 4 and 6 exist for.
 *
 * Owned by M2-B-WP-P.
 */

const silent: Logger = {
  child: () => silent,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const engineFor = (preset: string): PolicyEngine => {
  const policy = resolvePolicySelection(preset, BUILTIN_POLICIES, "deny-all");
  return createPolicyEngine({ policy, ceiling: null, id: policy.id });
};

interface Wired {
  readonly agent: ScriptedAgent;
  readonly close: () => void;
  readonly decisions: readonly { action: string; rule: string }[];
}

const open = new Set<() => void>();

afterEach(() => {
  for (const close of open) close();
  open.clear();
});

async function wire(engine: PolicyEngine): Promise<Wired> {
  const agent = scriptedAgent({ name: "policy-wire" });
  const decisions: { action: string; rule: string }[] = [];

  const link = openAcpLink(
    agent.stream,
    {
      onSessionUpdate() {
        /* not this file's business */
      },
      async onPermissionRequest(req: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        const raw = req as unknown as {
          toolCall?: Record<string, unknown>;
          options?: readonly PermissionOption[];
        };
        const mapped: MappedPermissionRequest = {
          sessionId: "s",
          title: String(raw.toolCall?.["title"] ?? ""),
          subject: { type: "tool_call", toolCall: raw.toolCall ?? {} },
          options: raw.options ?? [],
          toolCallId: String(raw.toolCall?.["toolCallId"] ?? ""),
          raw: req as unknown as Record<string, unknown>,
        };
        const verdict = engine.decide(
          await toPolicySubject(
            {
              id: "x_1" as never,
              kind: "permission",
              method: "session/request_permission",
              title: mapped.title,
              message: null,
              subject: mapped.subject,
              options: mapped.options,
              fields: [],
              toolCallId: mapped.toolCallId,
              turnId: null,
              raw: mapped.raw,
            },
            { cwd: "/repo", agentId: "policy-wire", realpath: identityRealpath },
          ),
        );
        decisions.push({ action: verdict.action, rule: verdict.rule });

        const choice = selectOption(verdict.action === "allow" ? "allow" : "deny", mapped.options, {
          allowSessionGrants: true,
        });
        if (choice.optionId === null) {
          throw AcpRequestError.internalError(
            { offered: mapped.options },
            "no acceptable permission option was offered",
          );
        }
        return { outcome: { outcome: "selected", optionId: choice.optionId } };
      },
      onClosed() {
        /* the link is closed below */
      },
    },
    { logger: silent },
  );

  await link.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await link.request("session/new", { cwd: "/repo", mcpServers: [] });

  const close = (): void => {
    link.close();
    agent.die();
  };
  open.add(close);
  return { agent, close, decisions };
}

describe("permissionScript over a real link — the three menus no agent sends", () => {
  it("an allow_always-only menu is answered -32603, even when the policy said ALLOW", async () => {
    const w = await wire(engineFor("full"));
    expect(await permissionScript(w.agent, [ALLOW_ALWAYS])).toBeNull();
    // The engine WANTED to allow, which is what makes rule 3 the thing under test rather than
    // an accident of a denying policy.
    expect(w.decisions.map((d) => d.action)).toEqual(["allow"]);
  });

  it("an EMPTY menu is answered -32603", async () => {
    const w = await wire(engineFor("full"));
    expect(await permissionScript(w.agent, [])).toBeNull();
  });

  it("an unknown-kind-only menu is answered -32603 (D4 rule 6, fail closed)", async () => {
    const w = await wire(engineFor("full"));
    expect(await permissionScript(w.agent, [OPTION("weird", "a_kind_nobody_models")])).toBeNull();
  });

  it("a normal menu under `full` selects the offered grant", async () => {
    const w = await wire(engineFor("full"));
    expect(await permissionScript(w.agent, [ALLOW_ONCE, REJECT_ONCE, ALLOW_ALWAYS])).toBe("allow");
  });

  it("the same menu under `readonly` selects the offered rejection, for an EDIT", async () => {
    // `permissionScript` sends a `kind:"edit"` tool call, which `readonly` does not grant.
    const w = await wire(engineFor("readonly"));
    expect(await permissionScript(w.agent, [ALLOW_ONCE, REJECT_ONCE])).toBe("reject");
    expect(w.decisions.map((d) => d.action)).toEqual(["deny"]);
  });

  it("a deny with no rejection on the menu is -32603, never a cancelled turn (rule 5)", async () => {
    const w = await wire(engineFor("readonly"));
    expect(await permissionScript(w.agent, [ALLOW_ONCE])).toBeNull();
  });

  it("permissionScript REFUSES to read a cancelled answer as rule 4's -32603", async () => {
    // The fixture's own guarantee: a strategy that cancelled would be reported, not folded into
    // the `null` that means "the client correctly refused to answer".
    const agent = scriptedAgent({ name: "cancels" });
    const link = openAcpLink(
      agent.stream,
      {
        onSessionUpdate() {
          /* unused */
        },
        onPermissionRequest(): Promise<RequestPermissionResponse> {
          return Promise.resolve({
            outcome: { outcome: "cancelled" },
          } as RequestPermissionResponse);
        },
        onClosed() {
          /* unused */
        },
      },
      { logger: silent },
    );
    open.add(() => {
      link.close();
      agent.die();
    });
    await link.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await link.request("session/new", { cwd: "/repo", mcpServers: [] });

    await expect(permissionScript(agent, [ALLOW_ONCE])).rejects.toThrow(/rule 5/);
  });
});
