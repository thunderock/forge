import type { Task } from '../store/types';

interface ProjectTaskCountSource {
  taskOrder: readonly string[];
  collapsedTaskOrder: readonly string[];
  tasks: Record<string, Pick<Task, 'projectId'> | undefined>;
}

/** Count a project's tasks across both the open and collapsed lists. */
export function getProjectTaskCount(source: ProjectTaskCountSource, projectId: string): number {
  return [...source.taskOrder, ...source.collapsedTaskOrder].filter(
    (taskId) => source.tasks[taskId]?.projectId === projectId,
  ).length;
}
