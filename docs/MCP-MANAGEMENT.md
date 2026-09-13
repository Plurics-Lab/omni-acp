# Remote MCP management

See [native Claude Code and Codex acceptance results](MCP-MANAGEMENT-LIVE-TEST.md)
for the real-agent tests and their exact scope.

MCP management is a daemon control-plane feature. It deploys a **prebuilt** MCP
program to the remote daemon's machine, registers its launch configuration, and
lets an authorized client select that preset when creating a worker. It does not
ask the model to install software, modify an agent's global settings, or add tools
to an already-running conversation.

The agent's ACP adapter must actually connect the `session/new.mcpServers` it
receives and expose those tools to the model. Advertising MCP capabilities is not
an end-to-end test.

## Authority and deployment

Management is disabled unless the operator sets an explicit
`mcpManagement.directory`. This directory must be outside all token workspace
roots. Management mutations require `role: admin` **and** `mcpManage: true`;
artifact installation instead requires `role: admin` and `mcpInstall: true`.
These are independent grants; a deployment administrator typically needs both.
Both token permissions default to false. A normal token still
selects only names allowed by its `mcpPresets` list.

This is permission to deploy executable code, not ordinary tool-use permission.
Use a trusted administrator connection. Registry responses contain metadata,
never launch environment values, HTTP authorization headers, or uploaded file
contents. Installation does not execute uploaded files, download dependencies,
run package-manager hooks, or invoke a shell.

`server.me` reports `mcpManage`, `mcpInstall`, and `mcpManagementEnabled` on
connection. Older daemons may omit these fields. Successful registration,
deletion, and installation emit `mcp.preset.registered`, `mcp.preset.deleted`,
and `mcp.installation.created` logger events with actor/resource identifiers,
not uploaded contents or launch secrets.

Daemon filesystem ownership is not an OS sandbox: an agent running as the same
OS user can have access beyond its initial working directory. Use separate OS
users, containers, or VMs for untrusted workers. When workers run in containers,
the operator must also make the installed program and its runtime available at
the resolved path inside that container.

## Configuration and SDK example

Merge the following into the remote daemon's YAML. Replace the placeholder
digests with SHA-256 hashes of separately generated random bearer tokens; never
use example values as credentials. The service account must own the management
directory with mode `0700`.

```yaml
mcpManagement:
  directory: /var/lib/omni-acp/mcp
  maxUploadBytes: 16777216
  maxFiles: 128
  maxInstallations: 32

tokens:
  - id: deployer
    secretSha256: "<64 lowercase hex characters>"
    role: admin
    cwdRoots: ["/srv/workspaces"]
    mcpManage: true
    mcpInstall: true
    mcpPresets: []
  - id: worker-user
    secretSha256: "<a different 64-character digest>"
    role: user
    cwdRoots: ["/srv/workspaces"]
    agents: ["your-acp-agent"]
    mcpPresets: ["desktop-cu-v1"]
```

Start the daemon with `omni-acp start --config /path/to/daemon.yaml`. Non-loopback
management mutations are refused by default. Prefer an SSH tunnel to loopback;
behind a trusted TLS terminator the operator may explicitly set
`mcpManagement.allowInsecureTransport: true`. That flag is a trust override, not
TLS implementation or proxy verification: do not expose the plaintext origin.

Using the SDK on the administrator's machine:

```ts
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { OmniACP } from "@omni-acp/client";

const admin = await OmniACP.connect({ url, token: deploymentToken });
const bytes = await readFile("./dist/desktop-mcp.mjs"); // a self-contained bundle
const installed = await admin.mcp.install({
  name: "desktop-cu",
  version: "1.0.0",
  runtime: "node",
  entrypoint: "main.mjs",
  files: [{
    path: "main.mjs",
    dataBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }],
});
await admin.mcp.register({
  name: "desktop-cu-v1",
  installationId: installed.id,
  args: ["--stdio"],
  env: { DISPLAY: ":99" },
});
await admin.close();

const user = await OmniACP.connect({ url, token: workerToken });
const worker = await user.createAgent("your-acp-agent", {
  cwd: "/srv/workspaces/demo",
  mcp: ["desktop-cu-v1"],
});
```

For an existing service use `admin.mcp.register({name, server: {type: "http",
url: "https://mcp.example.com/mcp", headers: {Authorization: "Bearer …"}}})`.
An existing stdio program uses `server: {type: "stdio", command:
"/absolute/path/to/program", args: [], env: {}}`. Registration does not probe
the service or prove the agent can use it; test tool listing, calls and images
through the actual adapter before production use.

## HTTP and SDK surface

| HTTP endpoint | SDK method | Access |
| --- | --- | --- |
| `GET /v1/mcp/presets` | `server.mcp.list()` | Admin: all; user: allowed names only |
| `GET /v1/mcp/presets/:name` | `server.mcp.get(name)` | Same visibility; hidden names return 404 |
| `POST /v1/mcp/presets` | `server.mcp.register(input)` | Admin + `mcpManage` |
| `DELETE /v1/mcp/presets/:name` | `server.mcp.remove(name)` | Admin + `mcpManage` |
| `POST /v1/mcp/installations` | `server.mcp.install(input)` | Admin + `mcpInstall` |
| `GET /v1/mcp/installations` | `server.mcp.installations()` | Admin |
| `GET /v1/mcp/installations/:id` | `server.mcp.installation(id)` | Admin |

Collection HTTP responses are `{presets: [...]}` or `{installations: [...]}`;
the SDK unwraps the array. Creation returns metadata with status 201; deletion
returns `{}` with status 200. Invalid manifests return 400, missing permission
or disabled management 403, unknown/hidden resources `mcp_not_found` (404), and
name collisions/store conflicts `mcp_conflict` (409).

## Version and lifecycle rules

Preset names are immutable. Publish a new name (for example `desktop-cu-v2`) to
upgrade, then explicitly select it for new workers. Static YAML presets cannot
be overwritten or deleted through management APIs. Deleted managed names remain
reserved so a sleeping worker cannot silently reconnect to different code under
the same name.

Removing a preset is **not immediate revocation** of a running tool connection.
Existing workers may already hold a resolved configuration or a live MCP process.
Close affected workers to revoke that access. There is no `worker.setMcp()` hot
reload in this release. Installed artifacts are retained; automatic uninstall
and garbage collection are deliberately not provided.

The persistent store uses an exclusive lock. Graceful daemon shutdown releases
it; after a crash, an operator must confirm that no owning daemon is running
before recovering the stale `.lock` directory. A second daemon must not share
the same management directory concurrently. A retry of an identical successful
installation returns its existing content-derived ID.

## Installation format

Upload a manifest with a name, version, runtime, entrypoint, and files. Each file
has a relative path, Base64 bytes and a SHA-256 digest. Supported runtime labels
are `native`, `node`, `bun`, and `python3`. A native executable must already match
the remote OS/architecture; interpreted bundles must include their application
dependencies, and their interpreter must be installed on the remote host.

Run this daemon with Node: the `node` runtime uses the daemon's own
`process.execPath`. Bun is resolved at `/usr/local/bin/bun` or `/usr/bin/bun`;
Python at `/usr/bin/python3` or `/usr/local/bin/python3`, not a worker-controlled
`PATH`. For another runtime location, register an administrator-approved stdio
command explicitly. This implementation was exercised on Linux; it is not an
acceptance claim for every operating system or every MCP package.

This is not a tar/zip unpacker or a generic `npm install` endpoint. There are file
count and byte limits; traversal, symlinks and invalid digests must fail before
an installation is published. Build locally or in CI, then upload the resulting
bundle. Registering an already-running HTTP/SSE MCP requires no artifact upload;
its URL must be reachable from the worker's network namespace, not just from the
SDK client's laptop.

## Computer Use

Installing a desktop MCP does not grant desktop access by itself. The operator
must separately provide its desktop permission profile, runtime dependencies,
and an isolated display. Multiple workers need separate displays or a shared
desktop lock. An application allowlist is not screenshot isolation or an OS
security boundary. Keep these checks inside the MCP execution service rather
than relying on model instructions.
