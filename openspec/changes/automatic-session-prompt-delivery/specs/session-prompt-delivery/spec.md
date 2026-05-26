# Session Prompt Delivery Specification

## ADDED Requirements

### Requirement: Live sessions accept user input without manual control transfer

The app SHALL allow the user to type into any live coordinator or sub-task
session without first taking control of that session.

#### Scenario: User types into a coordinated sub-task

- **GIVEN** a coordinated sub-task has a live PTY
- **WHEN** the user types into the sub-task terminal or prompt input
- **THEN** the app accepts the user input without requiring a take-control action

#### Scenario: Landed task remains detached

- **GIVEN** a task has landed and its PTY has been detached or cleaned up
- **WHEN** the user attempts to type into that task
- **THEN** the app does not forward input to the removed task agent

### Requirement: Automation waits while the user has a prompt draft

The app SHALL NOT deliver an automated prompt into a session while the user has
non-empty unsent prompt text in that session.

#### Scenario: User draft blocks queued automation

- **GIVEN** an automated prompt is queued for a session
- **AND** the user has typed unsent prompt text in that session
- **WHEN** the user stops typing but leaves the draft unsent
- **THEN** the automated prompt remains queued
- **AND** the app does not overwrite, append to, or send the user's draft

#### Scenario: Clearing a draft allows delivery

- **GIVEN** an automated prompt is queued for a session
- **AND** the user draft previously blocked delivery
- **WHEN** the user clears the draft
- **AND** all other delivery blockers are absent
- **THEN** the app delivers the queued automated prompt

### Requirement: Automation waits while terminal input may be pending

The app SHALL NOT deliver an automated prompt into a session while terminal
input typed by the user may still be pending in the terminal line editor.

#### Scenario: Half-written terminal line blocks automation

- **GIVEN** an automated prompt is queued for a session
- **WHEN** the user types terminal input without submitting or canceling it
- **THEN** the automated prompt remains queued

#### Scenario: Submitted terminal line allows delivery after idle

- **GIVEN** terminal input previously blocked automated delivery
- **WHEN** the user submits or cancels that terminal input
- **AND** the user activity hold has expired
- **AND** all other delivery blockers are absent
- **THEN** the app delivers the queued automated prompt

### Requirement: Automation waits during recent user activity

The app SHALL hold automated prompt delivery for a short period after user
activity in the target session and SHALL extend that hold when additional user
activity occurs.

#### Scenario: Recent typing delays automation

- **GIVEN** an automated prompt is queued for a session
- **WHEN** the user types in that session
- **THEN** the app delays automated delivery until the activity hold expires

#### Scenario: Continued activity extends the hold

- **GIVEN** automated delivery is waiting for the user activity hold to expire
- **WHEN** the user interacts with the same session again
- **THEN** the app extends the hold from the latest activity

### Requirement: Coordinated initial assignments remain queued until delivered

The app SHALL keep a live coordinated sub-task's initial assignment queued until
it is delivered or replaced by explicit user input.

The backend coordinator SHALL own coordinated initial assignment delivery so
background sub-tasks can start even when their renderer task panels are not
mounted.

#### Scenario: Initial assignment survives readiness timeout

- **GIVEN** a coordinated sub-task has an undelivered initial assignment
- **AND** the sub-task agent has not exited
- **AND** the user has not replaced the assignment with their own draft
- **WHEN** the initial-prompt readiness timeout elapses
- **THEN** the app keeps waiting for a safe delivery point
- **AND** the app does not clear or abandon the initial assignment

#### Scenario: Background sub-task receives its initial assignment

- **GIVEN** a coordinator creates multiple sub-tasks
- **AND** one or more sub-task panels are not mounted in the renderer
- **WHEN** each sub-task agent reaches a prompt-ready state
- **THEN** the backend delivers each sub-task's initial assignment

### Requirement: Automation waits during interactive agent questions

The app SHALL NOT deliver automated prompts while the target session is showing
an interactive question, startup dialog, or trust dialog.

#### Scenario: Agent question blocks automation

- **GIVEN** an automated prompt is queued for a session
- **AND** the agent is showing an interactive question
- **WHEN** the auto-delivery check runs
- **THEN** the automated prompt remains queued

#### Scenario: Resolved question allows delivery

- **GIVEN** an automated prompt is queued for a session
- **AND** an interactive question previously blocked delivery
- **WHEN** the question is resolved
- **AND** all other delivery blockers are absent
- **THEN** the app delivers the queued automated prompt

### Requirement: Queued delivery status replaces take/release instructions

The app SHALL describe queued automated delivery using the current waiting
reason and SHALL NOT require the user to click take-control or release-control
actions in the normal prompt delivery flow.

#### Scenario: Queued prompt waits for user draft

- **GIVEN** an automated prompt is queued
- **AND** a user draft is blocking delivery
- **WHEN** the task panel shows delivery status
- **THEN** the UI indicates that delivery is waiting for the user's draft
- **AND** the UI does not instruct the user to release control

#### Scenario: Queued prompt waits for agent readiness

- **GIVEN** an automated prompt is queued
- **AND** no user input blocker is present
- **AND** the agent is not ready for prompt delivery
- **WHEN** the task panel shows delivery status
- **THEN** the UI indicates that delivery is waiting for the agent to be ready
