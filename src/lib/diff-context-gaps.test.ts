import { describe, expect, it } from 'vitest';

import { getContextGapLineCount } from './diff-context-gaps';

describe('getContextGapLineCount', () => {
  it('counts bounded hidden context lines', () => {
    expect(getContextGapLineCount({ startLine: 3, endLine: 8, oldLineStart: 3 })).toBe(5);
  });

  it('does not return negative counts for touching or overlapping hunks', () => {
    expect(getContextGapLineCount({ startLine: 8, endLine: 8, oldLineStart: 8 })).toBe(0);
    expect(getContextGapLineCount({ startLine: 9, endLine: 8, oldLineStart: 9 })).toBe(0);
  });

  it('returns null for trailing gaps that need file content inspection', () => {
    expect(getContextGapLineCount({ startLine: 8, oldLineStart: 8 })).toBeNull();
  });
});
