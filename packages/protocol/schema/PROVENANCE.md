# Schema provenance

Both files are copied **verbatim** from `@agentclientprotocol/sdk` at the exact version this
repository pins, and are never hand-edited. They are committed rather than read out of
`node_modules` for one reason: D7 pins the SDK to exactly `1.4.0`, and `experimental/v2` may
change shape between SDK releases (CONTRACTS.md §11.3). A committed copy makes an unintended
shape change show up as a diff in a pull request instead of as a runtime surprise.

| File | Source in the SDK package | sha256 |
|---|---|---|
| `v1.schema.json` | `schema/schema.json` | `7f77702b34e0a0558e77220e9007bf8ee161a976bb8ac5021aba1b7e7b2c5708` |
| `v2.schema.unstable.json` | `schema/v2/schema.unstable.json` | `bbdf4ad0e4a07751860afbaf3de800a5c7f9f714f3621f8e667f232709dc497d` |

- SDK: `@agentclientprotocol/sdk`
- Version: `1.4.0` (exact, no caret — asserted by the `sdk-version-pinned` guard, WP-1)
- License: Apache-2.0, (c) Zed Industries
- Copied: 2026-09-03, by the M0 scaffold step

M0 uses `experimental/v2` for **types only**, never at runtime. These JSON documents are
reference material and validation input for later milestones; nothing in M0 loads them.

## Refreshing

Bumping the SDK is a renegotiation of CONTRACTS.md §1, not a commit. When it happens, re-copy both
files from the new package, update the version and the digests in this table, and re-run
`pnpm -r test`.
