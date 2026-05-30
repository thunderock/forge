import { describe, expect, it, vi, beforeEach } from 'vitest';

type StagedNotification = {
  batchId: string;
  notificationIds: string[];
  text: string;
  autoFireAt: number;
  userEdited: boolean;
  hiddenCompletionCount?: number;
};

type MockTask = {
  stagedNotification?: StagedNotification;
  agentIds: string[];
  shellAgentIds: string[];
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
const ipcHandlers = new Map<string, (data: unknown) => void>();
const activeHandlerCounts = new Map<string, number>();

// Must be a function declaration (hoisted) so vi.mock factories can reference it.
function applySetStore(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === 'function') {
    // produce(fn) pattern: solid-js/store is mocked so produce returns fn directly,
    // and setStore receives fn as its only arg. Call it with a plain object that
    // mirrors the store shape so mutations land on mockTasks.
    (args[0] as (s: { tasks: Record<string, MockTask> }) => void)({ tasks: mockTasks });
    return;
  }
  // Path-based pattern: setStore('tasks', taskId, 'stagedNotification', value)
  const value = args[args.length - 1];
  let target: Record<string, unknown> = { tasks: mockTasks };
  for (let i = 0; i < args.length - 2; i++) {
    target = target[args[i] as string] as Record<string, unknown>;
  }
  target[args[args.length - 2] as string] = value;
}

vi.mock('solid-js/store', () => ({
  // produce(fn) → fn, so setStore(produce(fn)) becomes setStore(fn)
  produce: (fn: (s: unknown) => void) => fn,
}));

vi.mock('./core', () => ({
  store: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'tasks') return mockTasks;
      return undefined;
    },
  }),
  setStore: vi.fn((...args: unknown[]) => applySetStore(...args)),
  cleanupPanelEntries: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));
vi.mock('../../electron/ipc/channels', () => ({
  IPC: {
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_TaskStateSync: 'mcp_task_state_sync',
  },
}));
vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('./focus', () => ({ setTaskFocusedPanel: vi.fn() }));
vi.mock('./projects', () => ({
  getProject: vi.fn(),
  getProjectPath: vi.fn(),
  getProjectBranchPrefix: vi.fn(),
  isProjectMissing: vi.fn(),
}));
vi.mock('../lib/bookmarks', () => ({ setPendingShellCommand: vi.fn() }));
vi.mock('./taskStatus', () => ({
  markAgentSpawned: vi.fn(),
  markAgentBusy: vi.fn(),
  clearAgentActivity: vi.fn(),
  isAgentIdle: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));
vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskMerged: vi.fn(),
}));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));
vi.mock('../lib/clean-task-name', () => ({ cleanTaskName: vi.fn() }));
vi.mock('./coordinator-preamble', () => ({ COORDINATOR_PREAMBLE: '' }));
vi.mock('./sidebar-order', () => ({ getCoordinatorChildren: vi.fn() }));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
}));

// Stub window so initMCPListeners can register IPC handlers.
// Must run before initMCPListeners() is called below.
vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        activeHandlerCounts.set(_channel, (activeHandlerCounts.get(_channel) ?? 0) + 1);
        ipcHandlers.set(_channel, handler);
        let cleanedUp = false;
        return () => {
          if (cleanedUp) return;
          cleanedUp = true;
          activeHandlerCounts.set(
            _channel,
            Math.max(0, (activeHandlerCounts.get(_channel) ?? 0) - 1),
          );
          if (ipcHandlers.get(_channel) === handler) ipcHandlers.delete(_channel);
        };
      },
    },
  },
});

import {
  initMCPListeners,
  clearStagedNotification,
  setStagedNotificationUserEdited,
} from './tasks';

// Register IPC handlers once. The captured stageHandler closes over the store
// proxy, which always reads from the current mockTasks variable.
initMCPListeners();
const stageHandler = ipcHandlers.get('mcp_coordinator_notification_staged');
if (!stageHandler) throw new Error('mcp_coordinator_notification_staged handler not registered');

function setTask(id: string, overrides: Partial<MockTask> = {}): void {
  mockTasks[id] = { agentIds: [], shellAgentIds: [], ...overrides };
}

beforeEach(() => {
  mockTasks = {};
});

describe('staged notification store logic', () => {
  it('replaces existing MCP listeners instead of stacking duplicate handlers', () => {
    expect(activeHandlerCounts.get('mcp_coordinator_notification_staged')).toBe(1);
    expect(activeHandlerCounts.get('mcp_coordinator_notification_cleared')).toBe(1);

    initMCPListeners();

    expect(activeHandlerCounts.get('mcp_coordinator_notification_staged')).toBe(1);
    expect(activeHandlerCounts.get('mcp_coordinator_notification_cleared')).toBe(1);
  });

  it('replaces notification A when notification B arrives before A fires', () => {
    setTask('task-1');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1'],
      text: 'notification A',
      autoFireAt: 1000,
    });
    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-a');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-b',
      notificationIds: ['n2'],
      text: 'notification B',
      autoFireAt: 2000,
    });

    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-b');
    expect(mockTasks['task-1'].stagedNotification?.text).toBe('notification B');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(false);
  });

  it('stages new notification normally after userEdited — userEdited is per-notification not sticky', () => {
    setTask('task-1');

    // Stage notification A with two notification IDs
    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1', 'n2'],
      text: 'notification A',
      autoFireAt: 1000,
    });

    // User edits the staged notification
    setStagedNotificationUserEdited('task-1');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(true);

    // New batch arrives with fewer IDs — should replace, not be suppressed
    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-b',
      notificationIds: ['n3'],
      text: 'notification B',
      autoFireAt: 2000,
    });

    expect(mockTasks['task-1'].stagedNotification?.batchId).toBe('batch-b');
    expect(mockTasks['task-1'].stagedNotification?.text).toBe('notification B');
    expect(mockTasks['task-1'].stagedNotification?.userEdited).toBe(false);
  });

  it('clears the staged notification', () => {
    setTask('task-1');

    stageHandler({
      coordinatorTaskId: 'task-1',
      batchId: 'batch-a',
      notificationIds: ['n1'],
      text: 'notification A',
      autoFireAt: 1000,
    });
    expect(mockTasks['task-1'].stagedNotification).toBeDefined();

    clearStagedNotification('task-1');

    expect(mockTasks['task-1'].stagedNotification).toBeUndefined();
  });
});
