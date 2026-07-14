import { store, setStore } from './core';
import { getTaskFocusedPanel, setTaskFocusedPanel } from './focused-panel';
import { showNotification } from './notification';
import { pickAndAddProject } from './projects';
import { reorderTask } from './tasks';

const AI_TERMINAL_PREFIX = 'ai-terminal:';

function focusedAgentIdForTask(taskId: string, agentIds: string[]): string | null {
  const panel = store.focusedPanel[taskId];
  if (!panel?.startsWith(AI_TERMINAL_PREFIX)) return null;
  const agentId = panel.slice(AI_TERMINAL_PREFIX.length);
  return agentIds.includes(agentId) ? agentId : null;
}

function selectedAgentIdForTask(task: {
  agentIds: string[];
  selectedAgentId?: string;
}): string | null {
  return task.selectedAgentId && task.agentIds.includes(task.selectedAgentId)
    ? task.selectedAgentId
    : null;
}

export function setActiveTask(id: string): void {
  const task = store.tasks[id];
  const terminal = store.terminals[id];
  if (!task && !terminal) return;
  let activeAgentId: string | null = null;
  if (task) {
    activeAgentId =
      focusedAgentIdForTask(id, task.agentIds) ??
      selectedAgentIdForTask(task) ??
      (store.activeAgentId && task.agentIds.includes(store.activeAgentId)
        ? store.activeAgentId
        : (task.agentIds[0] ?? null));
    if (activeAgentId) setStore('tasks', id, 'selectedAgentId', activeAgentId);
  }
  setStore('activeTaskId', id);
  setStore('activeAgentId', activeAgentId);
}

export function setActiveAgent(agentId: string): void {
  setStore('activeAgentId', agentId);
  const taskId = store.activeTaskId;
  const task = taskId ? store.tasks[taskId] : undefined;
  if (task?.agentIds.includes(agentId)) {
    setStore('tasks', taskId as string, 'selectedAgentId', agentId);
  }
}

export function moveActiveTask(direction: 'left' | 'right'): void {
  const { taskOrder, activeTaskId } = store;
  if (!activeTaskId || taskOrder.length < 2) return;
  const idx = taskOrder.indexOf(activeTaskId);
  if (idx === -1) return;
  const target = direction === 'left' ? idx - 1 : idx + 1;
  if (target < 0 || target >= taskOrder.length) return;
  reorderTask(idx, target);
  // Re-focus the moved task and scroll it into view (DOM node move loses focus)
  setTaskFocusedPanel(activeTaskId, getTaskFocusedPanel(activeTaskId));
}

export function jumpToTask(index: number): void {
  // Index against taskOrder so Cmd+N matches the left-to-right tile order
  // shown in the main area (and the order Cmd+Left/Right cycles through).
  const id = store.taskOrder[index];
  if (!id) return;
  setActiveTask(id);
  if (store.sidebarFocused) {
    setStore('sidebarFocusedTaskId', id);
    setStore('sidebarFocusedProjectId', null);
  }
}

export function toggleNewTaskDialog(show?: boolean): void {
  const shouldShow = show ?? !store.showNewTaskDialog;
  if (shouldShow && store.projects.length === 0) {
    showNotification('Add a project first');
    pickAndAddProject();
    return;
  }
  if (!shouldShow) {
    setStore('newTaskDropUrl', null);
    setStore('newTaskPrefillPrompt', null);
  }
  setStore('showNewTaskDialog', shouldShow);
}

// Broadcast dialog toggle. Mirrors toggleNewTaskDialog but WITHOUT the
// "add a project first" guard and drop-url/prefill resets: a broadcast targets
// live running agents, not a new task, so it opens regardless of projects (it
// simply shows "0 running agents" when none exist).
export function toggleBroadcastDialog(show?: boolean): void {
  setStore('showBroadcastDialog', show ?? !store.showBroadcastDialog);
}
