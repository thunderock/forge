import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { Coordinator } from '../mcp/coordinator.js';
import type { ApiTaskDetail } from '../mcp/types.js';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

const { requireOwnedTask, readCoordinatorBody } = await import('./server.js');

type FakeRequest = EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function makeFakeRequest(): FakeRequest {
  const req = new EventEmitter() as FakeRequest;
  req.destroy = vi.fn();
  return req;
}

const task: ApiTaskDetail = {
  id: 'task-a',
  name: 'Task A',
  branchName: 'task/a',
  worktreePath: '/tmp/task-a',
  projectId: 'project-1',
  agentId: 'agent-a',
  status: 'idle',
  coordinatorTaskId: 'coordinator-a',
  exitCode: null,
};

function makeCoordinator(detail: ApiTaskDetail | null): Coordinator {
  return {
    getTaskStatus: vi.fn(() => detail),
  } as unknown as Coordinator;
}

describe('requireOwnedTask', () => {
  it('returns a task owned by the caller without replying', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(task), task.id, 'coordinator-a', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBe(task);
    expect(replies).toEqual([]);
  });

  it('replies 404 for missing tasks', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(null), 'missing', 'coordinator-a', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBeNull();
    expect(replies).toEqual([{ status: 404, body: { error: 'task not found' } }]);
  });

  it('replies 403 when the caller does not own the task', () => {
    const replies: Array<{ status: number; body: unknown }> = [];

    expect(
      requireOwnedTask(makeCoordinator(task), task.id, 'coordinator-b', (status, body) => {
        replies.push({ status, body });
      }),
    ).toBeNull();
    expect(replies).toEqual([{ status: 403, body: { error: 'forbidden' } }]);
  });
});

describe('readCoordinatorBody', () => {
  it('sends the 413 reply before the connection is torn down', async () => {
    const req = makeFakeRequest();
    const replies: Array<{ status: number; body: unknown }> = [];
    const jsonReply = (status: number, body: unknown) => replies.push({ status, body });

    const pending = readCoordinatorBody(req as unknown as IncomingMessage, jsonReply).catch(
      () => undefined,
    );

    req.emit('data', Buffer.alloc(1_000_001, 'a'));
    await pending;

    expect(replies).toEqual([{ status: 413, body: { error: 'Request body too large' } }]);
    expect(req.destroy).not.toHaveBeenCalled();
  });
});
