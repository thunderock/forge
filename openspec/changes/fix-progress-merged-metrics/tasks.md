# Tasks - Fix Progress "Completed today" to count merges, not closures

- [x] Rename `recordTaskCompleted` -> `recordTaskMerged` and
      `getCompletedTasksTodayCount` -> `getMergedTasksTodayCount` in
      `src/store/completion.ts`; keep the daily-reset logic unchanged.
- [x] Remove the unconditional `recordTaskCompleted()` call from
      `removeTaskFromStore()` in `src/store/tasks.ts`.
- [x] Call `recordTaskMerged()` inside `mergeTask()` only when `cleanup === true`
      and after the merge has succeeded (i.e. in the existing `cleanup` block,
      paired with the successful merge result).
- [x] Update the renamed import in `src/store/tasks.ts` and update the function
      mocks in `src/store/tasks.test.ts` and `src/store/notifications.test.ts`.
- [x] Relabel the Progress panel in `src/components/SidebarFooter.tsx`:
      "Completed today" -> "Merged today", "Merged to main/master" ->
      "Merged (total)"; update the memo name to `getMergedTasksTodayCount`.
- [x] Add/adjust a unit test asserting that closing an empty/unmerged task does
      NOT increment the counter, and merging with cleanup does.
- [x] Validate with `npm run typecheck`, `npm test`, and
      `openspec validate --all --strict`.
