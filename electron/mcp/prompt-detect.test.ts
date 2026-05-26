/**
 * Tests for prompt-detect.ts — stripAnsi, chunkContainsAgentPrompt, PROMPT_PATTERNS.
 *
 * These run with real ANSI escape sequences to verify the terminal output parser
 * correctly identifies agent-ready prompts, trust dialogs, and [Y/n] confirmations
 * while NOT firing on TUI selection ❯ rendered mid-screen.
 */

import { describe, expect, it } from 'vitest';
import { stripAnsi, chunkContainsAgentPrompt, PROMPT_PATTERNS } from './prompt-detect.js';

// ── stripAnsi ─────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('passes through plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('removes CSI color/style codes', () => {
    expect(stripAnsi('\x1b[32mgreen\x1b[0m')).toBe('green');
  });

  it('removes cursor movement sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[H')).toBe('');
  });

  it('removes OSC sequences (hyperlinks, window title)', () => {
    expect(stripAnsi('\x1b]0;title\x07text')).toBe('text');
  });

  it('strips alternate-screen enter/exit (used by TUI apps like Claude Code)', () => {
    // \x1b[?1049h = enter alternate screen, \x1b[?1049l = exit
    const raw = '\x1b[?1049hsome TUI content\x1b[?1049l';
    expect(stripAnsi(raw)).toBe('some TUI content');
  });

  it('handles multiple sequential escape sequences', () => {
    const raw = '\x1b[1m\x1b[33mbold yellow\x1b[0m\x1b[m';
    expect(stripAnsi(raw)).toBe('bold yellow');
  });

  it('returns empty string for input that is only escape sequences', () => {
    expect(stripAnsi('\x1b[2J\x1b[H\x1b[?1049h')).toBe('');
  });
});

// ── PROMPT_PATTERNS ───────────────────────────────────────────────────────────

describe('PROMPT_PATTERNS — last-line detection', () => {
  function matchesAny(line: string): boolean {
    return PROMPT_PATTERNS.some((re) => re.test(line));
  }

  it('matches Claude Code prompt ❯', () => {
    expect(matchesAny('❯')).toBe(true);
    expect(matchesAny('  ❯  ')).toBe(true);
    expect(matchesAny('❯ ')).toBe(true);
  });

  it('matches Codex CLI prompt ›', () => {
    expect(matchesAny('›')).toBe(true);
    expect(matchesAny('  ›  ')).toBe(true);
    expect(matchesAny('› ')).toBe(true);
  });

  it('matches bash $ prompt', () => {
    expect(matchesAny('user@host:~ $ ')).toBe(true);
  });

  it('matches zsh % prompt', () => {
    expect(matchesAny('user@host % ')).toBe(true);
  });

  it('matches root # prompt', () => {
    expect(matchesAny('root@host # ')).toBe(true);
  });

  it('matches [Y/n] confirmation prompt (case-insensitive)', () => {
    expect(matchesAny('Continue? [Y/n] ')).toBe(true);
    expect(matchesAny('Continue? [y/N] ')).toBe(true);
  });

  it('does NOT match regular text containing $ mid-sentence', () => {
    expect(matchesAny('Costs $5 per month')).toBe(false);
  });

  it('does NOT match empty string', () => {
    expect(matchesAny('')).toBe(false);
  });
});

// ── chunkContainsAgentPrompt ──────────────────────────────────────────────────

describe('chunkContainsAgentPrompt', () => {
  it('returns true for a plain ❯ at the tail', () => {
    expect(chunkContainsAgentPrompt('❯')).toBe(true);
  });

  it('returns true for ❯ in the last 300 chars', () => {
    const prefix = 'A'.repeat(200);
    expect(chunkContainsAgentPrompt(`${prefix}❯`)).toBe(true);
  });

  it('returns false when ❯ appears only in the body (TUI selection menu), not the tail', () => {
    // Claude Code TUI selection: ❯ next to an option, then more text follows
    const chunk = `❯ Option A\n${'more menu text '.repeat(30)}`;
    expect(chunk.slice(-300).includes('❯')).toBe(false);
    expect(chunkContainsAgentPrompt(chunk)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(chunkContainsAgentPrompt('')).toBe(false);
  });

  it('returns true for Codex CLI › prompt', () => {
    expect(chunkContainsAgentPrompt('› ')).toBe(true);
  });

  it('returns true for Codex CLI › prompt above footer/status text', () => {
    const footer = '\n\ngpt-5.5 default · ~/repo/worktree';
    expect(chunkContainsAgentPrompt(`›${footer}`)).toBe(true);
  });

  it('does not treat Codex working status as ready even when the input prompt is visible', () => {
    const tail = [
      '› Improve documentation in @filename',
      'gpt-5.5 default · ~/repo/worktree',
      'Working (18m 51s • esc to interrupt) • 1 background terminal running • /ps to view • /stop to close',
    ].join('\n');
    expect(chunkContainsAgentPrompt(tail)).toBe(false);
  });

  it('does not treat control-character damaged Codex working status as ready', () => {
    const tail =
      '› Improve documentation in @filename q qWorking q qorking q q q q q background terminal running q /stop to close';
    expect(chunkContainsAgentPrompt(tail)).toBe(false);
  });

  it('returns true for Gemini CLI input prompt', () => {
    expect(
      chunkContainsAgentPrompt(
        'workspace (/directory) branch sandbox /model quota\n > Type your message or @path/to/file',
      ),
    ).toBe(true);
  });

  it('does not treat Codex startup screens as ready', () => {
    expect(
      chunkContainsAgentPrompt('Starting MCP servers (0/2): codex_apps, parallel-code\n›'),
    ).toBe(false);
    expect(chunkContainsAgentPrompt('model: loading   /model to change\n›')).toBe(false);
  });

  it('does not treat Codex trust dialogs as ready', () => {
    const dialog = [
      'Do you trust the contents of this directory?',
      '› 1. Yes, continue',
      '2. No, quit',
      'Press enter to continue',
    ].join('\n');
    expect(chunkContainsAgentPrompt(dialog)).toBe(false);
  });

  it('handles ANSI-stripped Claude Code prompt (❯ after stripping)', () => {
    // The caller strips ANSI before passing to chunkContainsAgentPrompt.
    // Simulate what the coordinator sees after stripAnsi().
    const stripped = stripAnsi('\x1b[32m❯\x1b[0m');
    expect(chunkContainsAgentPrompt(stripped)).toBe(true);
  });

  it('trust dialog "[Y/n]" is detected by PROMPT_PATTERNS, not chunkContainsAgentPrompt', () => {
    // chunkContainsAgentPrompt detects ❯/› at the tail (agent ready for a task).
    // PROMPT_PATTERNS detects [Y/n] on the last line (autofire-blocking dialog).
    // These two checks serve different purposes — verify they don't overlap here.
    const trustDialog =
      'Do you trust the files in this folder?\n' +
      'Claude Code may execute files in this folder.\n' +
      'Trust folder and all subfolders [Y/n] ';
    // chunkContainsAgentPrompt should return false — no ❯ at tail
    expect(chunkContainsAgentPrompt(trustDialog)).toBe(false);
    // But PROMPT_PATTERNS should match the last line
    const lines = trustDialog.split('\n');
    const lastLine = lines[lines.length - 1] ?? '';
    expect(PROMPT_PATTERNS.some((re) => re.test(lastLine))).toBe(true);
  });

  it('stale ❯ text after alternate-screen clear does NOT re-trigger prompt detection', () => {
    // After alternate-screen exit (\x1b[?1049l), the scroll-back may briefly show
    // previous ❯. The coordinator must not detect this as a new agent prompt.
    // We model this by checking the stripped content in the *tail* only.
    const stale = '\x1b[?1049l'; // alternate-screen exit — no ❯ in plain text
    const stripped = stripAnsi(stale);
    expect(chunkContainsAgentPrompt(stripped)).toBe(false);
  });
});
