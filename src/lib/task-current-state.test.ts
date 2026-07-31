import { describe, expect, it } from 'vitest';
import type { StepEntry } from '../ipc/types';
import { getTaskCurrentState } from './task-current-state';

const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function step(overrides: Partial<StepEntry> = {}): StepEntry {
  return {
    summary: 'Running integration tests',
    status: 'testing',
    timestamp: '2026-07-10T11:58:00.000Z',
    ...overrides,
  };
}

describe('getTaskCurrentState', () => {
  it('returns no state when steps tracking is disabled', () => {
    expect(getTaskCurrentState({ stepsEnabled: false }, NOW)).toBeNull();
  });

  it('shows a useful waiting state before the first tracked step', () => {
    expect(getTaskCurrentState({ stepsEnabled: true }, NOW)).toEqual({
      phase: 'Starting',
      summary: 'Waiting for first update',
      freshness: null,
      stale: false,
    });
  });

  it('uses the latest step and exposes its phase and freshness', () => {
    const state = getTaskCurrentState(
      {
        stepsEnabled: true,
        stepsContent: [
          step({ summary: 'Mapped the sync architecture', status: 'investigating' }),
          step(),
        ],
      },
      NOW,
    );

    expect(state).toEqual({
      phase: 'Testing',
      summary: 'Running integration tests',
      freshness: 'updated 2m ago',
      stale: false,
    });
  });

  it('marks an active step as stale after five minutes without an update', () => {
    const state = getTaskCurrentState(
      {
        stepsEnabled: true,
        stepsContent: [step({ timestamp: '2026-07-10T11:53:00.000Z' })],
      },
      NOW,
    );

    expect(state?.freshness).toBe('no update 7m');
    expect(state?.stale).toBe(true);
  });

  it('does not call completed or review states stale', () => {
    const state = getTaskCurrentState(
      {
        stepsEnabled: true,
        stepsContent: [
          step({
            summary: 'Ready for review',
            status: 'awaiting_review',
            timestamp: '2026-07-10T10:00:00.000Z',
          }),
        ],
      },
      NOW,
    );

    expect(state).toEqual({
      phase: 'Review',
      summary: 'Ready for review',
      freshness: 'updated 2h ago',
      stale: false,
    });
  });

  it('handles malformed optional display fields without hiding the task', () => {
    const state = getTaskCurrentState(
      {
        stepsEnabled: true,
        stepsContent: [step({ summary: '   ', timestamp: 'not-a-date' })],
      },
      NOW,
    );

    expect(state).toEqual({
      phase: 'Testing',
      summary: 'Waiting for next update',
      freshness: 'update time unavailable',
      stale: false,
    });
  });
});
