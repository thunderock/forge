import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// Controllable taskStatus signals + captured readiness/teardown subscribers.
// Hoisted so the vi.mock factory can close over them safely.
const ts = vi.hoisted(() => ({
  tail: '',
  idle: true,
  question: false,
  captured: undefined as ((agentId: string) => void) | undefined,
  capturedTeardown: undefined as ((agentId: string) => void) | undefined,
}));

// sendPrompt is mocked so per-agent delivery is a controllable spy — the queue
// logic + per-agent render are provable with no real pty (default resolves).
const tasksMock = vi.hoisted(() => ({
  sendPrompt: vi.fn((_taskId: string, _agentId: string, _text: string) => Promise.resolve()),
}));

// showNotification is mocked so drop/failure notices are assertable.
const notifyMock = vi.hoisted(() => ({
  showNotification: vi.fn((_message: string) => {}),
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

// taskStatus is mocked so readiness/idle/question and both notifiers are fully
// controllable — the queue logic is provable with no real pty.
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
  subscribeAgentTeardown: vi.fn((fn: (agentId: string) => void) => {
    ts.capturedTeardown = fn;
    return () => {
      ts.capturedTeardown = undefined;
    };
  }),
}));

vi.mock('./tasks', () => ({ sendPrompt: tasksMock.sendPrompt }));
vi.mock('./notification', () => ({ showNotification: notifyMock.showNotification }));

import { subscribeAgentReadiness, subscribeAgentTeardown } from './taskStatus';
import {
  enumerateBroadcastTargets,
  getBroadcastTargetCount,
  getBroadcastPending,
  broadcast,
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

function setRunningAgent(id: string, command = 'claude'): void {
  mockAgents[id] = { id, status: 'running', def: { command } };
}

// A queued item now carries its taskId so deliverNext can call the UNMODIFIED
// sendPrompt(taskId, agentId, text).
function item(text: string, taskId = 'task-q'): { taskId: string; text: string } {
  return { taskId, text };
}

/** Ordered list of prompt bodies passed to the sendPrompt spy. */
function sentTexts(): string[] {
  return tasksMock.sendPrompt.mock.calls.map((c) => c[2]);
}

beforeEach(() => {
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockTasks = {};
  mockAgents = {};
  mockTaskOrder = [];
  __broadcastTestHooks.reset();
});

// ── getBroadcastPending (per-pane "Queued (broadcast)" indicator) ────────────
describe('getBroadcastPending', () => {
  it('reflects the queue head, with (+N more) when stacked', () => {
    expect(getBroadcastPending('a-1')).toBeUndefined();
    enqueue('a-1', item('first'));
    expect(getBroadcastPending('a-1')).toBe('first');
    enqueue('a-1', item('second'));
    // Head stays 'first'; the suffix communicates the backlog depth.
    expect(getBroadcastPending('a-1')).toBe('first (+1 more)');
  });

  it('truncates a long queued prompt to a bounded snippet', () => {
    const long = 'x'.repeat(200);
    enqueue('a-1', item(long));
    const pending = expectDefined(getBroadcastPending('a-1'), 'pending');
    expect(pending.length).toBeLessThan(long.length);
    expect(pending.endsWith('…')).toBe(true);
  });

  it('clears when the agent tears down (exit)', () => {
    enqueue('a-1', item('hello'));
    expect(getBroadcastPending('a-1')).toBe('hello');
    // The teardown notifier fires on agent removal (clearAgentActivity).
    expectDefined(ts.capturedTeardown, 'teardown subscriber')('a-1');
    expect(getBroadcastPending('a-1')).toBeUndefined();
  });

  it('does not linger after an immediate write-through to an idle agent', async () => {
    setTask('task-idle', { agentIds: ['a-idle'] });
    setRunningAgent('a-idle');
    ts.idle = true;
    ts.tail = '❯ '; // hardened-ready marker → dispatch write-through
    await broadcast('go');
    // deliverNext shifts synchronously before its await, so the queue drained.
    expect(getBroadcastPending('a-idle')).toBeUndefined();
    expect(sentTexts()).toContain('go');
  });
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

// ── delivery engine (queue + broadcast entry) ───────────────────────────────
describe('broadcast delivery engine', () => {
  const AGENT = 'agent-1';
  const STABILITY_MS = 50;
  const ECHO_SUPPRESS_MS = 2_000;

  beforeEach(() => {
    vi.useFakeTimers();
    __broadcastTestHooks.reset();
    tasksMock.sendPrompt.mockReset();
    tasksMock.sendPrompt.mockImplementation(() => Promise.resolve());
    notifyMock.showNotification.mockReset();
    vi.mocked(subscribeAgentReadiness).mockClear();
    vi.mocked(subscribeAgentTeardown).mockClear();
    ts.tail = '';
    ts.idle = true;
    ts.question = false;
    ts.captured = undefined;
    ts.capturedTeardown = undefined;
  });

  afterEach(() => {
    __broadcastTestHooks.reset();
    vi.useRealTimers();
  });

  // ── idle-gated per-agent FIFO queue ──────────────────────────────────────
  describe('idle-gated per-agent FIFO queue', () => {
    it('registers a readiness subscriber (ensureSubscribed) that drives tryFlush', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';

      expect(enqueue(AGENT, item('A'))).toBe(true);
      expect(subscribeAgentReadiness).toHaveBeenCalledTimes(1);

      // Firing the captured callback (as markAgentOutput would) drains the queue
      // through the UNMODIFIED sendPrompt.
      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']);
      expect(tasksMock.sendPrompt).toHaveBeenCalledWith('task-q', AGENT, 'A');
    });

    it('drains queued prompts in FIFO order, gated by the echo-suppress window', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';

      expect(enqueue(AGENT, item('A'))).toBe(true);
      expect(enqueue(AGENT, item('B'))).toBe(true);

      ts.captured?.(AGENT);
      expect(sentTexts()).toEqual([]); // <50ms stability flicker guard: nothing yet
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']); // A delivered; B held by echo-suppress

      // After the echo-suppress window (agent stays at a stable prompt) B drains.
      await vi.advanceTimersByTimeAsync(ECHO_SUPPRESS_MS + STABILITY_MS);
      expect(sentTexts()).toEqual(['A', 'B']);
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
    });

    it('does not double-deliver under a re-entrant readiness fire (single write lock)', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';
      let releaseFirst: (() => void) | undefined;
      tasksMock.sendPrompt.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      );

      enqueue(AGENT, item('A'));
      enqueue(AGENT, item('B'));

      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']); // A in flight, lock held
      expect(__broadcastTestHooks.isWriting(AGENT)).toBe(true);

      // Re-entrant readiness fire while the lock is held must NOT deliver B.
      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']);

      // Releasing the lock + past the echo-suppress window drains B in order.
      releaseFirst?.();
      await vi.advanceTimersByTimeAsync(ECHO_SUPPRESS_MS + STABILITY_MS);
      expect(sentTexts()).toEqual(['A', 'B']);
    });

    it('a one-chunk marker flicker does not flush mid-stream', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';

      enqueue(AGENT, item('A'));
      ts.captured?.(AGENT); // ready seen; schedule stability recheck

      // Marker vanishes (busy output streams in) before the window elapses.
      ts.tail = 'compiling the project… esc to interrupt';
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual([]);

      // Marker returns and persists ≥50ms → flush.
      ts.tail = '❯';
      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']);
    });

    it('holds while a question dialog is active, then flushes once it clears', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';
      ts.question = true;

      enqueue(AGENT, item('A'));
      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual([]); // question gate holds

      ts.question = false;
      ts.captured?.(AGENT);
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['A']);
    });

    it('rejects enqueue past MAX_PENDING_PER_AGENT (8)', () => {
      setRunningAgent(AGENT);
      for (let i = 0; i < 8; i++) expect(enqueue(AGENT, item(`p${i}`))).toBe(true);
      expect(enqueue(AGENT, item('overflow'))).toBe(false);
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(8);
    });

    it('rejects an oversize prompt (> MAX_PROMPT_BYTES)', () => {
      setRunningAgent(AGENT);
      const huge = 'a'.repeat(64 * 1024 + 1);
      expect(enqueue(AGENT, item(huge))).toBe(false);
    });

    it('drops the queue when the agent is no longer running', () => {
      setRunningAgent(AGENT);
      enqueue(AGENT, item('A'));
      mockAgents[AGENT].status = 'exited';
      tryFlush(AGENT);
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();
    });
  });

  // ── broadcast() public entry ─────────────────────────────────────────────
  describe('broadcast() entry', () => {
    it('write-throughs to two idle agents via per-agent-rendered sendPrompt', async () => {
      // BLOCKER-2 regression guard: two idle+ready agents with empty queues MUST
      // take the dispatch write-through path (no stability wait) → immediate:2.
      setTask('task-claude', { agentIds: ['a-claude'] });
      setAgent('a-claude', { def: { command: 'claude' } });
      setTask('task-codex', { agentIds: ['a-codex'] });
      setAgent('a-codex', { def: { command: 'codex' } });
      ts.tail = '❯';
      ts.idle = true;
      ts.question = false;

      const summary = await broadcast('do X', 'gsd-quick');

      expect(summary).toEqual({ immediate: 2, queued: 0, skipped: 0 });
      // Per-agent render proven via the sendPrompt spy args: claude `/name`, codex `$name`.
      expect(tasksMock.sendPrompt).toHaveBeenCalledWith(
        'task-claude',
        'a-claude',
        '/gsd-quick do X',
      );
      expect(tasksMock.sendPrompt).toHaveBeenCalledWith('task-codex', 'a-codex', '$gsd-quick do X');
    });

    it('delivers a plain-prose broadcast unchanged (no skill token)', async () => {
      setTask('task-claude', { agentIds: ['a-claude'] });
      setAgent('a-claude', { def: { command: 'claude' } });
      ts.tail = '❯';
      ts.idle = true;

      const summary = await broadcast('just do it');
      expect(summary).toEqual({ immediate: 1, queued: 0, skipped: 0 });
      expect(tasksMock.sendPrompt).toHaveBeenCalledWith('task-claude', 'a-claude', 'just do it');
    });

    it('queues for a busy agent, then flushes once it returns to a stable prompt', async () => {
      setTask('t', { agentIds: ['a'] });
      setAgent('a', { def: { command: 'claude' } });
      ts.idle = false;
      ts.tail = 'Working… esc to interrupt';

      const summary = await broadcast('later');
      expect(summary).toEqual({ immediate: 0, queued: 1, skipped: 0 });
      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();

      ts.idle = true;
      ts.tail = '❯';
      ts.captured?.('a');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(tasksMock.sendPrompt).toHaveBeenCalledWith('t', 'a', 'later');
    });

    it('counts an oversize rendered prompt as skipped (never delivered)', async () => {
      setTask('t', { agentIds: ['a'] });
      setAgent('a', { def: { command: 'claude' } });
      ts.tail = '❯';
      ts.idle = true;

      const summary = await broadcast('a'.repeat(64 * 1024 + 1));
      expect(summary).toEqual({ immediate: 0, queued: 0, skipped: 1 });
      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();
    });

    it('echo-suppresses the next queued item until a fresh stable prompt after the window', async () => {
      setTask('t', { agentIds: ['a'] });
      setAgent('a', { def: { command: 'claude' } });
      ts.tail = '❯';

      enqueue('a', item('first', 't'));
      enqueue('a', item('second', 't'));

      ts.captured?.('a');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['first']);

      // Within the echo-suppress window, re-firing readiness must NOT deliver 'second'.
      ts.captured?.('a');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['first']);

      // Agent leaves its prompt (echoes/works) during the window so stability
      // must be genuinely re-established before 'second' flushes.
      ts.tail = 'Working… esc to interrupt';
      await vi.advanceTimersByTimeAsync(ECHO_SUPPRESS_MS);
      expect(sentTexts()).toEqual(['first']);

      // Fresh stable prompt after the window → 'second' drains.
      ts.tail = '❯';
      ts.captured?.('a');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['first', 'second']);
    });

    it('drops (never re-enqueues) a rejected delivery and notifies the user', async () => {
      setTask('t', { agentIds: ['a'] });
      setAgent('a', { def: { command: 'claude' } });
      ts.tail = '❯';
      tasksMock.sendPrompt.mockRejectedValueOnce(new Error('write failed'));

      enqueue('a', item('boom', 't'));
      ts.captured?.('a');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);

      expect(tasksMock.sendPrompt).toHaveBeenCalledTimes(1); // called once, NOT retried
      expect(sentTexts()).toEqual(['boom']);
      expect(__broadcastTestHooks.queueLength('a')).toBe(0); // dropped, not re-enqueued
      expect(notifyMock.showNotification).toHaveBeenCalledWith(
        expect.stringContaining('delivery failed'),
      );
    });
  });

  // ── teardown + never-idle backstop ───────────────────────────────────────
  describe('teardown + never-idle backstop', () => {
    const EMPTY_SIZES = {
      queue: 0,
      writing: 0,
      promptReadySeenAt: 0,
      enqueuedAt: 0,
      stabilityTimers: 0,
      suppressUntil: 0,
    };

    it('subscribes teardown; a teardown fire drops queue + timer + backstop', () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';

      expect(enqueue(AGENT, item('A'))).toBe(true);
      expect(subscribeAgentTeardown).toHaveBeenCalledTimes(1);
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(1);
      expect(__broadcastTestHooks.isBackstopActive()).toBe(true);

      // Simulate the renderer's clearAgentActivity firing the teardown subscriber.
      ts.capturedTeardown?.(AGENT);

      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
      expect(__broadcastTestHooks.hasStabilityTimer(AGENT)).toBe(false);
      expect(__broadcastTestHooks.isBackstopActive()).toBe(false);
      expect(__broadcastTestHooks.internalSizes()).toEqual(EMPTY_SIZES);
    });

    it('a flush timer never writes to a dead pty (status re-checked at flush)', async () => {
      setRunningAgent(AGENT);
      ts.tail = '❯';
      enqueue(AGENT, item('A'));

      // Agent exits after enqueue but before the flush fires.
      mockAgents[AGENT].status = 'exited';
      ts.captured?.(AGENT); // readiness fire → tryFlush → not running → teardown
      await vi.advanceTimersByTimeAsync(STABILITY_MS);

      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
    });

    it('the backstop tears down a pending agent that has exited (no readiness fire)', async () => {
      setRunningAgent(AGENT);
      ts.idle = false;
      ts.tail = 'Working… esc to interrupt';
      enqueue(AGENT, item('A'));
      mockAgents[AGENT].status = 'exited';

      // No readiness fire — only the single backstop interval sweeps it.
      await vi.advanceTimersByTimeAsync(500);

      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
      expect(__broadcastTestHooks.isBackstopActive()).toBe(false);
    });

    it('drops + notifies a never-idle agent after the timeout (policy=drop)', async () => {
      setRunningAgent(AGENT);
      ts.idle = false;
      ts.tail = 'Working… esc to interrupt';
      enqueue(AGENT, item('A'));

      await vi.advanceTimersByTimeAsync(120_000 + 500);

      expect(tasksMock.sendPrompt).not.toHaveBeenCalled();
      expect(__broadcastTestHooks.queueLength(AGENT)).toBe(0);
      expect(notifyMock.showNotification).toHaveBeenCalledWith(
        expect.stringContaining('not delivered'),
      );
      expect(__broadcastTestHooks.isBackstopActive()).toBe(false);
    });

    it('force-write policy flushes at the timeout instead of dropping', async () => {
      setRunningAgent(AGENT);
      ts.idle = false;
      ts.tail = 'Working… esc to interrupt';
      __broadcastTestHooks.setNeverIdlePolicy('force-write');
      enqueue(AGENT, item('A'));

      await vi.advanceTimersByTimeAsync(120_000 + 500);

      expect(tasksMock.sendPrompt).toHaveBeenCalledWith('task-q', AGENT, 'A');
    });

    it('leaves zero residual state after creating and dropping many agents', () => {
      for (let i = 0; i < 5; i++) {
        const id = `a-${i}`;
        setRunningAgent(id);
        enqueue(id, item(`p${i}`, `t-${i}`));
      }
      expect(__broadcastTestHooks.isBackstopActive()).toBe(true);

      for (let i = 0; i < 5; i++) ts.capturedTeardown?.(`a-${i}`);

      expect(__broadcastTestHooks.internalSizes()).toEqual(EMPTY_SIZES);
      expect(__broadcastTestHooks.isBackstopActive()).toBe(false);
    });

    it('drains two rapid broadcasts to one slow agent in FIFO order', async () => {
      setTask('t-slow', { agentIds: ['a-slow'] });
      setAgent('a-slow', { def: { command: 'claude' } });
      ts.idle = false;
      ts.tail = 'Working… esc to interrupt';

      const s1 = await broadcast('first');
      const s2 = await broadcast('second');
      expect(s1).toEqual({ immediate: 0, queued: 1, skipped: 0 });
      expect(s2).toEqual({ immediate: 0, queued: 1, skipped: 0 });
      expect(__broadcastTestHooks.queueLength('a-slow')).toBe(2);

      // Agent returns to a stable prompt; drains A then B in submission order.
      ts.idle = true;
      ts.tail = '❯';
      ts.captured?.('a-slow');
      await vi.advanceTimersByTimeAsync(STABILITY_MS);
      expect(sentTexts()).toEqual(['first']);

      await vi.advanceTimersByTimeAsync(ECHO_SUPPRESS_MS + STABILITY_MS);
      expect(sentTexts()).toEqual(['first', 'second']);
    });
  });
});
