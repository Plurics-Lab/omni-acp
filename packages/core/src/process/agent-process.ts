import {
  OmniError,
  type AcpStream,
  type AgentProcess,
  type KillOutcome,
  type ProcessExit,
  type ProcessInfo,
  type StderrTail,
} from "@omni-acp/protocol";

/**
 * Everything `spawn.ts` has already wired, handed over as one object.
 *
 * Internal to WP-2 and deliberately structural: this file must NOT type-import
 * `node:child_process` — only `spawn.ts` may name that module at all (CONTRACTS.md §6.1).
 */
export interface AgentProcessParts {
  readonly pid: number | null;
  readonly info: ProcessInfo;
  readonly stream: AcpStream;
  readonly stderr: StderrTail;
  readonly exited: Promise<ProcessExit>;
  readonly stdoutEnded: Promise<void>;
  closeStdin(): void;
  terminate(opts?: { gracefulMs?: number; force?: boolean }): Promise<KillOutcome>;
}

/**
 * Assembles the `AgentProcess` contract: the idempotent, concurrency-safe `terminate()` ladder
 * and the two independent death signals (`exited`, `stdoutEnded`) live behind this.
 */
export function createAgentProcess(parts: AgentProcessParts): AgentProcess {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createAgentProcess)");
}
