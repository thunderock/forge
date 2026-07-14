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

import { enumerateBroadcastTargets, getBroadcastTargetCount } from './broadcast';

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
