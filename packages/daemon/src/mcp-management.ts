import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  InstallMcpRequest,
  McpInstallationId,
  McpResourceName,
  McpServerPreset,
  ManagedMcpPresetRecord,
  ManagedMcpInstallationRecord,
  OmniError,
  RegisterMcpPresetRequest,
  type AuthContext,
  type Logger,
  type McpInstallationMetadata,
  type McpManagement,
  type McpPresetMetadata,
  type ResolvedDaemonConfig,
} from "@omni-acp/protocol";
import { resolvePath } from "./ids-file.js";

interface PresetRecord {
  meta: McpPresetMetadata;
  server: McpServerPreset;
  deleted: boolean;
}
interface InstallationRecord {
  meta: McpInstallationMetadata;
  entrypoint: string;
  files: { path: string; sha256: string }[];
}
const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string): boolean => {
  const r = relative(root, path);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
function bad(message: string): never {
  throw new OmniError("bad_request", message);
}

/** Deliberately not an archive/package manager: prebuilt regular files only, never executes uploads. */
export async function createMcpManagement(
  config: ResolvedDaemonConfig,
  logger?: Logger,
): Promise<McpManagement & { close(): Promise<void> }> {
  const opts = config.mcpManagement;
  const staticNames = new Set(Object.keys(config.mcpServers));
  const presets = new Map<string, PresetRecord>();
  const installations = new Map<string, InstallationRecord>();
  let root: string | null = null;
  let stopped = false;
  let tail = Promise.resolve();
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = tail.then(action);
    tail = next.then(
      () => {},
      () => {},
    );
    return next;
  };

  async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0
    ) {
      bad("MCP management directory must be owner-only, owned by the daemon, and not a symlink");
    }
    if ((await realpath(path)) !== resolve(path))
      bad("MCP management directory cannot contain symlink ancestors");
  }

  if (opts.directory !== null) {
    root = resolvePath(opts.directory);
    for (const token of config.tokens) {
      for (const cwd of token.cwdRoots.length ? token.cwdRoots : [homedir()]) {
        const allowed = await realpath(resolvePath(cwd)).catch(() => resolvePath(cwd));
        if (inside(allowed, root) || inside(root, allowed))
          bad("MCP management directory must be separate from all token cwdRoots");
      }
    }
    await privateDirectory(root);
    // Fail closed across daemon processes. A crash leaves a lock requiring operator recovery.
    try {
      await mkdir(join(root, ".lock"), { mode: 0o700 });
    } catch {
      throw new OmniError(
        "mcp_conflict",
        "MCP store is locked; stop its owner or recover its stale lock before starting",
      );
    }
    try {
      await privateDirectory(join(root, "presets"));
      await privateDirectory(join(root, "installations"));
      for (const file of await readdir(join(root, "presets"))) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}\.json$/.test(file)) bad("invalid MCP store record");
        const record = ManagedMcpPresetRecord.parse(await readRecord(join(root, "presets", file)));
        const name = McpResourceName.parse(record.meta.name);
        if (file !== `${name}.json` || staticNames.has(name))
          bad("managed MCP preset collides with static configuration");
        record.server = validateServer(record.server);
        if (record.meta.type !== record.server.type)
          bad("MCP preset metadata does not match its server");
        presets.set(name, record);
        if (!record.deleted) config.mcpServers[name] = record.server;
      }
      for (const id of await readdir(join(root, "installations"))) {
        if (id.startsWith(".stage-")) continue; // interrupted upload is never published
        McpInstallationId.parse(id);
        await privateDirectory(join(root, "installations", id));
        const record = ManagedMcpInstallationRecord.parse(
          await readRecord(join(root, "installations", id, "manifest.json")),
        );
        if (record.meta.id !== id) bad("invalid MCP installation record");
        const manifest = {
          name: record.meta.name,
          version: record.meta.version,
          runtime: record.meta.runtime,
          entrypoint: safePath(record.entrypoint),
          files: record.files,
        };
        if (
          digest(JSON.stringify(manifest)) !== id ||
          record.files.length !== record.meta.fileCount ||
          record.files.length > opts.maxFiles
        )
          bad("MCP installation manifest integrity check failed");
        const seen = new Set<string>();
        let total = 0;
        for (const file of record.files) {
          const path = safePath(file.path);
          if (seen.has(path)) bad("duplicate persisted MCP file path");
          seen.add(path);
          const disk = join(root, "installations", id, "files", path);
          const stat = await lstat(disk);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            (await realpath(disk)) !== disk ||
            stat.size > opts.maxUploadBytes
          )
            bad("invalid persisted MCP file");
          total += stat.size;
          if (total > opts.maxUploadBytes || digest(await readFile(disk)) !== file.sha256)
            bad("persisted MCP file integrity check failed");
        }
        if (!seen.has(record.entrypoint) || total !== record.meta.totalBytes)
          bad("invalid persisted MCP entrypoint or byte count");
        installations.set(id, record);
      }
      for (const record of presets.values()) {
        if (!record.meta.installationId) continue;
        const installation = installations.get(record.meta.installationId);
        if (!installation) bad("managed MCP preset references missing installation");
        const entry = join(
          root,
          "installations",
          record.meta.installationId,
          "files",
          installation.entrypoint,
        );
        const expected = await runtimeCommand(installation.meta.runtime, entry);
        if (
          record.server.type !== "stdio" ||
          record.server.command !== expected ||
          (installation.meta.runtime !== "native" && record.server.args[0] !== entry)
        )
          bad("managed MCP preset does not match installation");
      }
      if (presets.size > opts.maxPresets || installations.size > opts.maxInstallations)
        bad("MCP store exceeds configured quota");
    } catch (error) {
      await rm(join(root, ".lock"), { recursive: true });
      throw error;
    }
  }

  function token(auth: AuthContext) {
    if (stopped) throw new OmniError("forbidden", "MCP management is stopped");
    const row = config.tokens.find((t) => t.id === auth.tokenId);
    if (!row) throw new OmniError("unauthorized", "token has been revoked");
    return row;
  }
  function assertAdmin(auth: AuthContext): void {
    if (token(auth).role !== "admin" || auth.role !== "admin")
      throw new OmniError("forbidden", "MCP administration requires admin role");
  }
  function assertMutation(auth: AuthContext, kind: "manage" | "install"): void {
    assertAdmin(auth);
    const row = token(auth);
    if (!(kind === "manage" ? row.mcpManage : row.mcpInstall))
      throw new OmniError("forbidden", `MCP ${kind} permission required`);
    if (root === null) throw new OmniError("forbidden", "MCP management is disabled");
    const host = config.listen?.host.trim().toLowerCase();
    if (
      !opts.allowInsecureTransport &&
      host !== undefined &&
      !["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"].includes(host)
    ) {
      throw new OmniError(
        "insecure_transport",
        "MCP mutations require loopback or explicitly trusted TLS termination",
      );
    }
  }
  function visible(auth: AuthContext, name: string): boolean {
    const row = token(auth);
    return row.role === "admin" || row.mcpPresets === "*" || row.mcpPresets.includes(name);
  }
  function metadata(name: string): McpPresetMetadata | undefined {
    if (staticNames.has(name))
      return { name, type: config.mcpServers[name]!.type, source: "static" };
    const record = presets.get(name);
    return record && !record.deleted ? { ...record.meta } : undefined;
  }
  async function persistPreset(record: PresetRecord): Promise<void> {
    const temp = join(root!, `preset-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
      await rename(temp, join(root!, "presets", `${record.meta.name}.json`));
    } finally {
      await rm(temp, { force: true });
    }
  }

  return {
    assertMutation,
    async listPresets(auth) {
      token(auth);
      const names = [...staticNames, ...presets.keys()];
      return {
        presets: names
          .filter((n) => visible(auth, n))
          .map(metadata)
          .filter((m): m is McpPresetMetadata => m !== undefined),
      };
    },
    async getPreset(auth, name) {
      McpResourceName.parse(name);
      const meta = visible(auth, name) ? metadata(name) : undefined;
      if (!meta) throw new OmniError("mcp_not_found", "MCP preset not found");
      return meta;
    },
    registerPreset(auth, input) {
      assertMutation(auth, "manage");
      if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024)
        bad("MCP preset request exceeds byte limit");
      return serial(async () => {
        assertMutation(auth, "manage");
        const req = RegisterMcpPresetRequest.parse(input);
        if (staticNames.has(req.name) || presets.has(req.name))
          throw new OmniError(
            "mcp_conflict",
            "MCP preset names are immutable and cannot be reused",
          );
        if (presets.size >= opts.maxPresets)
          throw new OmniError("mcp_conflict", "MCP preset quota reached (including tombstones)");
        let server: McpServerPreset;
        if ("server" in req) server = validateServer(req.server);
        else {
          const install = installations.get(req.installationId);
          if (!install) throw new OmniError("mcp_not_found", "MCP installation not found");
          const base = join(root!, "installations", req.installationId, "files");
          // Revalidate file identity before constructing a launch command.
          for (const file of install.files) {
            const path = join(base, safePath(file.path));
            const st = await lstat(path);
            if (
              !st.isFile() ||
              st.isSymbolicLink() ||
              (await realpath(path)) !== path ||
              digest(await readFile(path)) !== file.sha256
            )
              bad("MCP installation integrity check failed");
          }
          const entry = join(base, safePath(install.entrypoint));
          const command = await runtimeCommand(install.meta.runtime, entry);
          server = validateServer({
            type: "stdio",
            command,
            args: [...(install.meta.runtime === "native" ? [] : [entry]), ...req.args],
            env: req.env,
          });
        }
        const meta: McpPresetMetadata = {
          name: req.name,
          type: server.type,
          source: "managed",
          createdAt: new Date().toISOString(),
          ...("installationId" in req ? { installationId: req.installationId } : {}),
        };
        const record = { meta, server, deleted: false };
        await persistPreset(record);
        presets.set(req.name, record);
        config.mcpServers[req.name] = server;
        logger?.info("mcp.preset.registered", {
          tokenId: auth.tokenId,
          name: req.name,
          installationId: meta.installationId ?? null,
        });
        return { ...meta };
      });
    },
    removePreset(auth, name) {
      assertMutation(auth, "manage");
      return serial(async () => {
        assertMutation(auth, "manage");
        McpResourceName.parse(name);
        if (staticNames.has(name))
          throw new OmniError(
            "mcp_conflict",
            "static MCP presets can only be changed in daemon configuration",
          );
        const record = presets.get(name);
        if (!record || record.deleted) throw new OmniError("mcp_not_found", "MCP preset not found");
        const tombstone = { ...record, deleted: true };
        await persistPreset(tombstone);
        presets.set(name, tombstone);
        delete config.mcpServers[name];
        logger?.info("mcp.preset.deleted", { tokenId: auth.tokenId, name });
      });
    },
    async listInstallations(auth) {
      assertAdmin(auth);
      return { installations: [...installations.values()].map((x) => ({ ...x.meta })) };
    },
    async getInstallation(auth, id) {
      assertAdmin(auth);
      McpInstallationId.parse(id);
      const record = installations.get(id);
      if (!record) throw new OmniError("mcp_not_found", "MCP installation not found");
      return { ...record.meta };
    },
    install(auth, input) {
      assertMutation(auth, "install");
      return serial(async () => {
        assertMutation(auth, "install");
        const req = InstallMcpRequest.parse(input);
        if (req.files.length > opts.maxFiles) bad("too many MCP files");
        const entrypoint = safePath(req.entrypoint);
        let totalBytes = 0;
        const paths = new Set<string>();
        const files = req.files
          .map((f) => {
            const path = safePath(f.path);
            if (paths.has(path)) bad("duplicate MCP file path");
            paths.add(path);
            if (
              f.dataBase64.length > Math.ceil(opts.maxUploadBytes / 3) * 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.dataBase64)
            )
              bad("invalid MCP file encoding");
            const bytes = Buffer.from(f.dataBase64, "base64");
            totalBytes += bytes.length;
            if (bytes.toString("base64") !== f.dataBase64 || totalBytes > opts.maxUploadBytes)
              bad("MCP upload exceeds byte limit or has invalid encoding");
            if (digest(bytes) !== f.sha256) bad("MCP file digest mismatch");
            return { path, sha256: f.sha256, bytes };
          })
          .sort((a, b) => a.path.localeCompare(b.path, "en"));
        if (!paths.has(entrypoint)) bad("MCP entrypoint must name an uploaded file");
        const manifest = {
          name: req.name,
          version: req.version,
          runtime: req.runtime,
          entrypoint,
          files: files.map(({ path, sha256 }) => ({ path, sha256 })),
        };
        const id = digest(JSON.stringify(manifest));
        const existing = installations.get(id);
        if (existing) return { ...existing.meta };
        if (installations.size >= opts.maxInstallations)
          throw new OmniError("mcp_conflict", "MCP installation quota reached");
        const stage = await mkdtemp(join(root!, "installations", ".stage-"));
        try {
          for (const file of files) {
            const path = join(stage, "files", file.path);
            await mkdir(dirname(path), { recursive: true, mode: 0o700 });
            await writeFile(path, file.bytes, { flag: "wx", mode: 0o400 });
            if (file.path === entrypoint && req.runtime === "native") await chmod(path, 0o500);
          }
          const meta: McpInstallationMetadata = {
            id,
            name: req.name,
            version: req.version,
            runtime: req.runtime,
            fileCount: files.length,
            totalBytes,
            createdAt: new Date().toISOString(),
          };
          const record: InstallationRecord = { meta, entrypoint, files: manifest.files };
          await writeFile(join(stage, "manifest.json"), JSON.stringify(record), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(stage, join(root!, "installations", id));
          installations.set(id, record);
          logger?.info("mcp.installation.created", {
            tokenId: auth.tokenId,
            id,
            name: req.name,
            version: req.version,
            fileCount: files.length,
            totalBytes,
          });
          return { ...meta };
        } finally {
          await rm(stage, { recursive: true, force: true });
        }
      });
    },
    async close() {
      if (stopped) {
        await tail;
        return;
      }
      stopped = true;
      await tail;
      if (root) await rm(join(root, ".lock"), { recursive: true, force: true });
    },
  };
}

function safePath(path: string): string {
  if (
    path.length > 512 ||
    !/^[a-zA-Z0-9._/-]+$/.test(path) ||
    path
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
          p.endsWith("."),
      )
  )
    bad("invalid MCP relative file path");
  return path;
}
function validateServer(input: unknown): McpServerPreset {
  const server = McpServerPreset.parse(input);
  if (server.type === "stdio") {
    if (!server.command || server.url || Object.keys(server.headers).length)
      bad("stdio MCP requires command and forbids url/headers");
  } else {
    if (
      !server.url ||
      !["http:", "https:"].includes(new URL(server.url).protocol) ||
      new URL(server.url).username ||
      new URL(server.url).password ||
      server.command ||
      server.args.length ||
      Object.keys(server.env).length
    )
      bad("HTTP/SSE MCP requires HTTP(S) URL and forbids command/args/env or URL credentials");
  }
  return server;
}
async function readRecord(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size > 2 * 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    bad("invalid MCP store file");
  return JSON.parse(await readFile(path, "utf8"));
}
async function runtimeCommand(
  runtime: McpInstallationMetadata["runtime"],
  entry: string,
): Promise<string> {
  const candidates =
    runtime === "native"
      ? [entry]
      : runtime === "node"
        ? [process.execPath]
        : runtime === "bun"
          ? ["/usr/local/bin/bun", "/usr/bin/bun"]
          : ["/usr/bin/python3", "/usr/local/bin/python3"];
  for (const path of candidates) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Try the next administrator-trusted executable location.
    }
  }
  return bad("requested MCP runtime is not available at a trusted executable path");
}
