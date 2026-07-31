import type { ApiDiffResult } from './types.js';

export const MAX_DIFF_BYTES = 50_000;

export function truncateDiffForTool(diff: string): {
  diff: string;
  truncated?: true;
  originalSizeBytes?: number;
} {
  if (diff.length <= MAX_DIFF_BYTES) return { diff };
  return {
    diff: diff.slice(0, MAX_DIFF_BYTES) + '\n... (diff truncated)',
    truncated: true,
    originalSizeBytes: diff.length,
  };
}

export function formatDiffForTool(result: ApiDiffResult, mergeInfo?: string): string {
  const summary = result.files
    .map(
      (f) =>
        `${f.status} ${f.path} (+${f.lines_added} -${f.lines_removed})` +
        (f.committed ? '' : ' [NOT COMMITTED — will be auto-committed on merge]'),
    )
    .join('\n');
  const { diff } = truncateDiffForTool(result.diff);
  const formatted = `Changed files:\n${summary}\n\n${diff}`;
  return mergeInfo ? `${mergeInfo}\n\n${formatted}` : formatted;
}
