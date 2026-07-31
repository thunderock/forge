import { describe, expect, it } from 'vitest';
import { formatDiffForTool, MAX_DIFF_BYTES } from './diff-format.js';

describe('formatDiffForTool', () => {
  it('formats changed file summaries and uncommitted markers', () => {
    const text = formatDiffForTool({
      files: [
        {
          path: 'src/app.ts',
          lines_added: 2,
          lines_removed: 1,
          status: 'M',
          committed: false,
        },
      ],
      diff: 'diff --git a/src/app.ts b/src/app.ts\n',
    });

    expect(text).toContain(
      'M src/app.ts (+2 -1) [NOT COMMITTED — will be auto-committed on merge]',
    );
    expect(text).toContain('diff --git a/src/app.ts b/src/app.ts');
  });

  it('prepends merge info when supplied', () => {
    const text = formatDiffForTool(
      {
        files: [],
        diff: '',
      },
      'Merged into main: +1 -0 lines',
    );

    expect(text.startsWith('Merged into main: +1 -0 lines\n\nChanged files:')).toBe(true);
  });

  it('uses the shared truncation limit', () => {
    const text = formatDiffForTool({
      files: [],
      diff: 'x'.repeat(MAX_DIFF_BYTES + 1),
    });

    expect(text).toContain(`${'x'.repeat(16)}`);
    expect(text).toContain('... (diff truncated)');
  });
});
