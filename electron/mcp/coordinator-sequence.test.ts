import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- fs / child_process mocks (must come before dynamic import) ---
const mockExecFile = vi.fn(
  (_cmd: unknown, _args: unknown, _opts: unknown, cb: (...a: unknown[]) => void) => {
    cb(null, '', '');
    return { on: vi.fn() };
  },
);

vi.mock('child_process', () => ({
  execFile: mockExecFile,
  promisify: vi.fn(
    (fn: unknown) =>
      (...args: unknown[]) =>
        new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          (fn as (...a: unknown[]) => void)(
            ...args,
            (err: unknown, stdout: string, stderr: string) => {
              if (err) reject(err);
              else resolve({ stdout, stderr });
            },
          );
        }),
  ),
}));

const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn(() => '# existing\n');
const mockExistsSync = vi.fn(() => false);
const mockUnlinkSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('fs', () => ({
  writeFileSync: mockWriteFileSync,
  readFileSync: mockReadFileSync,
  existsSync: mockExistsSync,
  unlinkSync: mockUnlinkSync,
  mkdirSync: mockMkdirSync,
}));

// --- other mocks ---
const mockNotifyRenderer = vi.fn();
const mockOnPtyEvent = vi.fn();
const mockSpawnAgent = vi.fn();
const mockSubscribeToAgent = vi.fn();
const mockGetAgentScrollback = vi.fn(() => null);
const mockGitMergeTask = vi.fn().mockResolvedValue({
  main_branch: 'main',
  lines_added: 10,
  lines_removed: 5,
});
const mockCreateBackendTask = vi.fn().mockResolvedValue({
  id: 'task-1',
  branch_name: 'task/test',
  worktree_path: '/tmp/test',
});

vi.mock('./prompt-detect.js', () => ({
  stripAnsi: (s: string) => s,
  chunkContainsAgentPrompt: (s: string) => s.slice(-300).includes('❯'),
}));

vi.mock('../ipc/pty.js', () => ({
  spawnAgent: mockSpawnAgent,
  writeToAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: mockSubscribeToAgent,
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: mockGetAgentScrollback,
  onPtyEvent: mockOnPtyEvent,
}));

vi.mock('../ipc/git.js', () => ({
  getChangedFiles: vi.fn().mockResolvedValue([]),
  getAllFileDiffs: vi.fn().mockResolvedValue(''),
  mergeTask: mockGitMergeTask,
}));

vi.mock('../ipc/tasks.js', () => ({
  createTask: mockCreateBackendTask,
  deleteTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ipc/channels.js', () => ({
  IPC: {
    MCP_TaskCreated: 'mcp_task_created',
    MCP_TaskClosed: 'mcp_task_closed',
    MCP_TaskStateSync: 'mcp_task_state_sync',
    MCP_CoordinatorNotificationStaged: 'mcp_coordinator_notification_staged',
    MCP_CoordinatorNotificationCleared: 'mcp_coordinator_notification_cleared',
    MCP_CoordinatorOrphanedNotification: 'mcp_coordinator_orphaned_notification',
    MCP_CoordinatorDeregistered: 'mcp_coordinator_deregistered',
    MCP_CoordinatorNotificationAck: 'mcp_coordinator_notification_ack',
  },
}));

// Import after mocks
const { Coordinator } = await import('./coordinator.js');

// --- helpers ---
function _getExitHandler(): (agentId: string, data: unknown) => void {
  const call = mockOnPtyEvent.mock.calls.find((c) => c[0] === 'exit');
  if (!call) throw new Error('exit handler not registered');
  return call[1] as (agentId: string, data: unknown) => void;
}

function getOutputCb(): (encoded: string) => void {
  const call = mockSubscribeToAgent.mock.calls[0];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[1] as (encoded: string) => void;
}

function _getAgentId(): string {
  const call = mockSubscribeToAgent.mock.calls[0];
  if (!call) throw new Error('subscribeToAgent not called');
  return call[0] as string;
}

function encode(s: string): string {
  return Buffer.from(s).toString('base64');
}

const mockWin = {
  isDestroyed: () => false,
  webContents: { send: mockNotifyRenderer },
} as unknown as import('electron').BrowserWindow;

// ─── end-to-end tool sequence smoke ──────────────────────────────────────────

describe('Coordinator — end-to-end tool sequence smoke', () => {
  let coordinator: InstanceType<typeof Coordinator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockCreateBackendTask.mockResolvedValue({
      id: 'task-1',
      branch_name: 'task/test',
      worktree_path: '/tmp/test',
    });
    coordinator = new Coordinator();
    coordinator.setWindow(mockWin);
    coordinator.setDefaultProject('proj-1', '/tmp/project');
  });

  it('Test 1: full lifecycle — create → wait_for_idle → signal_done → wait_for_signal_done → close', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    coordinator.markPromptDelivered('task-1');

    // Simulate idle output
    const outputCb = getOutputCb();
    outputCb(encode('startup echo ❯ '));
    outputCb(encode('real work output '.repeat(40)));
    outputCb(encode('Done ❯ '));

    // waitForIdle should resolve immediately since task is now idle
    const idleResult = await coordinator.waitForIdle('task-1');
    expect(idleResult).toEqual({ reason: 'idle' });

    coordinator.signalDone('task-1');

    const signalResult = await coordinator.waitForSignalDone('coord-1', 1000);
    expect(signalResult).toMatchObject({ remaining: 0 });

    await coordinator.closeTask('task-1');

    expect(coordinator.getTask('task-1')).toBeUndefined();
  });

  it('Test 2: list_tasks equivalent — getTask returns correct schema', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    const task = coordinator.getTask('task-1');
    expect(task).toBeDefined();
    if (!task) throw new Error('task should be defined');

    // Verify all expected fields are present and defined
    expect(task.id).toBeDefined();
    expect(task.name).toBeDefined();
    expect(task.branchName).toBeDefined();
    expect(task.worktreePath).toBeDefined();
    expect(task.projectId).toBeDefined();
    expect(task.agentId).toBeDefined();
    expect(task.status).toBeDefined();
    expect(task.coordinatorTaskId).toBeDefined();
    // exitCode can be null (task is running), not undefined
    expect('exitCode' in task).toBe(true);
  });

  it('Test 3: get_task_status — status progression idle → running → idle', async () => {
    vi.useFakeTimers();
    try {
      coordinator.registerCoordinator('coord-1', 'proj-1');
      await coordinator.createTask({
        name: 'feat-x',
        prompt: 'build it',
        coordinatorTaskId: 'coord-1',
      });

      coordinator.markPromptDelivered('task-1');
      const outputCb = getOutputCb();

      // Simulate idle output
      outputCb(encode('startup echo ❯ '));
      outputCb(encode('real work output '.repeat(40)));
      outputCb(encode('Done ❯ '));
      expect(coordinator.getTask('task-1')?.status).toBe('idle');

      // sendPrompt sets status to running
      const sendPromise = coordinator.sendPrompt('task-1', 'next step');
      await vi.advanceTimersByTimeAsync(50);
      await sendPromise;
      expect(coordinator.getTask('task-1')?.status).toBe('running');

      // Simulate idle again after prompt-echo suppression expires
      await vi.advanceTimersByTimeAsync(2_100);
      outputCb(encode('Ready ❯ '));
      expect(coordinator.getTask('task-1')?.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Test 4: merge_task smoke — calls gitMergeTask', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    coordinator.markPromptDelivered('task-1');
    const outputCb = getOutputCb();
    outputCb(encode('startup echo ❯ '));
    outputCb(encode('real work output '.repeat(40)));
    outputCb(encode('Done ❯ '));

    await coordinator.mergeTask('task-1');
    expect(mockGitMergeTask).toHaveBeenCalled();
  });

  it('Test 5: close_task cleans up all maps', async () => {
    coordinator.registerCoordinator('coord-1', 'proj-1');
    await coordinator.createTask({
      name: 'feat-x',
      prompt: 'build it',
      coordinatorTaskId: 'coord-1',
    });

    await coordinator.closeTask('task-1');

    // Task should be removed
    expect(coordinator.getTask('task-1')).toBeUndefined();

    // Renderer was notified about task closure
    expect(mockNotifyRenderer).toHaveBeenCalledWith('mcp_task_closed', { taskId: 'task-1' });
  });

  it('Test 6: send_prompt into unknown task rejects', async () => {
    await expect(coordinator.sendPrompt('nonexistent', 'hello')).rejects.toThrow('not found');
  });

  it('Test 7: wait_for_signal_done unknown coordinatorId rejects', async () => {
    await expect(coordinator.waitForSignalDone('unknown-coord', 100)).rejects.toThrow(
      'Coordinator not found',
    );
  });
});
