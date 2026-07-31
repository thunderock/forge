export interface ContextGapRange {
  startLine: number;
  oldLineStart: number;
  endLine?: number;
}

export function getContextGapLineCount(range: ContextGapRange): number | null {
  if (range.endLine === undefined) return null;
  return Math.max(0, range.endLine - range.startLine);
}
