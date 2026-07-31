import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { Task } from '../store/types';
import { TaskCurrentStateLine } from './TaskCurrentStateLine';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Realtime sync',
    projectId: 'project-1',
    branchName: 'task/realtime-sync',
    worktreePath: '/repo/.worktrees/realtime-sync',
    agentIds: [],
    shellAgentIds: [],
    notes: '',
    lastPrompt: '',
    gitIsolation: 'worktree',
    stepsEnabled: true,
    stepsContent: [
      {
        summary: 'Running integration tests',
        status: 'testing',
        timestamp: '2026-07-10T11:58:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('TaskCurrentStateLine', () => {
  it('renders phase, current activity, and freshness as visible text', () => {
    const html = renderToString(() =>
      TaskCurrentStateLine({ task: task(), nowMs: NOW, variant: 'sidebar' }),
    );

    expect(html).toContain('Testing');
    expect(html).toContain('Running integration tests');
    expect(html).toContain('updated 2m ago');
    expect(html).toContain('>2m<');
    expect(html).toContain('aria-label="Testing: Running integration tests, updated 2m ago"');
  });

  it('keeps stale freshness compact but explicit in the sidebar', () => {
    const html = renderToString(() =>
      TaskCurrentStateLine({
        task: task({
          stepsContent: [
            {
              summary: 'Running integration tests',
              status: 'testing',
              timestamp: '2026-07-10T11:52:00.000Z',
            },
          ],
        }),
        nowMs: NOW,
        variant: 'sidebar',
      }),
    );

    expect(html).toContain('>8m stale<');
    expect(html).toContain('aria-label="Testing: Running integration tests, no update 8m"');
  });

  it('exposes stale freshness without relying on color', () => {
    const html = renderToString(() =>
      TaskCurrentStateLine({
        task: task({
          stepsContent: [
            {
              summary: 'Running integration tests',
              status: 'testing',
              timestamp: '2026-07-10T11:52:00.000Z',
            },
          ],
        }),
        nowMs: NOW,
        variant: 'card',
      }),
    );

    expect(html).toContain('no update 8m');
    expect(html).toContain('task-current-state-card');
  });

  it('renders nothing when steps tracking is disabled', () => {
    const html = renderToString(() =>
      TaskCurrentStateLine({
        task: task({ stepsEnabled: false }),
        nowMs: NOW,
        variant: 'sidebar',
      }),
    );

    expect(html).toBe('');
  });
});
