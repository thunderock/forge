// Shared prompt-detection helpers used by both the renderer (taskStatus.ts)
// and the main-process coordinator (coordinator.ts).

/** Strip ANSI escape sequences (CSI, OSC, and single-char escapes) from terminal output. */
export function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nq-uy=><~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g,
    '',
  );
}

/**
 * Patterns that indicate the agent is waiting for user input (i.e. idle).
 * Each regex is tested against the last non-empty line of stripped output.
 */
export const PROMPT_PATTERNS: RegExp[] = [
  /❯\s*$/, // Claude Code prompt
  /›\s*$/, // Codex CLI prompt
  /(?:^|\s)\$\s*$/, // bash/zsh dollar prompt (preceded by whitespace or BOL)
  /(?:^|\s)%\s*$/, // zsh percent prompt
  /(?:^|\s)#\s*$/, // root prompt
  /\[Y\/n\]\s*$/i, // Y/n confirmation
  /\[y\/N\]\s*$/i, // y/N confirmation
];

/**
 * Patterns for known agent main input prompts (ready for a new task).
 * Tested against the stripped data chunk (not a single line), because TUI
 * apps like Claude Code use cursor positioning instead of newlines.
 */
export const AGENT_READY_TAIL_PATTERNS: RegExp[] = [
  /❯/, // Claude Code
  /›/, // Codex CLI
  /(?:^|\s)>\s*(?:Type your message|$)/i, // Gemini CLI
];

const AGENT_STARTUP_OR_DIALOG_PATTERNS: RegExp[] = [
  /\bDo\s+you\s+trust\b/i,
  /\bPress\s+enter\s+to\s+continue\b/i,
  /\bmodel:\s*loading\b/i,
  /\bBooting\s+MCP\s+server\b/i,
  /\bStarting\s+MCP\s+servers?\b/i,
];

const AGENT_BUSY_TAIL_PATTERNS: RegExp[] = [
  /\bq*Working\s*\(/i,
  /\bbackground\s+terminal\s+running\b/i,
  /\besc\s+to\s+interrupt\b/i,
  /\/stop\s+to\s+close\b/i,
];

/** Check stripped output for known agent prompt characters.
 *  Only checks the tail of the chunk — the agent's main prompt renders near
 *  the end of the visible content, while TUI selection UIs place ❯/› earlier
 *  in the render followed by option text and other choices.
 *  300 chars covers Codex's footer/status lines below the input prompt. */
export function chunkContainsAgentPrompt(stripped: string): boolean {
  if (stripped.length === 0) return false;
  const tail = stripped.slice(-300);
  if (AGENT_STARTUP_OR_DIALOG_PATTERNS.some((re) => re.test(tail))) return false;
  if (AGENT_BUSY_TAIL_PATTERNS.some((re) => re.test(tail))) return false;
  return AGENT_READY_TAIL_PATTERNS.some((re) => re.test(tail));
}
