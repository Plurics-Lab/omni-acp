import {
  OmniError,
  type AcpStream,
  type PermissionOption,
  type StopReason,
} from "@omni-acp/protocol";

/** A scriptable ACP v1 agent built on the SDK's public acp.agent() builder. */
export interface ScriptedAgent {
  /** Hand this to FakeAgentProcess. */
  readonly stream: AcpStream;
  readonly sessionIds: readonly string[];
  emitChunk(text: string): Promise<void>;
  emitThought(text: string): Promise<void>;
  emitToolCall(u: Record<string, unknown>): Promise<void>;
  emitDiff(
    toolCallId: string,
    path: string,
    oldText: string | null,
    newText: string,
  ): Promise<void>;
  emitUsage(used: number, size: number): Promise<void>;
  /** Issues session/request_permission and resolves with the option the client chose. */
  requestPermission(options: readonly PermissionOption[]): Promise<string | { error: number }>;
  resolvePrompt(stopReason: StopReason): void;
  /** Emit an update `ms` after the prompt response has already returned (the L5 case). */
  emitAfterPromptResolves(ms: number, text: string): void;
  hang(): void;
  die(): void;
  setCapabilities(caps: Record<string, unknown>): void;
}

export function scriptedAgent(opts?: { name?: string }): ScriptedAgent {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.scriptedAgent)");
}
