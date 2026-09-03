# omni-acp

An open-source remote-ization and multi-agent management layer for
[ACP](https://agentclientprotocol.com) coding agents.

One daemon supervises many agent processes, gives each one a durable event log with a monotonic
cursor, and exposes them over a small HTTP control plane — so an ACP agent that only speaks stdio to
a single local editor becomes something several clients can drive, from anywhere, at the same time.

## Status

**M0 scaffold.** Every package is present with its complete, frozen public surface; the bodies throw
`unimplemented`. The build, the test runner and the three-OS CI matrix are green before any behaviour
exists, which is the point — see `docs/M0-PLAN.md` §1.

## Layout

| Package              | What it is                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@omni-acp/protocol` | Wire types, ids, errors, zod schemas, and `reduceTurn` — the one pure turn aggregator shared by the daemon and the client |
| `@omni-acp/testkit`  | Private. In-memory ACP streams, fake supervisor/clock/ids, fixture agents                                                 |
| `@omni-acp/core`     | Supervisor and process ownership, event log, normalizer, worker kernel                                                    |
| `@omni-acp/daemon`   | `createDaemon()` (library first) plus a zero-business-logic HTTP adapter                                                  |
| `@omni-acp/client`   | `OmniACP.connect()` / `OmniACP.local()`, `Server`, `Worker`                                                               |
| `@omni-acp/cli`      | `omni-acp start`                                                                                                          |

## Develop

```sh
corepack enable
pnpm install
pnpm -r build && pnpm -r test
```

Tests run against each package's built `dist`, so `build` comes first — that is what catches the
wrong-`.js`-specifier and `exports`-map mistakes that source aliasing hides.

## Documents

- `docs/DESIGN.md` — v0.8, decisions D1–D15, binding
- `docs/CONTRACTS.md` — M0 code-level contract: every signature in the repository
- `docs/M0-PLAN.md` — work packages, ownership map, acceptance script

Apache-2.0.
