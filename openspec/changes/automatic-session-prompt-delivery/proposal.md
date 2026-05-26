# Automatic Session Prompt Delivery

## Why

The current take/release control model exposes an internal scheduler concept to
the user. A user has to know when a session is "coordinator controlled", when to
click "Take Control" before typing, and when to click "Release Control" so
queued coordinator prompts can be delivered. That is not intuitive, especially
when switching between a coordinator and its sub-tasks.

The same control flag also gates several different behaviors: whether the user
can type, whether automated prompts may be delivered, whether backend
`send_prompt` calls are rejected, and what UI state is shown. Those concerns need
different rules. A user typing into a task should temporarily pause automation,
not take durable ownership of the session.

## What Changes

Live sessions become user-interactive by default. Users can type into
coordinator sessions and sub-task sessions without first taking control.

Coordinator and system prompts are queued and delivered automatically when the
target session is safe for delivery. A session is not safe while the user has a
draft, terminal input is pending, the user has interacted recently, or the agent
is showing an interactive question or startup/trust dialog.

The UI explains queued delivery in terms of observable state, such as waiting for
the user's draft or waiting for the agent prompt. It no longer requires the user
to learn take/release control.

## Impact

- Affected capability: `session-prompt-delivery` (new capability spec).
- Removes the normal user-facing take/release control workflow.
- Preserves automated delivery of coordinator notifications, sub-task initial
  prompts, and coordinator follow-up prompts.
- Preserves landed/detached task behavior: closed or landed sessions still do
  not accept input.
- Existing persisted control metadata remains compatibility data and is not a
  user input gate.

## Out Of Scope

- Removing all legacy persisted `controlledBy` fields.
- Redesigning coordinator task ownership, self-landing, or merge semantics.
- Building a full multi-item prompt queue UI beyond the existing staged prompt
  behavior.
