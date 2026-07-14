import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

// ── Store mock ──────────────────────────────────────────────────────────────
let mockTasks: Record<string, Record<string, unknown>> = {};
let mockAgents: Record<string, Record<string, unknown>> = {};
let mockTaskOrder: string[] = [];

const core = vi.hoisted(() => ({
  harness: undefined as
    | MockStoreHarness<{
        tasks: Record<string, Record<string, unknown>>;
        agents: Record<string, Record<string, unknown>>;
        taskOrder: string[];
      }>
    | undefined,
}));

// Controllable taskStatus signals + captured readiness subscriber. Hoisted so
// the vi.mock factory can close over them safely.
const ts = vi.hoisted(() => ({
  tail: '',
  idle: true,
  question: false,
  captured: undefined as ((agentId: string) => void) | undefined,
}));

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get tasks() {
      return mockTasks;
    },
    set tasks(next) {
      mockTasks = next;
    },
    get agents() {
      return mockAgents;
    },
    set agents(next) {
      mockAgents = next;
    },
    get taskOrder() {
      return mockTaskOrder;
    },
    set taskOrder(next) {
      mockTaskOrder = next;
    },
  });
  return core.harness.moduleMock();
});

// taskStatus is mocked so readiness/idle/question and the readiness notifier are
// fully controllable — the queue logic is provable with no real pty.
vi.mock('./taskStatus', () => ({
  getAgentOutputTail: vi.fn(() => ts.tail),
  isAgentIdle: vi.fn(() => ts.idle),
  isAgentAskingQuestion: vi.fn(() => ts.question),
  subscribeAgentReadiness: vi.fn((fn: (agentId: string) => void) => {
    ts.captured = fn;
    return () => {
      ts.captured = undefined;
    };
  }),
}));

import { subscribeAgentReadiness } from './taskStatus';
import {
  enumerateBroadcastTargets,
  getBroadcastTargetCount,
  enqueue,
  tryFlush,
  __broadcastTestHooks,
} from './broadcast';

function setTask(id: string, overrides: Record<string, unknown> = {}): void {
  mockTasks[id] = { id, agentIds: [], shellAgentIds: [], ...overrides };
  mockTaskOrder.push(id);
}

function setAgent(id: string, overrides: Record<string, unknown> = {}): void {
  mockAgents[id] = { id, status: 'running', def: { command: 'claude' }, ...overrides };
}

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
});

// ── enumerateBroadcastTargets ───────────────────────────────────────────────
describe('enumerateBroadcastTargets', () => {
  function buildMixedStore(): void {
    // Two plain running AI agents across projects — the ONLY expected targets.
    setTask('task-claude', { agentIds: ['a-claude'] });
    setAgent('a-claude', { def: { command: 'claude' } });
    setTask('task-codex', { agentIds: ['a-codex'] });
    setAgent('a-codex', { def: { command: 'codex' } });

    // Excluded: the top-level coordinator agent itself.
    setTask('task-coord', { agentIds: ['a-coord'], coordinatorMode: true });
    setAgent('a-coord');

    // Excluded: coordinator-controlled child (controlledBy).
    setTask('task-child', { agentIds: ['a-child'], controlledBy: 'coordinator' });
    setAgent('a-child');

    // Excluded: coordinator-controlled child (coordinatedBy).
    setTask('task-child2', { agentIds: ['a-child2'], coordinatedBy: 'coord-1' });
    setAgent('a-child2');

    // Excluded structurally: shells live in shellAgentIds, never agentIds.
    setTask('task-shell', { agentIds: [], shellAgentIds: ['s-1'] });
    setAgent('s-1');

    // Excluded: exited agent.
    setTask('task-exited', { agentIds: ['a-exited'] });
    setAgent('a-exited', { status: 'exited' });

    // Excluded: landed task (sendPrompt throws on landed).
    setTask('task-landed', { agentIds: ['a-landed'], landingState: 'landed_pending_review' });
    setAgent('a-landed');
  }

  it('returns exactly the running AI agents app-wide, excluding all others', () => {
    buildMixedStore();

    const targets = enumerateBroadcastTargets();
    expect(targets.map((t) => t.agentId).sort()).toEqual(['a-claude', 'a-codex']);
    expect(getBroadcastTargetCount()).toBe(2);
  });

  it('carries taskId and the live AgentDef for each target', () => {
    setTask('task-claude', { agentIds: ['a-claude'] });
    const def = { command: 'claude' };
    setAgent('a-claude', { def });

    const targets = enumerateBroadcastTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].taskId).toBe('task-claude');
    expect(targets[0].agentId).toBe('a-claude');
    expect(targets[0].def).toBe(def);
  });

  it('recomputes live — flipping an agent to exited drops the count on the next call', () => {
    buildMixedStore();
    expect(getBroadcastTargetCount()).toBe(2);

    mockAgents['a-codex'].status = 'exited';
    expect(getBroadcastTargetCount()).toBe(1);
    expect(enumerateBroadcastTargets().map((t) => t.agentId)).toEqual(['a-claude']);
  });

  it('enumerates multiple running AI agents within one task', () => {
    setTask('task-fanout', { agentIds: ['a-1', 'a-2'] });
    setAgent('a-1');
    setAgent('a-2');

    expect(
      enumerateBroadcastTargets()
        .map((t) => t.agentId)
        .sort(),
    ).toEqual(['a-1', 'a-2']);
  });

  it('skips a missing task id left dangling in taskOrder', () => {
    setTask('task-claude', { agentIds: ['a-claude'] });
    setAgent('a-claude');
    mockTaskOrder.push('ghost-task'); // no entry in mockTasks

    expect(getBroadcastTargetCount()).toBe(1);
  });
});

// ── idle-gated per-agent FIFO queue ─────────────────────────────────────────
describe('broadcast queue (idle-gated per-agent FIFO)', () => {
  const AGENT = 'agent-1';
  const STABILITY_MS = 50;
  let delivered: string[];

  function setRunningAgent(id: string): void {
    mockAgents[id] = { id, status: 'running', def: { command: 'claude' } };
  }

  function recordDeliveries(): void {
    __broadcastTestHooks.setDeliver((_id, text) => {
      delivered.push(text);
      return Promise.resolve();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    __broadcastTestHooks.reset();
    ts.tail = '';
    ts.idle = true;
    ts.question = false;
    ts.captured = undefined;
    delivered = [];
  });

  afterEach(() => {
    __broadcastTestHooks.reset();
    vi.useRealTimers();
  });

  it('registers a readiness subscriber (ensureSubscribed) that drives tryFlush', async () => {
    setRunningAgent(AGENT);
    ts.tail = '❯';
    recordDeliveries();

    expect(enqueue(AGENT, 'A')).toBe(true);
    expect(subscribeAgentReadiness).toHaveBeenCalledTimes(1);

    // Firing the captured callback (as markAgentOutput would) drains the queue.
    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A']);
  });

  it('drains queued prompts in FIFO order once the prompt is stable', async () => {
    setRunningAgent(AGENT);
    ts.tail = '❯';
    recordDeliveries();

    expect(enqueue(AGENT, 'A')).toBe(true);
    expect(enqueue(AGENT, 'B')).toBe(true);

    ts.captured?.(AGENT);
    expect(delivered).toEqual([]); // <50ms stability flicker guard: nothing yet
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A', 'B']);
    expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
  });

  it('does not double-deliver under a re-entrant readiness fire (single write lock)', async () => {
    setRunningAgent(AGENT);
    ts.tail = '❯';
    let releaseFirst: (() => void) | undefined;
    __broadcastTestHooks.setDeliver((_id, text) => {
      delivered.push(text);
      if (delivered.length === 1) {
        return new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    });

    enqueue(AGENT, 'A');
    enqueue(AGENT, 'B');

    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A']); // A in flight, lock held
    expect(__broadcastTestHooks.isWriting(AGENT)).toBe(true);

    // Re-entrant readiness fire while the lock is held must NOT deliver B.
    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A']);

    // Releasing the lock drains B in order.
    releaseFirst?.();
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A', 'B']);
  });

  it('a one-chunk marker flicker does not flush mid-stream', async () => {
    setRunningAgent(AGENT);
    ts.tail = '❯';
    recordDeliveries();

    enqueue(AGENT, 'A');
    ts.captured?.(AGENT); // ready seen; schedule stability recheck

    // Marker vanishes (busy output streams in) before the window elapses.
    ts.tail = 'compiling the project… esc to interrupt';
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual([]);

    // Marker returns and persists ≥50ms → flush.
    ts.tail = '❯';
    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A']);
  });

  it('holds while a question dialog is active, then flushes once it clears', async () => {
    setRunningAgent(AGENT);
    ts.tail = '❯';
    ts.question = true;
    recordDeliveries();

    enqueue(AGENT, 'A');
    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual([]); // question gate holds

    ts.question = false;
    ts.captured?.(AGENT);
    await vi.advanceTimersByTimeAsync(STABILITY_MS);
    expect(delivered).toEqual(['A']);
  });

  it('rejects enqueue past MAX_PENDING_PER_AGENT (8)', () => {
    setRunningAgent(AGENT);
    for (let i = 0; i < 8; i++) expect(enqueue(AGENT, `p${i}`)).toBe(true);
    expect(enqueue(AGENT, 'overflow')).toBe(false);
    expect(__broadcastTestHooks.queueLength(AGENT)).toBe(8);
  });

  it('rejects an oversize prompt (> MAX_PROMPT_BYTES)', () => {
    setRunningAgent(AGENT);
    const huge = 'a'.repeat(64 * 1024 + 1);
    expect(enqueue(AGENT, huge)).toBe(false);
  });

  it('drops the queue when the agent is no longer running', () => {
    setRunningAgent(AGENT);
    enqueue(AGENT, 'A');
    mockAgents[AGENT].status = 'exited';
    tryFlush(AGENT);
    expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
  });
});
