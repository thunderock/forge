import type { TaskViewportVisibility } from '../store/types';

export function shouldPollTaskCommits(
  focusMode: boolean,
  isActive: boolean,
  viewportVisibility: TaskViewportVisibility | undefined,
): boolean {
  if (focusMode) return isActive;
  return viewportVisibility !== 'offscreen-left' && viewportVisibility !== 'offscreen-right';
}
