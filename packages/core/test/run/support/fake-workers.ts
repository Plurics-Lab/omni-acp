import { OmniError } from "@omni-acp/protocol";
import type {
  AuthContext,
  Clock,
  ClientRef,
  ClientId,
  CloseResult,
  CreateWorkerRequest,
  DaemonId,
  EventLog,
  IdGen,
  PromptAccepted,
  TokenId,
  TurnId,
  WorkerHandle,
  WorkerId,
  WorkerRegistry,
  WorkerSnapshot,
  WorkerState,
} from "@omni-acp/protocol";
import { createMemoryEventLog } from "../../../src/event-log/memory-log.js";

/**
 * A `WorkerRegistry` whose workers are REAL event logs and scripted turns.
 *
 * The run registry's whole job is to drive a worker and fold what comes out of its log, so the
 * double that matters is the LOG: it is `createMemoryEventLog`, the shipped one, and every
 * envelope a run reads is an envelope a real worker could have written. What is faked is the
 * agent — a turn is a script, so a test can say "this turn ends `end_turn`", "this one parks", or
 * "this one never finishes" without a process.
 *
 * Owned by M2-B-WP-R.
 */

export interface FakeTurn {
  /** Envelopes to append after `prompt()` returns, in order. */
  readonly script: (log: EventLog, turnId: TurnId) => void | Promise<void>;
  /** Auto-run the script when the prompt is accepted. `false` ⇒ the test drives it by hand. */
  readonly auto?: boolean;
}

export interface FakeWorkerRegistry extends WorkerRegistry {
  /** Every handle this registry has made, in creation order. */
  readonly handles: readonly FakeWorkerHandle[];
  /** What the next `create()` should do. Exhausted entries fall back to `endTurn()`. */
  readonly turns: FakeTurn[];
  /** Make the next `create()` throw. */
  failNextCreate(e: unknown): void;
}

export interface FakeWorkerHandle extends WorkerHandle {
  /** Runs the pending script for the current turn. Only used when `auto: false`. */
  play(): Promise<void>;
  /** Moves the worker's state and fires `onStateChange`, exactly as a real worker would. */
  setState(state: WorkerState): void;
  readonly closes: readonly string[];
  readonly cancels: number;
  readonly prompts: readonly (readonly unknown[])[];
}

/** `state_update{idle}` for a turn — §7.3's terminal envelope. */
export function idle(log: EventLog, turnId: TurnId, stopReason = "end_turn"): void {
  log.append({
    kind: "acp.session_update",
    payloadVersion: 1,
    turnId,
    payload: { sessionUpdate: "state_update", state: "idle", stopReason },
  });
}

export function chunk(log: EventLog, turnId: TurnId, text: string): void {
  log.append({
    kind: "acp.session_update",
    payloadVersion: 1,
    turnId,
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

/** The ordinary turn: one chunk, then `idle{end_turn}`. */
export const endTurn = (text = "PONG"): FakeTurn => ({
  script: (log, turnId) => {
    chunk(log, turnId, text);
    idle(log, turnId);
  },
});

/** A turn that never settles on its own — the test decides when, or never. */
export const neverSettles = (): FakeTurn => ({ script: () => {}, auto: false });

/** An ordinary turn whose settling moment the TEST chooses, via `handle.play()`. */
export const manualTurn = (text = "PONG"): FakeTurn => ({
  auto: false,
  script: (log, turnId) => {
    chunk(log, turnId, text);
    idle(log, turnId);
  },
});

export function fakeAuth(
  o: {
    tokenId?: string;
    role?: "user" | "admin";
    clientId?: string;
  } = {},
): AuthContext {
  const tokenId = (o.tokenId ?? "alice") as TokenId;
  const clientId = (o.clientId ?? "c1") as ClientId;
  return {
    tokenId,
    role: o.role ?? "user",
    clientId,
    leaseEpoch: null,
    agents: "*",
    cwdRoots: [],
    maxWorkers: 16,
    assertAgent: () => {},
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: () => true,
    asClientRef: (): ClientRef => ({ tokenId, clientId }),
    policyCeiling: null,
    assertPolicy: () => {
      throw new OmniError("internal", "fakeAuth: assertPolicy is not part of a run test");
    },
    assertEnv: () => ({ env: {}, keys: [], persist: true }),
    assertMcp: () => [],
  };
}

export function fakeWorkers(o: {
  clock: Clock;
  ids: IdGen;
  daemonId: DaemonId;
}): FakeWorkerRegistry {
  const handles: FakeWorkerHandle[] = [];
  const turns: FakeTurn[] = [];
  let nextCreateError: unknown = null;

  const makeHandle = (req: CreateWorkerRequest): FakeWorkerHandle => {
    const id = o.ids.worker();
    const log = createMemoryEventLog({ workerId: id, daemonId: o.daemonId, clock: o.clock });
    const stateListeners = new Set<(s: WorkerState, prev: WorkerState | null) => void>();
    const closes: string[] = [];
    const prompts: (readonly unknown[])[] = [];
    let cancels = 0;
    let state: WorkerState = "ready";
    let pending: { turn: FakeTurn; turnId: TurnId } | null = null;

    const snapshot = (): WorkerSnapshot =>
      ({
        workerId: id,
        daemonId: o.daemonId,
        agentId: req.agent,
        cwd: req.cwd,
        state,
        headSeq: log.head,
      }) as unknown as WorkerSnapshot;

    const handle: FakeWorkerHandle = {
      id,
      log,
      lease: null as unknown as WorkerHandle["lease"],
      generation: 1,
      snapshot,
      closed: new Promise<CloseResult>(() => {}),
      onStateChange(cb): () => void {
        stateListeners.add(cb);
        return () => stateListeners.delete(cb);
      },
      setState(next: WorkerState): void {
        const prev = state;
        state = next;
        for (const cb of stateListeners) cb(next, prev);
      },
      async prompt(content: readonly unknown[]): Promise<PromptAccepted> {
        prompts.push(content);
        const turnId = o.ids.turn();
        const accepted = log.append({
          kind: "acp.session_update",
          payloadVersion: 1,
          turnId,
          payload: { sessionUpdate: "state_update", state: "running" },
        });
        const turn = turns.shift() ?? endTurn();
        pending = { turn, turnId };
        if (turn.auto !== false) {
          // A real agent's updates arrive after the POST returns; a script that ran inline would
          // let a run see its own terminal envelope before it had subscribed.
          queueMicrotask(() => {
            void handle.play();
          });
        }
        return await Promise.resolve({ turnId, seq: accepted.seq });
      },
      async play(): Promise<void> {
        const current = pending;
        if (current === null) return;
        pending = null;
        await current.turn.script(log, current.turnId);
      },
      async cancel(): Promise<void> {
        cancels += 1;
        return await Promise.resolve();
      },
      async close(reason): Promise<CloseResult> {
        closes.push(reason);
        handle.setState("closed");
        log.append({
          kind: "omni.worker_state",
          payloadVersion: 1,
          payload: { state: "closed", previous: "ready", reason },
        });
        return await Promise.resolve({ workerId: id, reason } as unknown as CloseResult);
      },
      turn: () => {
        throw new OmniError("internal", "fakeWorkers: turn() is not part of a run test");
      },
      hibernate: () => Promise.reject(new OmniError("internal", "not part of a run test")),
      wake: () => Promise.reject(new OmniError("internal", "not part of a run test")),
      answerInteraction: () => {
        throw new OmniError("internal", "not part of a run test");
      },
      interactions: [],
      setConfig: () => Promise.reject(new OmniError("internal", "not part of a run test")),
      cancelInternal: () => Promise.resolve(),
      get closes(): readonly string[] {
        return closes;
      },
      get cancels(): number {
        return cancels;
      },
      get prompts(): readonly (readonly unknown[])[] {
        return prompts;
      },
    };
    return handle;
  };

  const byId = (id: WorkerId): FakeWorkerHandle => {
    const found = handles.find((h) => h.id === id);
    if (found === undefined) throw new OmniError("worker_not_found", `no worker ${id}`);
    return found;
  };

  const registry: FakeWorkerRegistry = {
    handles,
    turns,
    failNextCreate(e: unknown): void {
      nextCreateError = e;
    },
    get size(): number {
      return handles.length;
    },
    hibernatedSize: 0,
    async create(req: CreateWorkerRequest): Promise<WorkerHandle> {
      if (nextCreateError !== null) {
        const e = nextCreateError;
        nextCreateError = null;
        throw e;
      }
      const handle = makeHandle(req);
      handles.push(handle);
      return await Promise.resolve(handle);
    },
    get: (id) => byId(id),
    list: () => handles.map((h) => h.snapshot()),
    delete: async (id) => await byId(id).close("client_request"),
    closeAll: async () => {
      for (const h of handles) await h.close("shutdown");
    },
    snapshot: (id) => byId(id).snapshot(),
    prompt: async (id, _auth, body) =>
      await byId(id).prompt(body.content, { tokenId: "alice" as TokenId, clientId: null }),
    cancel: async (id) => {
      await byId(id).cancel({ tokenId: "alice" as TokenId, clientId: null });
    },
    turn: (id) => byId(id).turn("t_x" as TurnId),
    logFor: (id) => byId(id).log,
    lease: () => {
      throw new OmniError("internal", "not part of a run test");
    },
    hibernate: () => Promise.reject(new OmniError("internal", "not part of a run test")),
    wake: () => Promise.reject(new OmniError("internal", "not part of a run test")),
    adopt: () => Promise.resolve({ hibernated: 0, closed: 0, orphans: [] }),
    answer: () => {
      throw new OmniError("internal", "not part of a run test");
    },
    interactions: () => {
      throw new OmniError("internal", "not part of a run test");
    },
    setConfig: () => Promise.reject(new OmniError("internal", "not part of a run test")),
  };
  return registry;
}
