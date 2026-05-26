# Tasks

- [x] Add a renderer-side delivery arbiter with explicit wait reasons.
- [x] Add tests for user prompt drafts, terminal pending input, recent user
      activity, questions/dialogs, prompt marker delivery, and coordinator
      promptless grace.
- [x] Stop disabling live terminal stdin solely because a task is
      coordinator-controlled.
- [x] Stop disabling the prompt textarea solely because a task is
      coordinator-controlled.
- [x] Track per-task user activity leases for prompt and terminal interaction.
- [x] Track conservative terminal pending-input state and clear it on submit or
      cancel keys.
- [x] Keep staged automation prompts queued when the user has a prompt draft
      instead of overwriting or appending to that draft.
- [x] Replace normal take/release control UI copy with queued-delivery status
      copy.
- [x] Adjust backend prompt handling so user activity queues delivery instead of
      requiring a manual release action.
- [x] Move coordinated sub-task initial assignment delivery to the backend so
      background sub-tasks do not depend on mounted renderer panels.
- [x] Add a coordinator-run log checker for fast manual e2e triage of missing
      initial prompt delivery and startup control handoff races.
- [x] Add an opt-in real-PTY fake-agent integration suite for Codex, Claude,
      Gemini, and Copilot startup prompt delivery.
- [x] Validate with focused Vitest suites for prompt delivery/control behavior.
- [x] Run `openspec validate automatic-session-prompt-delivery --strict`,
      focused tests, `npm run check`, and `npm test`.
