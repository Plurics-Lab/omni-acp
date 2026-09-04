import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLogConfig,
  type Clock,
  type DaemonId,
  type EventStore,
  type PersistenceHandle,
  type ResolvedEventLogConfig,
  type WorkerId,
} from "@omni-acp/protocol";
import { createPersistedEventLog, openPersistence } from "@omni-acp/core";
import { fakeClock, nullLogger, tmpPersistence, type TmpPersistence } from "@omni-acp/testkit";

export const DAEMON_ID = `d_${"0".repeat(25)}7` as DaemonId;

export const sqliteConfig = (
  overrides: Partial<ResolvedEventLogConfig> = {},
): ResolvedEventLogConfig => EventLogConfig.parse({ driver: "sqlite", ...overrides });

/**
 * §14.6's payload-row count, read structurally.
 *
 * `EventStore` is frozen in `@omni-acp/protocol` and has no seat for it; the SQLite store adds
 * one because §14.11 item 9 asserts "23 appends ⇒ 2 stored payloads", which is a fact about the
 * side table and nothing else can answer it.
 */
export function payloadCountOf(store: EventStore): number {
  const maybe = store as EventStore & { payloadCount?: () => number };
  if (typeof maybe.payloadCount !== "function") {
    throw new Error("this EventStore does not expose payloadCount()");
  }
  return maybe.payloadCount();
}

/**
 * The three factories `tmpPersistence` cannot import for itself: `@omni-acp/testkit` depends on
 * `@omni-acp/protocol` only (CONTRACTS.md §3.1), and core dev-depends on testkit, so the edge
 * would also be a cycle. The suite therefore runs against the SHIPPED driver, injected from the
 * package that owns it.
 */
export const makeTmpPersistence = (): Promise<TmpPersistence> =>
  tmpPersistence({
    open: openPersistence,
    createLog: createPersistedEventLog,
    payloadCount: (h: PersistenceHandle) => payloadCountOf(h.events),
  });

export interface OpenedPersistence {
  handle: PersistenceHandle;
  dir: string;
  clock: Clock;
  dispose(): Promise<void>;
}

/**
 * A persistence handle over a real temp dir, for the tests that need the STORE rather than the
 * harness — retention, the schema, the worker store.
 */
export async function openTmpPersistence(
  overrides: Partial<ResolvedEventLogConfig> = {},
  o: { file?: string; clock?: Clock } = {},
): Promise<OpenedPersistence> {
  const dir = await mkdtemp(join(tmpdir(), "omni-acp-store-"));
  const clock = o.clock ?? fakeClock();
  const handle = await openPersistence({
    dataDir: dir,
    ...(o.file === undefined ? {} : { file: o.file }),
    config: sqliteConfig(overrides),
    clock,
    logger: nullLogger(),
  });
  return {
    handle,
    dir,
    clock,
    async dispose(): Promise<void> {
      try {
        handle.close();
      } catch {
        // Already closed by the test; the temp dir still has to go.
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export const workerId = (n: number): WorkerId => `w_${String(n).padStart(26, "0")}` as WorkerId;
