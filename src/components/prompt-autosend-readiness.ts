import { normalizeCurrentFrame } from '../store/taskStatus';

const STARTUP_BLOCKING_PATTERNS: RegExp[] = [
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+server\b/i,
  /\bStarting\s+MCP\s+servers?\b/i,
];

export function isStartupBlockingAutoSend(tail: string): boolean {
  const frame = normalizeCurrentFrame(tail);
  if (!frame) return false;
  return STARTUP_BLOCKING_PATTERNS.some((re) => re.test(frame));
}

export function shouldKeepWaitingForInitialPromptOutput(tail: string): boolean {
  return !normalizeCurrentFrame(tail);
}

export function shouldAbortInitialPromptAfterTimeout(params: {
  elapsedMs: number;
  maxWaitMs: number;
  coordinatedBy: string | undefined;
  tail: string;
}): boolean {
  if (params.elapsedMs <= params.maxWaitMs) return false;
  if (params.coordinatedBy) return false;
  return !shouldKeepWaitingForInitialPromptOutput(params.tail);
}
