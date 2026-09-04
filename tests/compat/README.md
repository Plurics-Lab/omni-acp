# The compat suite

The identical SDK script, run against every configured agent (`docs/CONTRACTS.md` §18,
`docs/M1-PLAN.md` §4). DESIGN §11's M1 criterion — _同一份 SDK 代码对多个 v1 目标 agent 行为一致_ —
made mechanical, with `verdict` and `stopReason` as the equality surface rather than raw payloads.

**The agent list is configuration. Adding an agent is a YAML edit with zero code changes**, and two
tests prove it rather than asserting it (`tests/compat/src/yaml-only.ctest.ts`).

---

## Running it

```bash
pnpm -r build            # the suites import packages BY NAME, which resolves to dist/
pnpm --filter @omni-acp/compat-tests test
```

That runs `agents.ci.yaml`: the SDK example agent plus the eight turn-completing testkit fixtures.
It is hermetic — no login, no network, no cost — and it runs on all three OSes in CI.

| variable                    | effect                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `OMNI_COMPAT_CONFIG=<path>` | which agents file to read. Default `agents.ci.yaml`; relative paths resolve against `tests/compat/` |
| `OMNI_COMPAT_AGENTS=a,b`    | an allow-list. Everything else becomes a `config` skip naming the variable                          |
| `OMNI_COMPAT_REAL=1`        | enables entries that need a login or the network. Without it they are `precondition` skips          |
| `OMNI_COMPAT_REQUIRE=1`     | **fails** an empty selection, so a mis-set variable cannot masquerade as a pass                     |

The real run, which is `workflow_dispatch` / local only:

```bash
OMNI_COMPAT_REAL=1 OMNI_COMPAT_CONFIG=agents.local.yaml \
  pnpm --filter @omni-acp/compat-tests test
```

Every run writes `tests/compat/vitest-report/compat-report.json` **unconditionally** — including a
run whose selection was empty, which is the run a reader most needs to see. That path is inside the
directory CI's failure-artifact step already collects (`**/vitest-report/**`).

---

## Adding an agent — the whole procedure

Append an entry to `agents.local.yaml` (real agents) or `agents.ci.yaml` (hermetic ones). **Do not
touch a `.ts` file.** A test asserts that no TypeScript source in this repository contains a real
agent's launch argv, so a code change here would fail the build rather than pass unnoticed.

```yaml
- id: codex-acp # the agent id: the daemon's `agents[].id`, and the report's row label
  source: command # sdk-example | fixture | command
  enabled: true
  command: npx
  args: ["-y", "@openai/codex-acp@1.2.3"]

  # §6.3 REFUSES an `npx` .cmd shim on Windows, so an npx-launched runtime needs the
  # direct-module form there. It is DATA, not a branch — otherwise "adding an agent is a YAML
  # edit" would be false for every npx-launched runtime.
  #   ${execPath}                    -> process.execPath
  #   ${npxResolved:<pkg>@<version>} -> require.resolve("<pkg>")
  windows:
    command: "${execPath}"
    args: ["${npxResolved:@openai/codex-acp@1.2.3}"]

  # Unmet ⇒ a `precondition` skip with a printed reason, never a pass and never a red build.
  # `login` cannot be verified from here, so OMNI_COMPAT_REAL=1 is the operator's assertion
  # that this machine has it; `env` names variables that must be set and non-empty.
  requires: { login: "openai", env: ["OPENAI_API_KEY"] }

  # What this runtime is expected to EXERCISE. `resume` is deliberately absent: the probe
  # measures it (`ProbeSummary.resumeMethod`) and a YAML that claimed otherwise would be a
  # second opinion about a fact we measure. These three cannot be probed for — no method
  # battery can tell you whether an agent will reach for a tool when you ask it something.
  provides: [tools, permission, cancel]

  # A `RuntimeOverlay` (`AgentDescriptor.runtime`), forwarded to the daemon verbatim. This is
  # how a runtime with no builtin descriptor declares its quirks.
  runtime:
    quirks: { resumeRequiresSameCwd: true }

  budgets: { initializeMs: 30000, resumeMs: 30000, turnMs: 300000 }

  expect:
    protocolVersion: 1
    capabilities: { loadSession: true }

  # The `config` skip source. EVERY reason is required and must be at least 10 characters —
  # a load error otherwise, because a skip nobody can argue with is the only kind worth having.
  skip:
    - { case: plan-update, reason: "no todo/plan tool in this build (observed 2026-09-04)" }

  # Corpus gaps — the `capability` skip source. For an agent with a builtin descriptor this
  # MIRRORS §17.2's `unverified` and never a shorter list; for one without, it is where an
  # operator records what has not been checked.
  unverified: [image_content, authenticate]
```

Then run it once and read the report:

```bash
OMNI_COMPAT_REAL=1 OMNI_COMPAT_CONFIG=agents.local.yaml \
  OMNI_COMPAT_AGENTS=codex-acp OMNI_COMPAT_REQUIRE=1 \
  pnpm --filter @omni-acp/compat-tests test
```

`OMNI_COMPAT_REQUIRE=1` is worth having on that first run: if the entry is mis-spelled, or its
`requires` is unmet, the selection is empty and the suite **fails** instead of quietly passing.

---

## Skips carry a source, and a skip with no source is a failure

| source         | meaning                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`       | an explicit `skip:` entry in the YAML. `reason` is required, minimum 10 characters                                                                              |
| `capability`   | the **probe** says this runtime lacks what the case requires, or the row appears in the resolved descriptor's `unverified` (§17.2 — the single source of truth) |
| `precondition` | `requires.login` / `requires.env` unsatisfied on this machine                                                                                                   |

The `config` source outranks `capability`: a case that is both skipped and unsupported reports the
reason somebody actually wrote.

---

## The cases

`tests/compat/src/cases.ts`, in the order §4 runs them. Each declares what it `requires`, and an
agent that lacks a requirement **skips** the case with a printed source rather than failing it.

| case                  | requires     | asserts                                                                                                                                                                                                                  |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `handshake`           | —            | initialize + `session/new`; `capabilities.raw` non-empty; `runtimeId` stable across two workers; `generation` 1; `persistence: durable`                                                                                  |
| `plain-turn`          | —            | exactly one `state_update{running}` … one `{idle}`; non-empty text; `verdict: "ok"`; `GET /turns/{id}` deep-equals the `prompt()` aggregate                                                                              |
| `tool-turn`           | `tools`      | a READ-ONLY prompt yields ≥1 tool call with a terminal final status, and `changes` matches the workspace                                                                                                                 |
| `stream-resume`       | —            | the SSE dropped mid-turn and reconnected with `?since=`; the union's **envelope frames** equal an uninterrupted observer's and are gap-free. Control frames asserted separately                                          |
| `cancel-late-update`  | `cancel`     | an update arriving after `session/cancel` is ordered **before** `idle`                                                                                                                                                   |
| `tool-merge`          | `tools`      | a sparse `tool_call_update` never clears `kind` / `locations` / `title`                                                                                                                                                  |
| `permission-deny`     | `permission` | only an **offered** `optionId` is ever sent; `deniedToolCalls` non-empty while `stopReason` is `end_turn`; the workspace is untouched                                                                                    |
| `hibernate-wake`      | `resume`     | a small `idleTimeoutMs` forces `hibernated`; the recorded pid answers `waitGone`; the lease is released; the next prompt wakes with `resume.outcome: "landed"`; `seq` continues; replay is marked only inside the window |
| `resume-cwd-mismatch` | `resume`     | resuming from a FOREIGN cwd is refused with a message that must **not** classify `rejected_permanent`                                                                                                                    |
| `lease`               | —            | a second client's `prompt` is `423` naming the holder; the observer keeps streaming; `steal` bumps the epoch; the previous holder's next call is `423`                                                                   |
| `restart-survives`    | —            | stop, restart on the same `dataDir`, `?since=` returns the same envelopes with the same `seq`                                                                                                                            |
| `unknown-method`      | —            | the probe battery's invented methods come back as `unsupportedMethods`                                                                                                                                                   |
| `idempotent-map`      | —            | no v1-only `sessionUpdate` kind survives at `payloadVersion: 2`; `reduceTurn` is a fixed point over duplicated envelopes                                                                                                 |

---

## Why `agents.local.yaml` has exactly one entry

Because exactly one real ACP agent is available on the machine this milestone was built on:
`claude-acp` (`npx -y @agentclientprotocol/claude-agent-acp@0.73.0`, a logged-in Claude Code), and
`docs/research/transcripts/claude-acp-0.73.0/` is its recorded ground truth. `codex-acp`, `gemini`,
`opencode` and `kimi` are **not installed and must not be installed here**; they are YAML entries
somebody else adds later, with no code change.

`docs/CONTRACTS.md` §11.6 records honestly that with one real agent DESIGN §11's criterion is **not
falsifiable**, and that this suite is a partial satisfaction of it rather than a claimed one.
