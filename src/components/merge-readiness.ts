import type { MergeStatus, PrChecksOverall, WorktreeStatus } from '../ipc/types';
import type { SubtaskVerification } from '../store/types';

export type MergeReadinessCheckStatus = 'pass' | 'warning' | 'blocked' | 'checking' | 'neutral';

export interface MergeReadinessCheck {
  label: string;
  status: MergeReadinessCheckStatus;
  detail: string;
}

export interface MergeReadiness {
  overall: 'ready' | 'attention' | 'blocked' | 'checking';
  checks: MergeReadinessCheck[];
}

interface PrReadinessState {
  overall: PrChecksOverall;
  passing: number;
  pending: number;
  failing: number;
}

export interface MergeReadinessInput {
  expectedBranch: string;
  mergeStatus?: MergeStatus;
  mergeStatusLoading: boolean;
  worktreeStatus?: WorktreeStatus;
  worktreeStatusLoading: boolean;
  verification?: SubtaskVerification;
  prChecks?: PrReadinessState;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function mergeSafetyCheck(input: MergeReadinessInput): MergeReadinessCheck {
  if (input.mergeStatusLoading || input.worktreeStatusLoading) {
    return { label: 'Merge safety', status: 'checking', detail: 'Checking merge safety…' };
  }

  const merge = input.mergeStatus;
  const worktree = input.worktreeStatus;
  if (worktree?.current_branch === null) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: 'Worktree has a detached HEAD.',
    };
  }
  if (worktree && worktree.current_branch !== input.expectedBranch) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: `Worktree is on '${worktree.current_branch}', expected '${input.expectedBranch}'.`,
    };
  }
  if (merge && merge.conflicting_files.length > 0) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: `${countLabel(merge.conflicting_files.length, 'conflicting file')} must be resolved.`,
    };
  }
  if (worktree && !worktree.has_committed_changes) {
    return {
      label: 'Merge safety',
      status: 'blocked',
      detail: 'No committed changes are available to merge.',
    };
  }
  if (!merge || !worktree) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: 'Merge safety could not be checked.',
    };
  }
  if (merge.main_ahead_count > 0) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: `${merge.base_branch} is ${countLabel(merge.main_ahead_count, 'commit')} ahead. Rebase recommended.`,
    };
  }
  if (worktree.has_uncommitted_changes) {
    return {
      label: 'Merge safety',
      status: 'warning',
      detail: 'Uncommitted changes will be excluded.',
    };
  }
  return { label: 'Merge safety', status: 'pass', detail: 'Branch is mergeable.' };
}

function verificationCheck(verification?: SubtaskVerification): MergeReadinessCheck {
  if (!verification?.checks.length) {
    return {
      label: 'Verification',
      status: 'warning',
      detail: 'No verification was reported.',
    };
  }
  const failed = verification.checks.find((check) => check.result !== 'passed');
  if (failed) {
    return {
      label: 'Verification',
      status: 'warning',
      detail: `${failed.name} ${failed.result}${failed.reason ? ` — ${failed.reason}` : ''}`,
    };
  }
  return {
    label: 'Verification',
    status: 'pass',
    detail: `${countLabel(verification.checks.length, 'check')} passed.`,
  };
}

function prCheck(prChecks?: PrReadinessState): MergeReadinessCheck {
  if (!prChecks || prChecks.overall === 'none') {
    return { label: 'PR checks', status: 'neutral', detail: 'No PR checks available.' };
  }
  if (prChecks.overall === 'pending') {
    const failing = prChecks.failing
      ? `, ${countLabel(prChecks.failing, 'failing', 'failing')}`
      : '';
    return {
      label: 'PR checks',
      status: 'warning',
      detail: `${countLabel(prChecks.pending, 'pending', 'pending')}, ${countLabel(prChecks.passing, 'passing', 'passing')}${failing}.`,
    };
  }
  if (prChecks.overall === 'failure') {
    const pending = prChecks.pending
      ? `, ${countLabel(prChecks.pending, 'pending', 'pending')}`
      : '';
    return {
      label: 'PR checks',
      status: 'warning',
      detail: `${countLabel(prChecks.failing, 'failing', 'failing')}, ${countLabel(prChecks.passing, 'passing', 'passing')}${pending}.`,
    };
  }
  return {
    label: 'PR checks',
    status: 'pass',
    detail: `${countLabel(prChecks.passing, 'check')} passed.`,
  };
}

export function buildMergeReadiness(input: MergeReadinessInput): MergeReadiness {
  const checks = [
    mergeSafetyCheck(input),
    verificationCheck(input.verification),
    prCheck(input.prChecks),
  ];
  const overall = checks.some((check) => check.status === 'blocked')
    ? 'blocked'
    : checks.some((check) => check.status === 'checking')
      ? 'checking'
      : checks.some((check) => check.status === 'warning')
        ? 'attention'
        : 'ready';
  return { overall, checks };
}
