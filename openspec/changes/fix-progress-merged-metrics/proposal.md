# Fix Progress "Completed today" to count merges, not closures

## Why

The sidebar Progress panel's "Completed today" counter increments on **any**
task removal, because `recordTaskCompleted()` is called unconditionally inside
`removeTaskFromStore()` (`src/store/tasks.ts:504`) - the convergence point for
all UI task-removal paths. Closing an empty or unmerged task therefore inflates
a counter that users read as "work I finished today."

The panel also pairs two metrics on different time axes: "Completed today"
(daily, resets) sits beside "Merged to main/master" (lifetime cumulative line
totals). Side by side, both read as "today," which misrepresents the cumulative
number.

## What changes

- Move the daily-counter increment from `removeTaskFromStore()` onto the UI
  merge path: increment only inside `mergeTask()` when `cleanup === true` and
  the merge succeeded. Closing a task no longer increments it.
- Rename the counter API to match its real meaning: `recordTaskCompleted` ->
  `recordTaskMerged`, `getCompletedTasksTodayCount` -> `getMergedTasksTodayCount`.
  Daily-reset logic is unchanged.
- Relabel the UI: "Completed today" -> "Merged today".
- Relabel the second card "Merged to main/master" -> "Merged (total)" to
  disambiguate the time axis. **No data-model change** - it stays a lifetime
  cumulative line total; no persisted-state migration.

## Out of scope (known limitations, stated deliberately)

- **Coordinator subtask merges** flow through the backend coordinator merge
  (`electron/mcp/coordinator.ts`) -> `MCP_TaskClosed`, which removes the subtask
  via an inline path that never touches the renderer `mergeTask()`. They are
  uncounted today and remain uncounted. No regression; not addressed here.
- **Arena merges** call `IPC.MergeTask` directly, bypassing renderer
  `mergeTask()`. Also uncounted today and after.
- Re-axising "Merged (total)" to a daily tally (the issue's secondary proposal)
  is deferred - it requires a date key on the line totals plus a migration of
  existing users' cumulative values.
- The contribution-calendar enhancement is a separate future proposal.

## Impact

- New capability `progress-metrics`.
- Files: `src/store/completion.ts`, `src/store/tasks.ts`,
  `src/components/SidebarFooter.tsx`. Test mocks in `src/store/tasks.test.ts`
  and `src/store/notifications.test.ts` reference the renamed function.
