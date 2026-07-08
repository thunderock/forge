import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined, type MockStoreHarness } from './test-helpers';

const { mockMarkAgentSpawned } = vi.hoisted(() => ({
  mockMarkAgentSpawned: vi.fn(),
}));
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<{ agents: Record<string, AgentLike> }> | undefined,
}));

let mockAgents: Record<string, AgentLike> = {};

interface AgentLike {
  id: string;
  taskId: string;
  def: AgentDefLike;
  resumed: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
  signal: string | null;
  lastOutput: string[];
  generation: number;
  spawnDelayMs?: number;
  attachExisting?: boolean;
}

interface AgentDefLike {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
}

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness({
    get agents() {
      return mockAgents;
    },
    set agents(next) {
      mockAgents = next;
    },
  });
  return core.harness.moduleMock();
});

vi.mock('./taskStatus', () => ({
  markAgentSpawned: mockMarkAgentSpawned,
  refreshTaskStatus: vi.fn(),
  clearAgentActivity: vi.fn(),
}));

vi.mock('./persistence', () => ({ saveState: vi.fn() }));
vi.mock('../lib/ipc', () => ({ invoke: vi.fn() }));

import { restartAgent, switchAgent } from './agents';

const codexDef: AgentDefLike = {
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  args: [],
  resume_args: ['resume', '--last'],
  skip_permissions_args: [],
  description: '',
};

function exitedAgent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    id: 'agent-1',
    taskId: 'task-1',
    def: codexDef,
    resumed: false,
    status: 'exited',
    exitCode: 1,
    signal: '1',
    lastOutput: ['interrupted'],
    generation: 2,
    spawnDelayMs: 500,
    attachExisting: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const harness = expectDefined(core.harness, 'mock store harness');
  harness.reset(harness.state());
  mockAgents = { 'agent-1': exitedAgent() };
});

describe('restartAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    restartAgent('agent-1', true);

    expect(mockAgents['agent-1']).toMatchObject({
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: true,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});

describe('switchAgent', () => {
  it('marks the next terminal mount as an explicit process replacement', () => {
    const claudeDef: AgentDefLike = {
      ...codexDef,
      id: 'claude',
      name: 'Claude',
      command: 'claude',
    };

    switchAgent('agent-1', claudeDef);

    expect(mockAgents['agent-1']).toMatchObject({
      def: claudeDef,
      status: 'running',
      exitCode: null,
      signal: null,
      lastOutput: [],
      resumed: false,
      generation: 3,
      attachExisting: false,
    });
    expect(mockAgents['agent-1'].spawnDelayMs).toBeUndefined();
    expect(mockMarkAgentSpawned).toHaveBeenCalledWith('agent-1');
  });
});
