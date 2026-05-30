# Progress Metrics Specification

## ADDED Requirements

### Requirement: "Merged today" counts only tasks merged with cleanup today

The sidebar Progress panel SHALL display a "Merged today" count that increments
only when a task is successfully merged through the UI merge path with cleanup
enabled. The count SHALL reset to zero at the start of each local calendar day.

#### Scenario: Merging a task with cleanup increments the count

- **WHEN** the user merges the active task through the UI and cleanup is enabled
- **AND** the merge succeeds
- **THEN** the "Merged today" count increases by one

#### Scenario: Closing an empty or unmerged task does not increment the count

- **WHEN** the user closes a task that was not merged (including an empty task,
  an unmerged task, or a current-branch-mode task)
- **THEN** the "Merged today" count is unchanged

#### Scenario: Merging without cleanup does not increment the count

- **WHEN** the user merges a task but does not enable cleanup
- **THEN** the task remains and the "Merged today" count is unchanged

#### Scenario: Count resets on a new day

- **WHEN** the local calendar day has changed since the count was last recorded
- **THEN** the displayed "Merged today" count is zero until the next merge

### Requirement: "Merged (total)" shows lifetime merged line totals

The Progress panel SHALL display a "Merged (total)" card showing the cumulative
lines added and removed across all UI merges, persisted across sessions. The
label SHALL make the lifetime (non-daily) scope distinguishable from the
"Merged today" count.

#### Scenario: Merged line totals accumulate across sessions

- **WHEN** a task is merged through the UI with a non-zero diff
- **THEN** the added and removed line totals increase by that diff
- **AND** the totals persist across app restarts
