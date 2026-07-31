import type { StepEntry } from '../ipc/types';

const STALE_AFTER_MS = 5 * 60_000;
const ACTIVE_STATUSES = new Set<StepEntry['status']>([
  'starting',
  'investigating',
  'implementing',
  'testing',
]);

const PHASE_LABELS: Record<StepEntry['status'], string> = {
  starting: 'Starting',
  investigating: 'Investigating',
  implementing: 'Implementing',
  testing: 'Testing',
  awaiting_review: 'Review',
  done: 'Done',
};

interface TaskStepSource {
  stepsEnabled?: boolean;
  stepsContent?: StepEntry[];
}

export interface TaskCurrentState {
  phase: string;
  summary: string;
  freshness: string | null;
  stale: boolean;
}

function elapsedLabel(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1_000);
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function getTaskCurrentState(
  task: TaskStepSource,
  nowMs = Date.now(),
): TaskCurrentState | null {
  if (!task.stepsEnabled) return null;

  const latest = task.stepsContent?.at(-1);
  if (!latest) {
    return {
      phase: 'Starting',
      summary: 'Waiting for first update',
      freshness: null,
      stale: false,
    };
  }

  const timestampMs = Date.parse(latest.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return {
      phase: PHASE_LABELS[latest.status] ?? 'Working',
      summary: latest.summary?.trim() || 'Waiting for next update',
      freshness: 'update time unavailable',
      stale: false,
    };
  }

  const ageMs = Math.max(0, nowMs - timestampMs);
  const stale = ACTIVE_STATUSES.has(latest.status) && ageMs >= STALE_AFTER_MS;
  const elapsed = elapsedLabel(ageMs);

  return {
    phase: PHASE_LABELS[latest.status] ?? 'Working',
    summary: latest.summary?.trim() || 'Waiting for next update',
    freshness: stale
      ? `no update ${elapsed}`
      : `updated ${elapsed === 'now' ? elapsed : `${elapsed} ago`}`,
    stale,
  };
}
