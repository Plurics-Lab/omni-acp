import { describe, expect, it } from "vitest";
import type { InteractionRecord, ToolCallView } from "@omni-acp/protocol";
import { PolicyPreset } from "@omni-acp/protocol";
import { resolvePolicySelection, BUILTIN_POLICIES } from "@omni-acp/core";
import { unpolicedToolCalls } from "../../src/policy/alert.js";

/**
 * §20.6 / acceptance 9 — the thing that is invisible in the frame.
 *
 * The fixture is claude transcript `13`'s silent `ls -A` (F40): an `execute` tool call that ran to
 * `completed` with NO permission request, while `python3 -c ...` in the same cwd raised one. The
 * split is decided inside the host and appears nowhere in the `tool_call` frame, so the daemon
 * cannot predict it — it can only report the gap afterwards.
 *
 * Owned by M2-B-WP-P.
 */

const call = (
  toolCallId: string,
  kind: string | null,
): Pick<ToolCallView, "toolCallId" | "kind"> => ({
  toolCallId,
  kind,
});

const record = (toolCallId: string | null): Pick<InteractionRecord, "toolCallId"> => ({
  toolCallId,
});

/**
 * Transcript `13`, reduced to the two rows that matter: one `execute` that reached the engine and
 * one that never did. Both ran; only one is visible in `interactions`.
 */
const F40_TOOL_CALLS = [call("call_ls", "execute"), call("call_python", "execute")];
const F40_INTERACTIONS = [record("call_python")];

describe("alertOnUnpoliced (F40, §20.6)", () => {
  it("warns for a listed kind that never reached the engine, and only for that one", () => {
    const warnings = unpolicedToolCalls({
      alertOnUnpoliced: ["execute"],
      toolCalls: F40_TOOL_CALLS,
      interactions: F40_INTERACTIONS,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("unpoliced_tool_call");
    expect(warnings[0]?.source).toBe("policy");
    expect(warnings[0]?.detail).toEqual({ toolCallId: "call_ls", kind: "execute" });
    expect(warnings[0]?.message).toContain("execute");
  });

  it("says nothing when the preset lists nothing — a warning nobody asked for is noise", () => {
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: [],
        toolCalls: F40_TOOL_CALLS,
        interactions: [],
      }),
    ).toEqual([]);
  });

  it("says nothing about a kind that is not listed", () => {
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["delete"],
        toolCalls: F40_TOOL_CALLS,
        interactions: F40_INTERACTIONS,
      }),
    ).toEqual([]);
  });

  it("a DENIED call still counts as policed: it reached the engine and the engine said no", () => {
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["execute"],
        toolCalls: [call("call_python", "execute")],
        interactions: [record("call_python")],
      }),
    ).toEqual([]);
  });

  it("an interaction with a NULL toolCallId polices nothing — it joins to no call", () => {
    // An elicitation has no tool call of its own on some agents, and a decision that could not be
    // joined must not silently vouch for a call it never saw.
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["execute"],
        toolCalls: [call("call_ls", "execute")],
        interactions: [record(null)],
      }),
    ).toHaveLength(1);
  });

  it("a call with no kind is never warned about — we do not guess what it was", () => {
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["execute"],
        toolCalls: [call("call_x", null)],
        interactions: [],
      }),
    ).toEqual([]);
  });

  it("one warning per tool call, even when the stream repeats the id", () => {
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["execute"],
        toolCalls: [call("call_ls", "execute"), call("call_ls", "execute")],
        interactions: [],
      }),
    ).toHaveLength(1);
  });

  it("reports in stream order, so a reader can line the warnings up with the log", () => {
    const warnings = unpolicedToolCalls({
      alertOnUnpoliced: ["execute", "delete"],
      toolCalls: [call("a", "delete"), call("b", "execute"), call("c", "delete")],
      interactions: [],
    });
    expect(warnings.map((w) => w.detail?.["toolCallId"])).toEqual(["a", "b", "c"]);
  });

  it("the list comes from the PRESET, and reaches the engine's resolved document", () => {
    const presets = {
      ...BUILTIN_POLICIES,
      watchful: PolicyPreset.parse({ default: "deny", alertOnUnpoliced: ["execute"] }),
    };
    const resolved = resolvePolicySelection("watchful", presets, "deny-all");
    expect(resolved.alertOnUnpoliced).toEqual(["execute"]);
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: resolved.alertOnUnpoliced,
        toolCalls: F40_TOOL_CALLS,
        interactions: F40_INTERACTIONS,
      }),
    ).toHaveLength(1);
  });

  it("WOULD MISS F40 if 'no permission request' were read as 'no tool ran'", () => {
    // The invariant, demonstrated: the naive reading looks only at `interactions`, and reports
    // nothing at all for a turn in which an `execute` provably ran.
    const naive = F40_INTERACTIONS.length === 0 ? ["something ran unpoliced"] : [];
    expect(naive).toEqual([]);
    expect(
      unpolicedToolCalls({
        alertOnUnpoliced: ["execute"],
        toolCalls: F40_TOOL_CALLS,
        interactions: F40_INTERACTIONS,
      }),
    ).toHaveLength(1);
  });
});
