## Why

Google is transitioning the Gemini CLI to the new **Antigravity CLI** (`agy`). On
**June 18, 2026** Gemini CLI stops serving Google AI Pro/Ultra and free Code Assist
users; it remains only on paid/enterprise API keys. Users who pick the "Gemini CLI"
agent today will increasingly hit a dead end, while `agy` becomes the supported
Google terminal agent. parallel-code should offer Antigravity CLI as a first-class
agent so users have a working migration path — without yet removing Gemini CLI,
which paid/enterprise users still rely on.

## What Changes

- Add **Antigravity CLI** (`agy`) as a built-in default agent alongside Claude Code,
  Codex, Gemini CLI, OpenCode, and Copilot.
- Register its launch contract: interactive launch (`agy`), resume (`-c`), and
  skip-permissions (`--dangerously-skip-permissions`).
- Add its config directory (`~/.gemini/antigravity-cli`) to the Docker shared-auth
  mount map for settings/plugins, and document that Antigravity is **native-only**:
  its login credentials live in the OS keyring (no secret-service daemon in the
  container) and `agy` has no API-key env fallback, so Docker-isolated Antigravity
  cannot authenticate.
- Install `agy` in the bundled Docker agent image (via the official installer script,
  not npm) so the binary is present and the integration is forward-compatible.
- Keep Gemini CLI unchanged. **No removal, no breaking change.**

## Capabilities

### New Capabilities

- `agent-cli-registry`: The set of coding-agent CLIs parallel-code can launch, and the
  per-agent contract (command, launch/resume/skip-permission arguments, availability
  detection, config-directory auth mounting for Docker isolation) that governs how each
  agent is started, resumed, and authenticated.

### Modified Capabilities

<!-- None: no existing capability spec governs the agent registry today. -->

## Impact

- **Code:** `electron/ipc/agents.ts` (`DEFAULT_AGENTS`), `src/ipc/types.ts` +
  `electron/ipc/agents.ts` (`AgentDef` — duplicated, both updated),
  `electron/ipc/pty.ts` (`AGENT_CONFIG_DIRS`), `docker/Dockerfile` (install `agy`).
- **No new IPC channels or payload-type changes** — Antigravity reuses the existing
  data-driven `AgentDef` plumbing; the selector renders it from the agent list with no
  per-id branding.
- **Dependencies:** the Docker image gains the `agy` binary fetched from
  `https://antigravity.google/cli/install.sh`.
- **Tests:** agent-registry and persistence tests that enumerate agents may need the
  new entry accounted for.
