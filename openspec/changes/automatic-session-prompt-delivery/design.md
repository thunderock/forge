# Design - Automatic Session Prompt Delivery

## Problem

The existing control model conflates user input permission with automation
delivery permission. "Coordinator control" blocks terminal input and the prompt
textarea, while "human control" blocks backend prompt delivery until the user
manually releases control. This makes prompt routing safe only when the user
understands the mode switch.

The desired model is activity-based:

- users can interact with any live session.
- automation waits when the user is actively interacting or has unsent input.
- automation resumes automatically when the session is safe.

## Delivery Arbiters

Most prompt auto-delivery should be decided by a renderer-side arbiter. The
renderer has the local information needed to make this decision: prompt draft
contents, recent input timestamps, terminal activity, question detection, and the
latest terminal tail.

The arbiter should consider a staged automation prompt deliverable only when all
of these are true:

- the staged prompt has reached its earliest delivery time.
- the user has no non-empty prompt textarea draft.
- the terminal has no known pending user input.
- the user activity lease has expired.
- no question/dialog is active.
- startup and trust-dialog blockers are absent.
- the agent prompt marker is visible, or the existing coordinator promptless
  grace period has expired.

The arbiter should return explicit waiting reasons so the UI can describe why a
prompt is queued.

Coordinated sub-task initial assignment delivery is the exception. It must be
owned by the backend coordinator because background sub-task panels may not be
mounted in the renderer. The backend already owns sub-task creation and PTY
output monitoring, so it should keep the initial assignment queued and write it
once the sub-task prompt marker is visible. The renderer must not be required to
mount `PromptInput` before a sub-task can start work.

## Prompt Drafts

Prompt textarea content is user-owned unless it exactly matches the staged
automation prompt. If the user starts typing and goes idle, automation must not
append to or overwrite that half-written prompt. Delivery waits until the user
sends, clears, or otherwise resolves the draft.

Staged automation text should remain staged state. It should not replace a user
draft in the prompt textarea.

## Terminal Drafts

Terminal line editors are harder to inspect than the prompt textarea. The first
pass should be conservative:

- mark terminal input as pending when the user sends printable text or paste data
  to the PTY.
- clear pending terminal input on Enter/Return, Ctrl-C, or Ctrl-U.
- keep automation blocked if the app is unsure whether terminal text remains
  pending.

This can delay automation, but it avoids injecting coordinator text into a
half-written terminal line.

## User Activity Lease

User activity should create a short transient automation hold. Activity includes
typing or pasting into the prompt textarea, sending prompt text, typing or
pasting into the terminal, and interactive question handoff.

The lease is not a durable mode and is not exposed as "human control". Each new
activity extends the hold. When the hold expires and no draft/question blockers
remain, staged automation can send.

## Backend Prompt Semantics

Backend prompt delivery should not fail merely because a user recently
interacted with a task. The renderer-owned delivery arbiter should decide when a
prompt can safely be written to the PTY.

Existing backend and persisted control metadata can remain for compatibility,
but it should no longer be the normal user-facing input gate. If a prompt cannot
be delivered immediately because the user is active, it should remain queued or
staged for later delivery rather than requiring a manual release action.

## UI

The normal UI should not show "Take Control" or "Release Control". Instead, it
should show delivery status based on the arbiter reason, for example:

- queued, waiting for your draft.
- queued, waiting for terminal input.
- queued, waiting for idle.
- queued, waiting for agent prompt.
- sending when ready.

The prompt textarea and terminal remain enabled for live tasks. Landed or
detached tasks still disable input because there is no live PTY to receive it.

## Compatibility

Existing persisted `controlledBy` data can remain in saved state and task sync
payloads during the transition. Code should treat it as legacy compatibility
metadata rather than as permission for the user to type.

A later cleanup can remove or rename that metadata after the activity-based
delivery model has settled.
