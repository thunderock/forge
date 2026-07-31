import { describe, expect, it } from 'vitest';
import { shouldDisableCloseTaskConfirm } from './CloseTaskDialog';

describe('shouldDisableCloseTaskConfirm', () => {
  it('disables confirmation for internal worktree tasks while status is loading', () => {
    expect(
      shouldDisableCloseTaskConfirm({ gitIsolation: 'worktree', externalWorktree: false }, true),
    ).toBe(true);
  });

  it('enables confirmation after internal worktree status loads', () => {
    expect(
      shouldDisableCloseTaskConfirm({ gitIsolation: 'worktree', externalWorktree: false }, false),
    ).toBe(false);
  });

  it('does not block imported external worktrees', () => {
    expect(
      shouldDisableCloseTaskConfirm({ gitIsolation: 'worktree', externalWorktree: true }, true),
    ).toBe(false);
  });

  it('does not block non-worktree tasks', () => {
    expect(shouldDisableCloseTaskConfirm({ gitIsolation: 'direct' }, true)).toBe(false);
    expect(shouldDisableCloseTaskConfirm({ gitIsolation: 'none' }, true)).toBe(false);
  });
});
