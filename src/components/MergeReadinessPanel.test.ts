import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { MergeStatus, WorktreeStatus } from '../ipc/types';
import type { SubtaskVerification } from '../store/types';
import { MergeReadinessPanel } from './MergeReadinessPanel';
import { buildMergeReadiness, type MergeReadinessInput } from './merge-readiness';

const cleanMergeStatus: MergeStatus = {
  main_ahead_count: 0,
  conflicting_files: [],
  base_branch: 'main',
};

const cleanWorktreeStatus: WorktreeStatus = {
  has_committed_changes: true,
  has_uncommitted_changes: false,
  current_branch: 'task/readiness',
};

const passedVerification: SubtaskVerification = {
  checks: [
    { name: 'typecheck', command: 'npm run typecheck', result: 'passed' },
    { name: 'test', command: 'npm test', result: 'passed' },
  ],
};

function input(overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput {
  return {
    expectedBranch: 'task/readiness',
    mergeStatus: cleanMergeStatus,
    mergeStatusLoading: false,
    worktreeStatus: cleanWorktreeStatus,
    worktreeStatusLoading: false,
    verification: passedVerification,
    ...overrides,
  };
}

describe('buildMergeReadiness', () => {
  it('reports ready when merge safety and reported verification pass', () => {
    const readiness = buildMergeReadiness(input());

    expect(readiness.overall).toBe('ready');
    expect(readiness.checks).toEqual([
      expect.objectContaining({ label: 'Merge safety', status: 'pass' }),
      expect.objectContaining({ label: 'Verification', status: 'pass' }),
      expect.objectContaining({ label: 'PR checks', status: 'neutral' }),
    ]);
  });

  it('reports checking while merge data is loading', () => {
    const readiness = buildMergeReadiness(
      input({ mergeStatus: undefined, mergeStatusLoading: true }),
    );

    expect(readiness.overall).toBe('checking');
    expect(readiness.checks[0]).toEqual(
      expect.objectContaining({ status: 'checking', detail: 'Checking merge safety…' }),
    );
  });

  it.each([
    {
      name: 'conflicting files',
      overrides: {
        mergeStatus: { ...cleanMergeStatus, conflicting_files: ['src/App.tsx'] },
      },
      detail: '1 conflicting file must be resolved.',
    },
    {
      name: 'a mismatched branch',
      overrides: {
        worktreeStatus: { ...cleanWorktreeStatus, current_branch: 'task/other' },
      },
      detail: "Worktree is on 'task/other', expected 'task/readiness'.",
    },
    {
      name: 'no committed changes',
      overrides: {
        worktreeStatus: { ...cleanWorktreeStatus, has_committed_changes: false },
      },
      detail: 'No committed changes are available to merge.',
    },
  ])('reports not ready for $name', ({ overrides, detail }) => {
    const readiness = buildMergeReadiness(input(overrides));

    expect(readiness.overall).toBe('blocked');
    expect(readiness.checks[0]).toEqual(expect.objectContaining({ status: 'blocked', detail }));
  });

  it.each([
    {
      name: 'a detached HEAD when merge status is unavailable',
      overrides: {
        mergeStatus: undefined,
        worktreeStatus: { ...cleanWorktreeStatus, current_branch: null },
      },
      detail: 'Worktree has a detached HEAD.',
    },
    {
      name: 'conflicts when worktree status is unavailable',
      overrides: {
        mergeStatus: { ...cleanMergeStatus, conflicting_files: ['src/App.tsx'] },
        worktreeStatus: undefined,
      },
      detail: '1 conflicting file must be resolved.',
    },
  ])('preserves the known blocker for $name', ({ overrides, detail }) => {
    const readiness = buildMergeReadiness(input(overrides));

    expect(readiness.overall).toBe('blocked');
    expect(readiness.checks[0]).toEqual(expect.objectContaining({ status: 'blocked', detail }));
  });

  it('reports attention for uncommitted changes and missing verification', () => {
    const readiness = buildMergeReadiness(
      input({
        worktreeStatus: { ...cleanWorktreeStatus, has_uncommitted_changes: true },
        verification: undefined,
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[0]).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: 'Uncommitted changes will be excluded.',
      }),
    );
    expect(readiness.checks[1]).toEqual(
      expect.objectContaining({ status: 'warning', detail: 'No verification was reported.' }),
    );
  });

  it('reports attention for failing verification and pending PR checks', () => {
    const readiness = buildMergeReadiness(
      input({
        verification: {
          checks: [
            {
              name: 'test',
              command: 'npm test',
              result: 'failed',
              reason: '2 tests failed',
            },
          ],
        },
        prChecks: { overall: 'pending', passing: 2, pending: 1, failing: 0 },
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[1]).toEqual(
      expect.objectContaining({ status: 'warning', detail: 'test failed — 2 tests failed' }),
    );
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({ status: 'warning', detail: '1 pending, 2 passing.' }),
    );
  });

  it('includes failures while PR checks are still pending', () => {
    const readiness = buildMergeReadiness(
      input({
        prChecks: { overall: 'pending', passing: 2, pending: 1, failing: 1 },
      }),
    );

    expect(readiness.overall).toBe('attention');
    expect(readiness.checks[2]).toEqual(
      expect.objectContaining({
        status: 'warning',
        detail: '1 pending, 2 passing, 1 failing.',
      }),
    );
  });
});

describe('MergeReadinessPanel', () => {
  it('renders an accessible textual summary without relying on status color', () => {
    const readiness = buildMergeReadiness(input());
    const html = renderToString(() => MergeReadinessPanel({ readiness }));

    expect(html).toContain('aria-label="Ready to merge summary"');
    expect(html).toContain('Ready to merge');
    expect(html).toContain('Merge safety');
    expect(html).toContain('Verification');
    expect(html).toContain('2 checks passed.');
    expect(html).toContain('PR checks');
    expect(html).toContain('No PR checks available.');
    expect(html).toContain(
      'title="Ready means every available check passed. Needs attention means a warning; Not ready means a merge-safety blocker; Checking means merge data is loading. This summary is advisory."',
    );
    expect(html).toContain(
      'title="Checks the task branch for conflicts with its base branch, branch mismatch, committed changes, and local uncommitted changes."',
    );
    expect(html).toContain(
      'title="Uses structured verification reported by land_self, such as tests or typechecking. Without a report this needs attention; opening the dialog never runs commands."',
    );
    expect(html).toContain(
      'title="Uses checks reported for a detected GitHub pull request. Pull requests are optional, and unavailable check data is neutral."',
    );
  });
});
