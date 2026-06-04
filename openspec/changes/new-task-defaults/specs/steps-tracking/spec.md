## MODIFIED Requirements

### Requirement: Opt-in per task with remembered default

Steps tracking SHALL be opt-in on a per-task basis, with a persistent app-level
default that the new-task dialog uses to pre-fill the checkbox. The storage key
for this default is renamed from `showSteps` to `defaultStepsEnabled`; existing
`showSteps` values are migrated to `defaultStepsEnabled` on first load.

#### Scenario: New task dialog reflects the persistent default

- **WHEN** the user opens the new-task dialog
- **THEN** the "Steps tracking" checkbox is pre-checked if and only if the
  persisted `defaultStepsEnabled` app-level flag is true

#### Scenario: Settings toggle updates the default

- **WHEN** the user enables or disables "Steps tracking" in Settings → General → New Task Defaults
- **THEN** the persisted `defaultStepsEnabled` app-level flag is updated to match
- **AND** the next new-task dialog uses that value as the default

#### Scenario: Task creation does not update the default

- **WHEN** the user creates a task with the "Steps tracking" checkbox in a
  different state than `defaultStepsEnabled`
- **THEN** the persisted `defaultStepsEnabled` app-level flag is NOT changed
- **AND** the per-task `stepsEnabled` flag reflects the checkbox state at creation time

#### Scenario: Migration from legacy showSteps key

- **WHEN** a user with `showSteps: true` in saved state opens the app after
  this change
- **THEN** `defaultStepsEnabled` is set to true
- **AND** `showSteps` is no longer written by saveState

## ADDED Requirements

### Requirement: Persistent defaults for skip-permissions and propagate

Two additional app-level defaults SHALL be persisted and used to pre-fill the
New Task dialog checkboxes.

#### Scenario: Skip-permissions default pre-fills the dialog

- **WHEN** the user opens the new-task dialog and the selected agent supports
  skip-permissions
- **THEN** the "Skip permissions" checkbox is pre-checked iff
  `defaultSkipPermissions` is true

#### Scenario: Propagate default pre-fills the dialog

- **WHEN** the user opens the new-task dialog with coordinator mode enabled and
  skip-permissions ticked
- **THEN** the "Propagate skip-permissions to sub-tasks" checkbox is pre-checked
  iff `defaultPropagateSkipPermissions` is true

#### Scenario: Defaults are configurable in Settings

- **WHEN** the user opens Settings → General
- **THEN** a "New Task Defaults" section is visible with toggles for all three
  defaults
- **AND** the propagate toggle is shown only when `coordinatorModeEnabled` is
  true
