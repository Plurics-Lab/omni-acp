import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, realpath as fsRealpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AcpRequestError,
  DaemonConfig,
  OmniError,
  PolicyCeiling,
  PolicySelection,
  type Logger,
  type MappedPermissionRequest,
  type PermissionOption,
  type PolicyVerdict,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResolvedDaemonConfig,
  type TurnWarning,
} from "@omni-acp/protocol";
import {
  BUILTIN_POLICIES,
  createPolicyEngine,
  openAcpLink,
  resolvePolicySelection,
  selectOption,
  toPolicySubject,
} from "@omni-acp/core";
import { yamlToDaemonConfig } from "@omni-acp/cli";
import { fixtureAgentPath } from "@omni-acp/testkit";

/**
 * D4's ceiling, at the boundary a client actually meets: `403 policy_exceeds_ceiling` at CREATE,
 * and a runtime clamp that is never silent — plus the two things a unit test cannot show, which
 * is why they are here:
 *
 *  - **the presets really do load from YAML, as data.** §20.4 writes them in YAML and WP-P
 *    acceptance 7 says they load from it; D15 constraint 3 says YAML lives in `@omni-acp/cli` and
 *    nowhere else. So the operator's own door — `yamlToDaemonConfig` — is the one this asserts
 *    through, and it proves the shipped objects are exactly what a config file parses to.
 *  - **the whole of §20.1's chain against a REAL agent process**: a fixture that offers only a
 *    persistent grant, over real ndJSON pipes, answered `-32603` and nothing else (D4 rules 3
 *    and 4, F26).
 *
 * `403 at create` is asserted through `resolvePolicyForRequest` rather than through
 * `POST /v1/workers`, because `AuthContext.assertPolicy`'s body is M2-WP-J's join and still
 * throws `unimplemented` — the wiring is one line and it is recorded in this work package's
 * notes. Everything the route would return is asserted on the error's own body, which is what
 * the route serializes.
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

/**
 * §20.4's YAML, transcribed into a real config file — the four documents plus the contained
 * variant, written the way an operator would write them.
 *
 * `path` is a LIST here where §20.4 writes a scalar for `src-edit`; that is `PolicyMatch.path`'s
 * own shape (`z.array`), not a reading of the document.
 */
const PRESET_YAML = `
dataDir: ${JSON.stringify(join(tmpdir(), "omni-policy-yaml"))}
tokens:
  - id: operator
    secret: an-operator-secret-0123456789
policy:
  default: deny-all
  presets:
    deny-all:
      default: deny
    readonly:
      default: deny
      rules:
        - id: r1
          match: { kind: [read, search, think, fetch] }
          action: allow
    readonly-contained:
      default: deny
      rules:
        - id: r1
          match: { kind: [read, search, think, fetch], path: ["**"] }
          action: allow
    src-edit:
      extends: readonly
      default: park
      rules:
        - id: e1
          match: { kind: [edit], path: ["src/**", "test/**", "tests/**"] }
          action: allow
        - id: d1
          match: { kind: [delete] }
          action: deny
        - id: c1
          match: { subject: command, cmd: "(pnpm|npm) (test|run build)" }
          action: allow
    full:
      default: allow
      rules:
        - id: p1
          match: { kind: [delete] }
          action: park
`;

describe("the four presets load from YAML, as DATA (acceptance 7)", () => {
  it("an operator's config file parses to exactly BUILTIN_POLICIES", () => {
    const config = yamlToDaemonConfig(PRESET_YAML, {});
    const parsed = DaemonConfig.parse(config) as ResolvedDaemonConfig;
    expect(Object.keys(parsed.policy.presets).sort()).toEqual([
      "deny-all",
      "full",
      "readonly",
      "readonly-contained",
      "src-edit",
    ]);
    for (const name of Object.keys(parsed.policy.presets)) {
      expect(parsed.policy.presets[name], name).toEqual(
        BUILTIN_POLICIES[name as keyof typeof BUILTIN_POLICIES],
      );
    }
  });

  it("and the engine built from the YAML decides exactly as the shipped one does", () => {
    const parsed = DaemonConfig.parse(yamlToDaemonConfig(PRESET_YAML, {})) as ResolvedDaemonConfig;
    const fromYaml = resolvePolicySelection("src-edit", parsed.policy.presets, "deny-all");
    const shipped = resolvePolicySelection("src-edit", BUILTIN_POLICIES, "deny-all");
    expect(fromYaml).toEqual(shipped);
  });

  it("a preset file with a typo is a config LOAD error naming the path, not a silent widening", () => {
    const typo = PRESET_YAML.replace("match: { kind: [delete] }", "match: { kinds: [delete] }");
    expect(() => yamlToDaemonConfig(typo, {})).toThrowError(OmniError);
  });
});

// ── the ceiling, at create and at decision time ──────────────────────────────

/**
 * Both the selection and the ceiling go through their own schema on the way in, because that is
 * the only way either ever arrives: a selection is parsed at the route, and a ceiling is parsed
 * at config load. A test that handed the engine a hand-built object would be testing a shape
 * production never produces.
 */
const engineFor = (
  sel: unknown,
  ceiling: unknown,
  o: { name?: string; onUnresolved?: "park" | "deny" | "fail" } = {},
) => {
  const policy = resolvePolicySelection(
    PolicySelection.parse(sel) as PolicySelection,
    BUILTIN_POLICIES,
    "deny-all",
  );
  return createPolicyEngine({
    policy,
    ceiling: ceiling === null ? null : PolicyCeiling.parse(ceiling),
    id: policy.id,
    ...(o.name === undefined ? {} : { ceilingName: o.name }),
    ...(o.onUnresolved === undefined ? {} : { onUnresolved: o.onUnresolved }),
  });
};

describe("policy ceiling (M2-B, §20.5)", () => {
  it("a policy exceeding the token's ceiling is 403 at create, with body.policy.{ceiling, offending}", () => {
    let thrown: OmniError | null = null;
    try {
      engineFor(
        { presets: ["readonly"], rules: [{ id: "x", match: { kind: ["edit"] }, action: "allow" }] },
        { maxAction: "allow", denyKinds: ["edit"], commands: true, park: true },
        { name: "token:tok_a" },
      );
    } catch (e) {
      thrown = e as OmniError;
    }
    expect(thrown, "the ceiling accepted a policy that exceeds it").not.toBeNull();
    expect(thrown?.code).toBe("policy_exceeds_ceiling");
    expect(thrown?.status, "the ONE status mapping in the repository").toBe(403);

    // Exactly what the route serializes: the wire body, not an internal.
    const body = (thrown as OmniError).toBody();
    expect(body.code).toBe("policy_exceeds_ceiling");
    expect(body.policy?.ceiling).toBe("token:tok_a");
    expect(body.policy?.offending).toEqual(['readonly+inline#inline:x: kind "edit" is a denyKind']);
    expect(Object.keys(body).sort()).toEqual(["code", "message", "policy"]);
  });

  it("a case the static check provably cannot catch is CLAMPED at runtime, and the clamp appears on the decision and as a TurnWarning", async () => {
    const root = await fsRealpath(await mkdtemp(join(tmpdir(), "omni-policy-clamp-")));
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await mkdir(join(root, "src-secrets"), { recursive: true });
      await writeFile(join(root, "src", "main.ts"), "export {};\n");
      await writeFile(join(root, "src-secrets", "keys.txt"), "OUTSIDE-SECRET-BETA\n");

      const ceiling = {
        maxAction: "allow",
        denyKinds: [],
        pathRoots: ["src"],
        commands: true,
        park: true,
      };
      // `src*/**` has head `src`, which IS lexically inside pathRoot `src`. The static check is a
      // literal prefix test on that head and therefore accepts the document — it cannot see that
      // the glob reaches `src-secrets/`.
      const engine = engineFor(
        {
          default: "deny",
          rules: [{ id: "wide", match: { kind: ["edit"], path: ["src*/**"] }, action: "allow" }],
        },
        ceiling,
        { name: "token:tok_a" },
      );

      const request = (path: string) => ({
        id: "x_1" as never,
        kind: "permission" as const,
        method: "session/request_permission" as const,
        title: "Write a file",
        message: null,
        subject: {
          type: "tool_call",
          toolCall: { toolCallId: "call_1", kind: "edit", locations: [{ path }] },
        },
        options: [] as readonly PermissionOption[],
        fields: [],
        toolCallId: "call_1",
        turnId: null,
        raw: {},
      });

      const inside = engine.decide(
        await toPolicySubject(request(join(root, "src", "main.ts")), {
          cwd: root,
          agentId: "fixture",
          realpath: fsRealpath,
        }),
      );
      expect(inside.action, "the rule the operator wrote still works inside the roots").toBe(
        "allow",
      );
      expect(inside.clamped).toBeNull();

      const escaping: PolicyVerdict = engine.decide(
        await toPolicySubject(request(join(root, "src-secrets", "keys.txt")), {
          cwd: root,
          agentId: "fixture",
          realpath: fsRealpath,
        }),
      );
      expect(escaping.action).not.toBe("allow");
      expect(escaping.source).toBe("ceiling");
      expect(escaping.clamped).toEqual({ from: "allow", by: "token:tok_a:pathRoots" });

      // ...and it is NOT silent: the same clamp becomes a TurnWarning on the turn.
      const warning: TurnWarning = {
        code: "policy_clamped",
        message: `"${escaping.clamped?.from ?? ""}" was narrowed to "${escaping.action}" by ${escaping.clamped?.by ?? ""}`,
        source: "policy",
        detail: {
          from: escaping.clamped?.from,
          to: escaping.action,
          by: escaping.clamped?.by,
          rule: escaping.rule,
        },
      };
      expect(warning.code).toBe("policy_clamped");
      expect(warning.source).toBe("policy");
      expect(warning.message).toContain("token:tok_a:pathRoots");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ── §20.1's whole chain, against a real agent process ────────────────────────

/**
 * `packages/testkit/fixtures/agents/permission-allow-always-only.mjs`, by name.
 *
 * The merge widened `FixtureAgentName` with the names CONTRACTS §5.8.10 declares, so WP-P's
 * sibling-path workaround is gone and this is the resolver every other fixture uses.
 */
function allowAlwaysOnlyFixture(): string {
  return fixtureAgentPath("permission-allow-always-only");
}

let workspace = "";

beforeAll(async () => {
  workspace = await fsRealpath(await mkdtemp(join(tmpdir(), "omni-policy-fixture-")));
});

afterAll(async () => {
  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

describe("D4 rules 3 and 4 against a real agent process (F26)", () => {
  it("a menu offering ONLY a persistent grant is answered -32603, and never selected", async () => {
    const child = spawn(process.execPath, [allowAlwaysOnlyFixture()], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    const engine = createPolicyEngine({
      // `full` says allow, so this test cannot pass because the policy happened to deny: the
      // engine WANTS to allow, and there is still nothing it may select.
      policy: resolvePolicySelection("full", BUILTIN_POLICIES, "deny-all"),
      ceiling: null,
      id: "full",
    });

    const seen: { offered: readonly PermissionOption[]; verdict: PolicyVerdict | null }[] = [];
    const chunks: string[] = [];

    try {
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin as NonNullable<typeof child.stdin>),
        Readable.toWeb(
          child.stdout as NonNullable<typeof child.stdout>,
        ) as ReadableStream<Uint8Array>,
      );

      const link = openAcpLink(
        stream,
        {
          onSessionUpdate(n) {
            const update = n.update as { content?: { text?: unknown } };
            if (typeof update.content?.text === "string") chunks.push(update.content.text);
          },
          async onPermissionRequest(
            req: RequestPermissionRequest,
          ): Promise<RequestPermissionResponse> {
            // §20.1's chain, in order and with nothing between the boxes:
            //   the mapped request -> toPolicySubject -> engine.decide -> selectOption.
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
                { cwd: workspace, agentId: "fixture", realpath: fsRealpath },
              ),
            );
            seen.push({ offered: mapped.options, verdict });

            const choice = selectOption(
              verdict.action === "allow" ? "allow" : "deny",
              mapped.options,
              { allowSessionGrants: true },
            );
            if (choice.optionId === null) {
              // D4 rule 4, and rule 1 by construction: no id was invented, and rule 5 is honoured
              // because a JSON-RPC error is not a cancelled turn.
              throw AcpRequestError.internalError(
                { offered: mapped.options },
                "no acceptable permission option was offered",
              );
            }
            return { outcome: { outcome: "selected", optionId: choice.optionId } };
          },
          onClosed() {
            /* the process is killed below */
          },
        },
        { logger: silent },
      );

      await link.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = (await link.request("session/new", {
        cwd: workspace,
        mcpServers: [],
      })) as { sessionId: string };

      const result = (await link.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "write src/main.ts" }],
      })) as { stopReason: string };

      expect(result.stopReason).toBe("end_turn");

      // The engine WANTED to allow, and still nothing was selectable.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.verdict?.action).toBe("allow");
      expect(seen[0]?.offered.map((o) => o.kind)).toEqual(["allow_always"]);

      // The AGENT's own view, echoed back into the stream: it received -32603 and no id.
      expect(chunks.join(" ")).toContain("answered: error -32603");
      expect(chunks.join(" ")).not.toContain("always");

      link.close();
    } finally {
      child.kill("SIGKILL");
    }
  });
});
