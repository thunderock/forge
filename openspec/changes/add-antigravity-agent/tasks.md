## 1. Register the agent

- [x] 1.1 Add an `antigravity` entry to `DEFAULT_AGENTS` in `electron/ipc/agents.ts`: `id: 'antigravity'`, `name: 'Antigravity CLI'`, `command: 'agy'`, `args: []`, `resume_args: ['-c']`, `skip_permissions_args: ['--dangerously-skip-permissions']`, a description, and `prompt_ready_delay_ms: 1000`.
- [x] 1.2 Confirm `AgentDef` in `src/ipc/types.ts` already covers every field used (it does today); update it only if a new field is introduced, keeping it in lockstep with the `electron/ipc/agents.ts` copy.
- [x] 1.3 Do NOT set `mcp_config_flag` for the entry (agy has no `--mcp-config` flag).

## 2. Docker isolation support

- [x] 2.1 Add `agy: ['.gemini/antigravity-cli']` to `AGENT_CONFIG_DIRS` in `electron/ipc/pty.ts`. (Corrected from `.config/antigravity` — verified against the installed binary: `agy` v1.0.3 writes its app data to `~/.gemini/antigravity-cli`, and `~/.config/antigravity` does not exist.)
- [x] 2.2 ~~Forward `ANTIGRAVITY_API_KEY` into the container.~~ **Dropped.** `agy` does not consume any API-key env var (the `ANTIGRAVITY_API_KEY` claim was unverified and is false — Codex confirmed `agy` still enters OAuth with it set). Docker-isolated `agy` cannot authenticate (keyring-only OAuth, no secret-service daemon in the container); Antigravity is native-only.
- [x] 2.3 Add a Docker image step in `docker/Dockerfile` to install `agy` via `curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin` (separate from the `npm install -g` line). Ground-truthed the installer script: it supports `-d|--dir`, runs non-interactively when piped (no `read` prompts), and `mkdir -p`s the target; installing straight to `/usr/local/bin` puts `agy` on PATH for the non-root `agent` user.
- [x] 2.4 Confirm `agy --version` resolves from the install. The Dockerfile RUN ends with `&& agy --version`, so the image build itself asserts the binary is installed and on PATH — a failed install fails the build. Full `docker build` run still pending Docker (this env has no daemon), but the verification is now baked into the build step.

## 3. MCP-config guard (exclude agy from both paths)

- [x] 3.1 Exclude `agy` from `legacyMcpConfigArgs` in `src/lib/agent-args.ts` so a task with only a legacy `mcpConfigPath` is not handed `--mcp-config` (same treatment as `isCodexCommand` for Codex).
- [x] 3.2 Exclude `agy` from `buildMcpLaunchArgs` in `electron/mcp/agent-args.ts` (imported by `coordinator.ts`) so coordinator/MCP tasks never emit `--mcp-config` for `agy`.
- [x] 3.3 Add/adjust a unit test asserting `buildTaskAgentArgs`/`buildMcpLaunchArgs` emit no `--mcp-config` for the `agy` command.

## 4. Verification

- [x] 4.1 `npm run typecheck` clean across renderer and electron targets — 0 errors (after restoring deps; see note below).
- [x] 4.2 Run the agent-registry and persistence tests: `persistence.test.ts`, `agents.test.ts`, `src/lib/agent-args.test.ts`, `electron/mcp/agent-args.test.ts`, `pty.test.ts` — 111 tests pass. `pty.test.ts` config-dir-mount table extended with `agy`.
- [ ] 4.3 Manual native smoke test: with `agy` installed, the selector shows "Antigravity CLI" available; start a task, confirm the prompt is delivered and the session runs; resume a task and confirm `-c` is used. **Pending** — needs the running app.
- [ ] 4.4 Manual skip-permissions smoke test: start an Antigravity task with skip-permissions enabled and confirm `--dangerously-skip-permissions` is passed. **Pending** — needs the running app.
- [x] 4.5 `openspec validate --all --strict` passes.

## 5. Docs & PR

- [x] 5.1 Document in user-facing docs that Antigravity is native-only: login is keyring-only OAuth, the container has no secret-service daemon, and `agy` has no API-key fallback, so Docker-isolated Antigravity cannot authenticate. Added to `README.md` (Antigravity in the CLI install list + a "run natively, not in Docker isolation" details block).
- [x] 5.2 Call out the same native-only constraint in the PR description (works natively; Docker isolation unsupported for Antigravity), so reviewers and users see it up front. Drafted in `/tmp/pr-body.md` (use with `gh pr create --body-file`).
