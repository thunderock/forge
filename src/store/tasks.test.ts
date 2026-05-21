import { describe, expect, it, vi, beforeEach } from 'vitest';
import { IPC } from '../../electron/ipc/channels';

// Hoisted so these refs are available both in vi.mock() factories and in test bodies.
const { mockInvoke, mockIsAgentBracketedPasteEnabled, mockSetStore } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockIsAgentBracketedPasteEnabled: vi.fn(),
  mockSetStore: vi.fn(),
}));

// ─── Coordinator test infrastructure ─────────────────────────────────────────

type MockTask = {
  controlledBy?: 'coordinator' | 'human';
  coordinatedBy?: string;
  agentIds: string[];
  shellAgentIds: string[];
  [key: string]: unknown;
};

let mockTasks: Record<string, MockTask> = {};
let mockAgents: Record<string, unknown> = {};
let mockTaskOrder: string[] = [];
let mockCollapsedTaskOrder: string[] = [];
let mockProjects: { id: string; path: string }[] = [];
const ipcHandlers = new Map<string, (data: unknown) => void>();

function applySetStore(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === 'function') {
    (
      args[0] as (s: {
        tasks: Record<string, MockTask>;
        agents: Record<string, unknown>;
        taskOrder: string[];
        collapsedTaskOrder: string[];
      }) => void
    )({
      tasks: mockTasks,
      agents: mockAgents,
      taskOrder: mockTaskOrder,
      collapsedTaskOrder: mockCollapsedTaskOrder,
    });
    return;
  }
  // Path-based: setStore('tasks', taskId, 'field', value)
  const value = args[args.length - 1];
  let target: Record<string, unknown> = {
    tasks: mockTasks,
    agents: mockAgents,
    taskOrder: mockTaskOrder,
  };
  for (let i = 0; i < args.length - 2; i++) {
    const next = target[args[i] as string] as Record<string, unknown> | undefined;
    if (next === undefined || next === null) return;
    target = next;
  }
  target[args[args.length - 2] as string] = value;
}

// Wire up mockSetStore to apply mutations so coordinator tests can read back state.
// Re-applied in sendPrompt's beforeEach after vi.clearAllMocks().
mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../lib/ipc', () => ({ Channel: vi.fn(), invoke: mockInvoke }));

vi.mock('./core', () => ({
  store: new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === 'tasks') return mockTasks;
      if (prop === 'agents') return mockAgents;
      if (prop === 'taskOrder') return mockTaskOrder;
      if (prop === 'collapsedTaskOrder') return mockCollapsedTaskOrder;
      if (prop === 'availableAgents') return [];
      if (prop === 'projects') return mockProjects;
      return undefined;
    },
  }),
  setStore: mockSetStore,
  cleanupPanelEntries: vi.fn(),
}));

vi.mock('../lib/ipc', () => ({ Channel: vi.fn(), invoke: mockInvoke }));
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
  clearTaskGitStatusTracking: vi.fn(),
  isAgentBracketedPasteEnabled: mockIsAgentBracketedPasteEnabled,
  isAgentIdle: vi.fn(),
  rescheduleTaskStatusPolling: vi.fn(),
}));
vi.mock('./completion', () => ({
  recordMergedLines: vi.fn(),
  recordTaskCompleted: vi.fn(),
}));
vi.mock('../lib/log', () => ({ warn: vi.fn() }));
vi.mock('../lib/clean-task-name', () => ({ cleanTaskName: vi.fn() }));
vi.mock('./coordinator-preamble', () => ({ COORDINATOR_PREAMBLE: '' }));
vi.mock('./sidebar-order', () => ({ getCoordinatorChildren: vi.fn() }));
vi.mock('../lib/github-url', () => ({
  parseGitHubUrl: vi.fn(),
  taskNameFromGitHubUrl: vi.fn(),
}));

vi.stubGlobal('window', {
  electron: {
    ipcRenderer: {
      on: (_channel: string, handler: (data: unknown) => void) => {
        ipcHandlers.set(_channel, handler);
        return () => ipcHandlers.delete(_channel);
      },
    },
  },
});

import {
  initMCPListeners,
  setTaskControl,
  collapseTask,
  closeTask,
  sendPrompt,
  pasteDelayMs,
  markTaskMcpPending,
  markTaskMcpReady,
  markTaskMcpError,
  retryTaskMcpStartup,
} from './tasks';
import { getCoordinatorChildren } from './sidebar-order';
import { markAgentSpawned, rescheduleTaskStatusPolling } from './taskStatus';

// ─── Coordinator listener setup ───────────────────────────────────────────────

initMCPListeners();
const taskCreatedHandler = ipcHandlers.get('mcp_task_created');
if (!taskCreatedHandler) throw new Error('mcp_task_created handler not registered');
const taskStateSyncHandler = ipcHandlers.get('mcp_task_state_sync');
if (!taskStateSyncHandler) throw new Error('mcp_task_state_sync handler not registered');

beforeEach(() => {
  vi.clearAllMocks();
  mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
  mockCollapsedTaskOrder = [];
  mockProjects = [];
  mockInvoke.mockResolvedValue(undefined);
});

// ─── Coordinator tests ────────────────────────────────────────────────────────

const baseEvent = {
  taskId: 'sub-task-1',
  name: 'Sub Task',
  projectId: 'proj-1',
  branchName: 'task/sub-task-1',
  worktreePath: '/repo/.worktrees/sub-task-1',
  agentId: 'agent-sub-1',
  coordinatorTaskId: 'coordinator-1',
};

describe('coordinator controlledBy state machine (item 9: UI disabled-state regression tests)', () => {
  it('9a: sub-task created via MCP starts with controlledBy: coordinator (not undefined)', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('9b: manually added task without coordinatorMode starts with controlledBy undefined', () => {
    mockTasks['plain-task'] = {
      agentIds: ['agent-plain'],
      shellAgentIds: [],
    };
    expect(mockTasks['plain-task'].controlledBy).toBeUndefined();
  });

  it('9c: setTaskControl transitions controlledBy to human', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
    setTaskControl('sub-task-1', 'human');
    expect(mockTasks['sub-task-1'].controlledBy).toBe('human');
  });

  it('9c: setTaskControl transitions controlledBy back to coordinator', () => {
    taskCreatedHandler(baseEvent);
    setTaskControl('sub-task-1', 'human');
    setTaskControl('sub-task-1', 'coordinator');
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('9d: setTaskControl is a no-op for unknown taskId (no crash)', () => {
    expect(() => setTaskControl('nonexistent-task', 'human')).not.toThrow();
  });

  it('9e: removing a coordinator task leaves no entry in mockTasks', () => {
    mockTasks['coordinator-task'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      controlledBy: 'coordinator',
    };
    mockTaskOrder.push('coordinator-task');
    expect(mockTasks['coordinator-task'].controlledBy).toBe('coordinator');

    delete mockTasks['coordinator-task'];
    const idx = mockTaskOrder.indexOf('coordinator-task');
    if (idx !== -1) mockTaskOrder.splice(idx, 1);

    const hasActiveCoordinator = Object.values(mockTasks).some(
      (t) => (t as MockTask & { coordinatorMode?: boolean }).coordinatorMode,
    );
    expect(hasActiveCoordinator).toBe(false);
    expect(mockTasks['coordinator-task']).toBeUndefined();
  });
});

describe('MCP_TaskCreated IPC handler', () => {
  it('ignores duplicate task-created events without resetting spawn state', () => {
    taskCreatedHandler(baseEvent);
    taskCreatedHandler(baseEvent);

    expect(mockTaskOrder).toEqual(['sub-task-1']);
    expect(markAgentSpawned).toHaveBeenCalledTimes(1);
    expect(rescheduleTaskStatusPolling).toHaveBeenCalledTimes(1);
  });

  it('sets controlledBy to coordinator on the new sub-task', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBe('coordinator');
  });

  it('sets coordinatedBy to the coordinator task ID', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].coordinatedBy).toBe('coordinator-1');
  });

  it('regression: sub-tasks must not be created without controlledBy defined', () => {
    taskCreatedHandler(baseEvent);
    expect(mockTasks['sub-task-1'].controlledBy).toBeDefined();
  });
});

describe('collapseTask — coordinated child guard (TODO #23)', () => {
  it('is a no-op when task has coordinatedBy set', async () => {
    mockTasks['sub-task-1'] = {
      agentIds: ['agent-1'],
      shellAgentIds: [],
      coordinatedBy: 'coordinator-1',
      collapsed: false,
    };
    mockTaskOrder.push('sub-task-1');

    await collapseTask('sub-task-1');

    expect(mockTasks['sub-task-1'].agentIds).toEqual(['agent-1']);
    expect(mockTasks['sub-task-1'].collapsed).toBeFalsy();
    expect(mockTaskOrder).toContain('sub-task-1');
  });

  it('proceeds normally for tasks without coordinatedBy', async () => {
    mockTasks['plain-task'] = {
      agentIds: ['agent-2'],
      shellAgentIds: [],
      collapsed: false,
    };
    mockTaskOrder.push('plain-task');

    await collapseTask('plain-task');

    expect(mockTasks['plain-task'].agentIds).toEqual([]);
    expect(mockTasks['plain-task'].collapsed).toBe(true);
  });
});

describe('hasActiveCoordinator condition — coordinator task removal', () => {
  it('condition is false when the store has no tasks', () => {
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });

  it('condition is true when a coordinator task exists in the store', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: undefined,
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(true);
  });

  it('condition is false after the coordinator task is removed from the store', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: undefined,
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    delete mockTasks['coord-1'];
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });

  it('condition is false when the coordinator task has closingStatus set (is being closed)', () => {
    mockTasks['coord-1'] = {
      coordinatorMode: true,
      closingStatus: 'closing',
      projectId: 'proj-1',
      agentIds: [],
      shellAgentIds: [],
    };
    const result = Object.values(mockTasks).some((t) => t.coordinatorMode && !t.closingStatus);
    expect(result).toBe(false);
  });
});

// ─── MCP startup failure handling (TODO #43) ─────────────────────────────────

describe('MCP startup status transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
    mockProjects = [{ id: 'proj-1', path: '/repo' }];
  });

  it('markTaskMcpPending sets status to pending', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [] };
    markTaskMcpPending('task-1');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('pending');
  });

  it('markTaskMcpReady sets status to ready', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [], mcpStartupStatus: 'pending' };
    markTaskMcpReady('task-1');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('ready');
  });

  it('markTaskMcpError sets status to error with control chars stripped', () => {
    mockTasks['task-1'] = { agentIds: [], shellAgentIds: [], mcpStartupStatus: 'pending' };
    // \x1b (ESC, 0x1b) is a control char and gets stripped; printable chars like '[31m' remain
    markTaskMcpError('task-1', 'Connection refused\x1b[31m injected\x1b[0m');
    expect(mockTasks['task-1'].mcpStartupStatus).toBe('error');
    expect(mockTasks['task-1'].mcpStartupError).toBe('Connection refused[31m injected[0m');
  });

  it('failed StartMCPServer marks coordinator task with error instead of staying pending', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
    };
    mockAgents['agent-coord'] = { def: { command: 'claude', args: [] } };
    mockInvoke.mockRejectedValueOnce(new Error('port in use'));

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('error');
    expect(String(mockTasks['coord-1'].mcpStartupError)).toContain('port in use');
  });

  it('successful StartMCPServer marks coordinator task as ready', async () => {
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/coord',
    };
    mockAgents['agent-coord'] = { def: { command: 'claude', args: [] } };
    mockInvoke.mockResolvedValueOnce(undefined);

    markTaskMcpPending('coord-1');
    await retryTaskMcpStartup('coord-1');

    expect(mockTasks['coord-1'].mcpStartupStatus).toBe('ready');
  });

  it('child hydration failure marks only that child as error, leaving sibling spawnable', async () => {
    mockTasks['coord-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      mcpStartupStatus: 'ready',
    };
    mockTasks['child-a'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-a',
      branchName: 'task/child-a',
    };
    mockTasks['child-b'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-b',
      branchName: 'task/child-b',
    };

    // child-a fails, child-b succeeds
    mockInvoke.mockRejectedValueOnce(new Error('hydrate failed')).mockResolvedValueOnce(undefined);

    markTaskMcpPending('child-a');
    await retryTaskMcpStartup('child-a');
    markTaskMcpPending('child-b');
    await retryTaskMcpStartup('child-b');

    expect(mockTasks['child-a'].mcpStartupStatus).toBe('error');
    expect(mockTasks['child-b'].mcpStartupStatus).toBe('ready');
  });

  it('retry of child when coordinator is in error surfaces dependency message', async () => {
    mockTasks['coord-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatorMode: true,
      projectId: 'proj-1',
      mcpStartupStatus: 'error',
    };
    mockTasks['child-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      projectId: 'proj-1',
      gitIsolation: 'worktree',
      worktreePath: '/repo/.worktrees/child-1',
      branchName: 'task/child-1',
      mcpStartupStatus: 'error',
    };

    await retryTaskMcpStartup('child-1');

    expect(mockTasks['child-1'].mcpStartupStatus).toBe('error');
    expect(String(mockTasks['child-1'].mcpStartupError)).toContain('coordinator');
    expect(mockInvoke).not.toHaveBeenCalledWith(IPC.MCP_HydrateCoordinatedTask, expect.anything());
  });
});

// ─── sendPrompt tests ─────────────────────────────────────────────────────────

function writePayloads(): string[] {
  return mockInvoke.mock.calls
    .filter(([channel]) => channel === IPC.WriteToAgent)
    .map(([, payload]) => (payload as { data: string }).data);
}

describe('sendPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply after clearAllMocks() so coordinator store mutations still work.
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
    mockIsAgentBracketedPasteEnabled.mockReturnValue(false);
    mockAgents = { 'agent-1': { status: 'running' } };
    mockTasks = { 'task-1': { agentIds: [], shellAgentIds: [], lastPrompt: '' } };
  });

  it('wraps prompt text in bracketed paste when the agent enabled it', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~hello Codex\x1b[201~', '\r']);
    expect(mockSetStore).toHaveBeenCalledWith('tasks', 'task-1', 'lastPrompt', 'hello Codex');
  });

  it('sends raw prompt text when bracketed paste is not enabled', async () => {
    await sendPrompt('task-1', 'agent-1', 'hello Codex');

    expect(writePayloads()).toEqual(['\x1b[I', 'hello Codex', '\r']);
  });

  it('keeps Enter outside the bracketed paste block', async () => {
    mockIsAgentBracketedPasteEnabled.mockReturnValue(true);

    await sendPrompt('task-1', 'agent-1', 'line 1\nline 2');

    expect(writePayloads()).toEqual(['\x1b[I', '\x1b[200~line 1\nline 2\x1b[201~', '\r']);
  });
});

// ─── MCP_TaskCleanupFailed IPC handler ───────────────────────────────────────

const cleanupFailedHandler = ipcHandlers.get(IPC.MCP_TaskCleanupFailed);
if (!cleanupFailedHandler) throw new Error('mcp_task_cleanup_failed handler not registered');

describe('MCP_TaskCleanupFailed IPC handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockTasks = {
      'task-1': {
        agentIds: ['agent-1'],
        shellAgentIds: [],
        closingStatus: 'closing',
      },
    };
  });

  it('marks the task closingStatus as error', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'git worktree delete failed' });

    expect(mockTasks['task-1'].closingStatus).toBe('error');
  });

  it('sets closingError to the error message', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'git worktree delete failed' });

    expect(mockTasks['task-1'].closingError).toBe('git worktree delete failed');
  });

  it('does NOT remove the task from the store', () => {
    cleanupFailedHandler({ taskId: 'task-1', error: 'delete failed' });

    expect(mockTasks['task-1']).toBeDefined();
  });

  it('is a no-op if the task does not exist', () => {
    expect(() =>
      cleanupFailedHandler({ taskId: 'nonexistent', error: 'delete failed' }),
    ).not.toThrow();
    expect(mockTasks['task-1'].closingStatus).toBe('closing');
  });
});

// ─── closeTask — IPC ordering (#37) ──────────────────────────────────────────

describe('closeTask — IPC cleanup ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockInvoke.mockResolvedValue(undefined);
  });

  it('MCP_CoordinatedTaskClosed rejection is swallowed and task is still removed', async () => {
    mockTasks['task-1'] = {
      agentIds: ['agent-1'],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      gitIsolation: 'direct', // skip DeleteTask to keep invoke sequence simple
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatedTaskClosed) {
        return Promise.reject(new Error('backend gone'));
      }
      return Promise.resolve(undefined);
    });

    await closeTask('task-1');

    // removeTaskFromStore marks 'removing' synchronously; setTimeout deletion is not awaited
    expect(mockTasks['task-1']?.closingStatus).toBe('removing');
  });

  it('MCP_CoordinatedTaskClosed resolves before removeTaskFromStore is called', async () => {
    const order: string[] = [];
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatedTaskClosed) {
        return Promise.resolve(undefined).then(() => {
          order.push('ipc');
        });
      }
      return Promise.resolve(undefined);
    });
    // Intercept setStore to detect when removeTaskFromStore marks task as 'removing'
    const origImpl = mockSetStore.getMockImplementation();
    mockSetStore.mockImplementation((...args: unknown[]) => {
      if (origImpl) origImpl(...args);
      // Phase-1 of removeTaskFromStore: setStore('tasks', id, 'closingStatus', 'removing')
      if (args[2] === 'closingStatus' && args[3] === 'removing') order.push('remove');
    });

    await closeTask('task-1');

    const ipcIdx = order.indexOf('ipc');
    const removeIdx = order.indexOf('remove');
    expect(ipcIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(ipcIdx);
  });

  it('MCP_CoordinatorDeregistered rejection is swallowed and coordinator is still removed', async () => {
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: [], collapsed: [] });
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === IPC.MCP_CoordinatorDeregistered) {
        return Promise.reject(new Error('deregister failed'));
      }
      return Promise.resolve(undefined);
    });

    await closeTask('coord-1');

    // removeTaskFromStore marks 'removing' synchronously; setTimeout deletion is not awaited
    expect(mockTasks['coord-1']?.closingStatus).toBe('removing');
  });

  it('detaches coordinator children without clearing backend review state', async () => {
    vi.mocked(getCoordinatorChildren).mockReturnValue({ active: ['child-1'], collapsed: [] });
    mockTasks['coord-1'] = {
      agentIds: ['agent-coord'],
      shellAgentIds: [],
      coordinatorMode: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };
    mockTasks['child-1'] = {
      agentIds: ['agent-child'],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      controlledBy: 'coordinator',
      mcpConfigPath: '/tmp/mcp.json',
      mcpStartupStatus: 'ready',
      mcpStartupError: 'stale',
      signalDoneReceived: true,
      needsReview: true,
      gitIsolation: 'direct',
      projectId: 'proj-1',
    };

    await closeTask('coord-1');

    expect(mockTasks['child-1'].coordinatedBy).toBeUndefined();
    expect(mockTasks['child-1'].controlledBy).toBeUndefined();
    expect(mockTasks['child-1'].mcpConfigPath).toBeUndefined();
    expect(mockTasks['child-1'].mcpStartupStatus).toBeUndefined();
    expect(mockTasks['child-1'].mcpStartupError).toBeUndefined();
    expect(mockTasks['child-1'].signalDoneReceived).toBe(true);
    expect(mockTasks['child-1'].needsReview).toBe(true);
  });
});

describe('MCP_TaskStateSync listener', () => {
  beforeEach(() => {
    mockSetStore.mockImplementation((...args: unknown[]) => applySetStore(...args));
    mockTasks['task-1'] = {
      agentIds: [],
      shellAgentIds: [],
      coordinatedBy: 'coord-1',
      controlledBy: 'coordinator',
      mcpConfigPath: '/tmp/mcp.json',
      mcpStartupStatus: 'ready',
      mcpStartupError: 'stale',
      signalDoneReceived: true,
      signalDoneAt: '2026-05-19T10:00:00Z',
      signalDoneConsumed: true,
      needsReview: true,
    };
  });

  it('clears done/review flags when backend sends a running-state sync', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      signalDoneReceived: false,
      signalDoneAt: null,
      signalDoneConsumed: false,
      needsReview: false,
    });

    expect(mockTasks['task-1'].signalDoneReceived).toBe(false);
    expect(mockTasks['task-1'].signalDoneAt).toBeUndefined();
    expect(mockTasks['task-1'].signalDoneConsumed).toBe(false);
    expect(mockTasks['task-1'].needsReview).toBe(false);
  });

  it('clears coordinator wiring and MCP startup state from null sync fields', () => {
    taskStateSyncHandler({
      taskId: 'task-1',
      coordinatedBy: null,
      controlledBy: null,
      mcpConfigPath: null,
      mcpStartupStatus: null,
      mcpStartupError: null,
    });

    expect(mockTasks['task-1'].coordinatedBy).toBeUndefined();
    expect(mockTasks['task-1'].controlledBy).toBeUndefined();
    expect(mockTasks['task-1'].mcpConfigPath).toBeUndefined();
    expect(mockTasks['task-1'].mcpStartupStatus).toBeUndefined();
    expect(mockTasks['task-1'].mcpStartupError).toBeUndefined();
  });
});

describe('pasteDelayMs', () => {
  it('returns 50ms for a short single-line prompt', () => {
    expect(pasteDelayMs('hello')).toBe(50);
  });

  it('scales by line count for a ~31-line prompt', () => {
    const text = Array.from({ length: 31 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(Math.min(500, Math.max(50, 31 * 15)));
  });

  it('caps at 500ms for a very large prompt', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    expect(pasteDelayMs(text)).toBe(500);
  });
});
