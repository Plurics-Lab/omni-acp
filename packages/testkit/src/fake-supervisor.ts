import {
  OmniError,
  type AgentProcess,
  type PlatformOwnership,
  type SpawnSpec,
  type Supervisor,
} from "@omni-acp/protocol";
import type { ScriptedAgent } from "./scripted-agent.js";

export interface FakeAgentProcess extends AgentProcess {
  simulateExit(code: number | null, signal?: string | null): void;
  writeStderr(s: string): void;
  readonly terminateCalls: readonly { gracefulMs?: number; force?: boolean }[];
}

export interface FakeSupervisor extends Supervisor {
  readonly spawnCalls: readonly SpawnSpec[];
  /** Registers the ScriptedAgent the next spawn() will be wired to. */
  enqueue(agent: ScriptedAgent | { failWith: Error }): void;
  allTreesReclaimed(): boolean;
}

export function fakeSupervisor(opts?: { ownership?: PlatformOwnership }): FakeSupervisor {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.fakeSupervisor)");
}
