import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ID_PATTERN, createIdGen } from "@omni-acp/protocol";
import { seqIds } from "@omni-acp/testkit";
import { DAEMON_ID_FILE, expandHome, loadOrCreateDaemonId, resolvePath } from "../src/ids-file.js";
import { removeTempRoots, tempRoot } from "./support/temp-dirs.js";

const tempDir = () => tempRoot("omni-ids-");

/** See `support/temp-dirs.ts`: these suites leaked ~800 `/tmp` directories per full run. */
afterEach(async () => {
  await removeTempRoots();
});

describe("loadOrCreateDaemonId (WP-5 acceptance 13)", () => {
  it("mints a d_-prefixed ULID and persists it under dataDir", async () => {
    const dir = await tempDir();
    const id = await loadOrCreateDaemonId(dir, createIdGen());
    expect(id).toMatch(ID_PATTERN.daemon);
    expect((await readFile(join(dir, DAEMON_ID_FILE), "utf8")).trim()).toBe(id);
  });

  it("is STABLE across calls — a WorkerRef's first half may not change under a client (D11)", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateDaemonId(dir, createIdGen());
    const second = await loadOrCreateDaemonId(dir, createIdGen());
    const third = await loadOrCreateDaemonId(dir, seqIds());
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("creates dataDir when it does not exist yet", async () => {
    const dir = join(await tempDir(), "nested", "deeper");
    const id = await loadOrCreateDaemonId(dir, createIdGen());
    expect((await readFile(join(dir, DAEMON_ID_FILE), "utf8")).trim()).toBe(id);
  });

  it("tolerates surrounding whitespace in an existing file", async () => {
    const dir = await tempDir();
    const id = `d_${"0".repeat(25)}7`;
    await writeFile(join(dir, DAEMON_ID_FILE), `\n  ${id}  \n`);
    expect(await loadOrCreateDaemonId(dir, createIdGen())).toBe(id);
  });

  it("replaces a file whose contents are not a d_ ULID", async () => {
    // Honouring it would produce a daemon whose every envelope fails `eventEnvelopeSchema` at
    // the client — unreadable events are worse than a new id.
    const dir = await tempDir();
    await writeFile(join(dir, DAEMON_ID_FILE), "not-an-id\n");
    const id = await loadOrCreateDaemonId(dir, createIdGen());
    expect(id).toMatch(ID_PATTERN.daemon);
    expect((await readFile(join(dir, DAEMON_ID_FILE), "utf8")).trim()).toBe(id);
  });

  it("gives concurrent starts on one dataDir the SAME id — the loser reads the winner's", async () => {
    const dir = await tempDir();
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => loadOrCreateDaemonId(dir, createIdGen())),
    );
    expect(new Set(ids).size).toBe(1);
    expect((await readFile(join(dir, DAEMON_ID_FILE), "utf8")).trim()).toBe(ids[0]);
  });
});

describe("path helpers", () => {
  it("expands a leading ~ and leaves ~user alone", () => {
    expect(expandHome("~")).toBe(homedir());
    expect(expandHome("~/.omni-acp")).toBe(join(homedir(), ".omni-acp"));
    // Resolving another account's home is a lookup this daemon has no business doing.
    expect(expandHome("~someone/else")).toBe("~someone/else");
    expect(expandHome("/already/absolute")).toBe("/already/absolute");
  });

  it("resolvePath is absolute and ~-expanded", () => {
    expect(resolvePath("~/x")).toBe(join(homedir(), "x"));
    expect(resolvePath("relative/dir").startsWith(process.cwd())).toBe(true);
  });
});
