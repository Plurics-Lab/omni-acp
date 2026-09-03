import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { OmniError, isDaemonId, type DaemonId, type IdGen } from "@omni-acp/protocol";

/** The file name is part of the on-disk contract: an operator may read or copy it. */
export const DAEMON_ID_FILE = "daemon-id";

/**
 * `~` expansion, done once here so `dataDir` and every `cwdRoots` entry agree.
 *
 * `DaemonConfig.dataDir` defaults to the literal string `"~/.omni-acp"` and a YAML config will
 * carry `~/projects` in `cwdRoots`; a shell would have expanded both and a library never sees a
 * shell. Only a leading `~` or `~/` is expanded — `~user` is deliberately NOT, because resolving
 * another account's home is a lookup this daemon has no business doing.
 */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** `expandHome` + `resolve`, so every path the daemon stores is absolute. */
export function resolvePath(p: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Reads `<dataDir>/daemon-id`, or mints a `d_`-prefixed ULID and persists it. The daemonId is
 * stable across `createDaemon()` calls because it is half of a `WorkerRef` (D11) — a value that
 * changes on restart would silently re-address every worker.
 *
 * Two edges are decided here rather than left to chance:
 *  - The file is written with `wx`, so two daemons racing on the same `dataDir` do not both win:
 *    the loser reads the winner's id back instead of overwriting it.
 *  - A file whose contents are not a `d_` ULID is REPLACED. Envelopes carry `daemonId` and the
 *    client validates it against `ID_PATTERN.daemon` (`eventEnvelopeSchema`), so honouring a
 *    corrupt value would produce a daemon whose every event fails to parse at the other end.
 */
export async function loadOrCreateDaemonId(dataDir: string, ids: IdGen): Promise<DaemonId> {
  const dir = resolvePath(dataDir);
  const file = join(dir, DAEMON_ID_FILE);

  await mkdir(dir, { recursive: true });

  const existing = await readDaemonId(file);
  if (existing.id !== null) return existing.id;

  const minted = ids.daemon();
  if (!isDaemonId(minted)) {
    throw new OmniError("internal", "IdGen.daemon() did not produce a d_-prefixed ULID");
  }
  // `wx` only when the file is absent, so a concurrent start cannot be overwritten; a file that
  // is present but unusable is replaced, which `wx` would refuse to do.
  const flag = existing.present ? "w" : "wx";
  try {
    await writeFile(file, `${minted}\n`, { encoding: "utf8", flag, mode: 0o600 });
    return minted;
  } catch (e) {
    // EEXIST: somebody wrote it between the read and the write. Their id is now the truth.
    const raced = await readDaemonId(file);
    if (raced.id !== null) return raced.id;
    // Not a race — the directory is unwritable, which is a startup failure worth naming.
    throw new OmniError("internal", `cannot persist the daemon id to ${file}`, { cause: e });
  }
}

async function readDaemonId(file: string): Promise<{ present: boolean; id: DaemonId | null }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { present: false, id: null };
  }
  const value = text.trim();
  return { present: true, id: isDaemonId(value) ? value : null };
}
