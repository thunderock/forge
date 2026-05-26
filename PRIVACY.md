# Privacy Policy

_Last updated: 2026-05-26_

Parallel Code is an open-source desktop application that runs entirely on your local machine. This policy describes what data the application handles and how.

## Summary

**The Parallel Code project operates no remote servers and does not collect, transmit, or store your data on any infrastructure we control.**

- No analytics
- No telemetry
- No crash reporting
- No usage tracking
- No account, sign-up, or login
- No remote logging
- No advertising or third-party trackers

## What data Parallel Code handles

All data created or used by Parallel Code stays on your computer:

- **Your source code, git repositories, and worktrees** — read and written locally on your filesystem.
- **Task metadata, notes, prompts, settings, and UI state** — stored locally in the application's data directory.
- **Terminal sessions and shell output** — buffered locally for display; not transmitted anywhere by Parallel Code.

## Third-party AI coding CLIs

Parallel Code is a local interface for third-party AI coding CLIs that you install and configure yourself, including but not limited to:

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (Anthropic)
- [Codex CLI](https://github.com/openai/codex) (OpenAI)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (Google)
- [Copilot CLI](https://docs.github.com/en/copilot/concepts/agents/about-copilot-cli) (GitHub)

When you dispatch an agent, Parallel Code spawns the third-party CLI as a local subprocess. **That tool then communicates with its own vendor's servers under its own privacy policy and terms.** Parallel Code is not a party to those communications and does not proxy, log, or inspect them.

**You are responsible for reviewing the privacy policy and terms of each third-party tool you choose to use.** Data sent to those services — including prompts, source code, and conversation history — is governed by their policies, not this one.

## Network activity initiated by Parallel Code itself

Unlike the AI CLIs above, the following network requests are made by Parallel Code's own process. They only occur in the cases listed:

- **Application updates** — on packaged macOS and Linux AppImage builds, Parallel Code asks GitHub Releases whether a newer version exists, about ten seconds after launch. The request goes to the public GitHub Releases endpoint and carries the standard HTTP metadata (IP address, plus a User-Agent identifying the app name, version, OS, and architecture). No account, user ID, or telemetry payload is attached. Downloading an update only happens when you confirm it; the downloaded update is then applied automatically the next time you quit the app.
- **GitHub PR status** — when a task is linked to a GitHub pull request, Parallel Code invokes your locally installed `gh` CLI roughly every 30 seconds (while the task is visible) to fetch the PR's state and check status. The `gh` CLI then contacts GitHub under your own existing authentication.
- **Other git operations** — only when you explicitly invoke them (push, pull, fetch) against your configured git remote, using your local `git` tooling and its credentials.
- **Inline code Q&A via MiniMax** — when you enable the optional [MiniMax](https://www.minimax.io/) provider in Settings and ask a question about a code selection, Parallel Code itself makes an HTTPS request to `api.minimax.io` using your API key. The request body includes your question, the path of the file you selected from, and the selected code snippet. The API key is held in the main process in memory only (it is never sent back to the renderer or transmitted to any server other than MiniMax). The conversation is governed by MiniMax's privacy policy. If you do not configure a MiniMax key, no MiniMax traffic occurs.
- **Mobile monitoring** — when you start it from the Remote Access settings, Parallel Code runs a local HTTP and WebSocket listener bound to all of your machine's network interfaces (so devices on your LAN or Tailscale network can reach it). The listener requires a session-scoped bearer token, generated on each start and never persisted; an authenticated client can see your running agents, recent terminal output, and send input or stop agents. Stop the server to close the listener. No traffic from this feature passes through any third party.

None of this traffic is routed through servers operated by the Parallel Code project.

## Local storage locations

Configuration and state are kept in standard per-OS application directories — on macOS under `~/Library/Application Support/Parallel Code`, on Linux under `~/.config/Parallel Code`. Inside the git repositories you point the app at, Parallel Code also creates a `.claude/` directory (for agent step tracking, e.g. `.claude/steps.json`) and a `.parallel-code/` directory (for MCP coordinator state when sub-tasks are used). You can delete any of these at any time.

## Children's privacy

Parallel Code is a developer tool. It does not collect personal data from anyone, including children.

## Changes to this policy

If this policy changes, the update will appear in this file in the project repository. The "Last updated" date above reflects the current version.

## Contact

Questions or concerns can be raised as an issue on the [GitHub repository](https://github.com/johannesjo/parallel-code/issues).
