## Context

parallel-code launches coding-agent CLIs in node-pty terminals, one per git
worktree. The agent catalog is a static `DEFAULT_AGENTS` array in
`electron/ipc/agents.ts`; each entry is an `AgentDef` (`{ id, name, command,
args, resume_args, skip_permissions_args, description, prompt_ready_delay_ms?,
mcp_config_flag? }`). `AgentDef` is **duplicated** — the canonical copy lives in
`src/ipc/types.ts` and a structurally identical copy in `electron/ipc/agents.ts`.

At launch the agent is started **interactively** with `args` (the initial prompt
is typed into the TUI afterward via bracketed paste, not passed as a CLI argument).
`buildTaskAgentArgs` appends `resume_args` on resume and `skip_permissions_args`
when the task opts into skip-permissions. Availability is probed with `which
<command>` (TTL-cached). The renderer's `AgentSelector` renders each agent as a
text button keyed off `agent.id` with **no per-agent icon or color map**, so a new
agent needs no front-end asset.

The Electron main process resolves the user's full login+interactive shell PATH
(`zsh/bash -ilc`, `electron/main.ts:52`), so binaries on `~/.local/bin` are
discoverable as long as the user's shell profile adds that directory.

For Docker-isolated tasks, `AGENT_CONFIG_DIRS` (`electron/ipc/pty.ts:707`) maps a
command basename to host config dirs that are bind-mounted into the container when
"Share agent auth" is enabled. The bundled `docker/Dockerfile` installs the other
agents via `npm install -g`.

Ground truth for `agy` (verified against the installed binary, v1.0.3 — `agy
--help`):

- Interactive launch: `agy`
- Resume most recent conversation: `-c` / `--continue`
- Skip permissions: `--dangerously-skip-permissions`
- Sandbox (`nsjail`/`sandbox-exec`) is **opt-in** via `--sandbox`; off by default.
- Non-interactive print mode: `-p` / `--print` (not used by this app).
- Config/app-data dir is `~/.gemini/antigravity-cli` (settings.json, mcp_config.json,
  plugins/, conversations/) — verified against the installed binary; it is **not**
  `~/.config/antigravity`. Interactive auth is OAuth cached in the OS keyring
  (Keychain/libsecret); `agy` has **no** API-key environment fallback (the
  `ANTIGRAVITY_API_KEY` variable is not consumed — confirmed behaviorally).

## Goals / Non-Goals

**Goals:**

- Add `agy` as a built-in default agent with correct launch/resume/skip-permission
  args, fully working on native (macOS/Linux) tasks.
- Ship the Docker bits that are additive and forward-compatible (bundle the `agy`
  binary, mount its config dir), while documenting clearly — in user-facing docs and
  the PR — that Docker-isolated Antigravity cannot authenticate and must be run
  natively.
- Keep Gemini CLI fully intact.
- Make the integration data-driven — no new IPC, no per-id special casing.

**Non-Goals:**

- Removing or deprecating Gemini CLI (separate future change).
- Wiring `agy`'s OAuth keyring credentials into Docker containers (not file-mountable).
- Supporting `agy --sandbox` inside Docker (nested sandbox; left off by default).
- A custom agent-branding/icon system.

## Decisions

**1. Launch interactively with `command: "agy"`, `args: []`.**
Matches every other agent: the app types the prompt into the live TUI rather than
passing `-p`. `-p`/`--print` is one-shot and prints-then-exits, which would defeat
the interactive session model. Rejected `-i`/`--prompt-interactive` because the app
already delivers the prompt via terminal input after a readiness delay.

**2. `resume_args: ["-c"]`, `skip_permissions_args: ["--dangerously-skip-permissions"]`.**
Both verified against the installed binary. `--dangerously-skip-permissions` is
real (it coincidentally matches Claude's flag); the Gemini `--yolo` flag does **not**
carry over.

**3. `prompt_ready_delay_ms` set to a modest stability delay (~1000 ms), mirroring
Copilot.** `agy`'s first interactive run shows onboarding (Google sign-in, theme,
file-permission prompts); steady-state runs still paint a TUI that needs a beat to
settle before auto-send. This only tunes the readiness recheck; it does not bypass
first-run OAuth, which is interactive regardless (same caveat as other agents).

**4. Omit `mcp_config_flag` AND exclude `agy` from the `--mcp-config` paths.** `agy`
has no `--mcp-config` flag (MCP is configured via plugins/config), so passing it would
break launch. Two code paths can emit it and both must exclude `agy`:

- `legacyMcpConfigArgs` (`src/lib/agent-args.ts`) injects `--mcp-config <path>` for any
  non-Codex command when a task carries a legacy `mcpConfigPath` and no `mcpLaunchArgs`
  — reachable only by older persisted tasks.
- `buildMcpLaunchArgs` (`electron/mcp/agent-args.ts`, imported by `coordinator.ts`) is
  the modern per-agent builder used by coordinator/MCP tasks.
  Excluding `agy` (the same way Codex is excluded via `isCodexCommand`) is the safe
  default: it guarantees `agy` is never handed an unsupported flag regardless of whether
  a given task takes the legacy or modern path. Leaving `mcp_config_flag` unset keeps it
  off the flag-driven path as well.

**5. Mount the config dir; Docker auth is unsupported (native only).** Add
`agy: ['.gemini/antigravity-cli']` to `AGENT_CONFIG_DIRS` so settings/plugins are
shared. Auth, however, cannot work in Docker: login credentials live in the host OS
keyring (Keychain/libsecret), which needs a secret-service daemon the agent container
does not run, and `agy` has no API-key environment fallback (the `ANTIGRAVITY_API_KEY`
claim was unverified and is false — behaviorally `agy` still enters OAuth with it set).
So Antigravity is documented as a native-only agent. The mount + bundled binary are
kept because they are additive and forward-compatible if a file-based or API-key auth
path appears.

**6. Install `agy` in the Docker image via the official installer, not npm.** `agy`
ships as a Go binary from `https://antigravity.google/cli/install.sh`, so the existing
`npm install -g` line cannot add it. The installer supports `-d|--dir`, so the step
installs straight to a system PATH dir:
`RUN curl -fsSL … | bash -s -- --dir /usr/local/bin && agy --version`. Verified the
script runs non-interactively when piped and `mkdir -p`s its target. The trailing
`agy --version` makes the build assert the install at image-build time.

## Risks / Trade-offs

- **Docker auth is impossible, not just limited** → `agy` login is keyring-only OAuth,
  the container has no secret-service daemon, and there is no API-key fallback, so an
  in-container `agy` cannot authenticate at all. Mitigation: native tasks work fully;
  docs and PR state plainly that Antigravity is native-only and Docker isolation is
  unsupported for it. The config-dir mount + bundled binary are kept as additive,
  forward-compatible scaffolding, not a working auth path.
- **PATH discovery** → If the user never ran the installer's PATH line, `~/.local/bin`
  is absent from the resolved shell PATH and `agy` shows "(not installed)". Mitigation:
  this is the same behavior as any un-PATHed agent; the availability probe degrades
  gracefully. Document running `agy install`.
- **`--mcp-config` injected by either MCP path** → `legacyMcpConfigArgs` (old tasks)
  or `buildMcpLaunchArgs` (coordinator tasks) could hand `agy` an unknown flag and
  break launch. Mitigation: exclude `agy` from both, the way Codex is excluded via
  `isCodexCommand` — chosen as the safe default rather than relying on the legacy path
  being unreachable. **Functional consequence (accepted):** `buildMcpLaunchArgs`
  returning `[]` for `agy` means Antigravity tasks receive no parallel-code MCP
  coordinator wiring — no in-`agy` subagent spawning. `agy` configures MCP via
  plugins/config rather than a CLI flag, so coordinator integration is a separate
  follow-up if desired; this change intentionally ships without it.
- **Installer-script drift in Docker builds** → Piping a remote installer into the
  image is less reproducible and could break builds if the URL/format changes.
  Mitigation: pin behavior to the documented installer; treat a failed fetch as a
  build error so it is caught at image-build time, not at task launch.
- **Duplicate `AgentDef` definitions drift** → The entry and the type live in two
  files. Mitigation: update both `electron/ipc/agents.ts` and `src/ipc/types.ts` in
  lockstep; TypeScript strict build catches shape mismatches.

## Migration Plan

Additive and behind agent availability detection — no data migration. `agy` appears
in the selector only when the binary is on PATH; existing Gemini tasks are untouched.
Rollback is removing the `DEFAULT_AGENTS` entry (and the Dockerfile/ config-dir
lines); no persisted state depends on it.

## Resolved Decisions

- **Antigravity is native-only; Docker isolation is unsupported for it.** The earlier
  `ANTIGRAVITY_API_KEY` Docker auth path was an unverified claim and is false. We keep
  the additive Docker scaffolding (bundled `agy` binary, mounted
  `~/.gemini/antigravity-cli` config dir) but document Antigravity as native-only.
  Decided with the user after the Codex review surfaced the wrong config path and the
  non-functional env var.
- **`agy` is excluded from both `--mcp-config` paths** (`legacyMcpConfigArgs` and
  `buildMcpLaunchArgs`), as the safe default — no dependence on the legacy path being
  unreachable.

## Open Questions

- In-container PATH is resolved: the installer's `--dir` flag installs `agy` to
  `/usr/local/bin` (on PATH for the non-root `agent` user); the build-step
  `agy --version` verifies it. A full `docker build` is the only step needing a Docker
  daemon.
- **Untested:** whether `agy` can read a file-based credential it shares with the
  Gemini CLI (`~/.gemini/gemini-credentials.json` / `google_accounts.json` sit in the
  parent dir). If it does, that could become a real Docker auth path later. Not claimed
  or relied on here.
