import { describe, expect, it } from 'vitest';
import { shouldPollTaskCommits } from './task-commit-polling';

describe('shouldPollTaskCommits', () => {
  it('polls visible and not-yet-measured panels in the tiled layout', () => {
    expect(shouldPollTaskCommits(false, false, 'visible')).toBe(true);
    expect(shouldPollTaskCommits(false, false, undefined)).toBe(true);
  });

  it('does not poll offscreen panels in the tiled layout', () => {
    expect(shouldPollTaskCommits(false, true, 'offscreen-left')).toBe(false);
    expect(shouldPollTaskCommits(false, true, 'offscreen-right')).toBe(false);
  });

  it('only polls the active panel in focus mode', () => {
    expect(shouldPollTaskCommits(true, true, 'offscreen-left')).toBe(true);
    expect(shouldPollTaskCommits(true, false, 'visible')).toBe(false);
  });
});
