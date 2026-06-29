import { describe, expect, it } from 'vitest';
import {
  isStartupBlockingAutoSend,
  shouldAbortInitialPromptAfterTimeout,
} from './prompt-autosend-readiness';
import { normalizeCurrentFrame } from '../store/taskStatus';

describe('isStartupBlockingAutoSend', () => {
  it('blocks while Codex is still loading the model', () => {
    expect(isStartupBlockingAutoSend('model: loading   /model to change\n›')).toBe(true);
  });

  it('blocks while Codex is starting MCP servers', () => {
    expect(
      isStartupBlockingAutoSend(
        'Starting MCP servers (0/2): codex_apps, forge\n› Explain this codebase',
      ),
    ).toBe(true);
  });

  it('blocks while Codex is booting a single MCP server', () => {
    expect(isStartupBlockingAutoSend('Booting MCP server: forge\n›')).toBe(true);
  });

  it('ignores stale startup text before the latest screen clear', () => {
    const tail = 'Starting MCP servers (0/2): forge\x1b[2J\x1b[H›';
    expect(isStartupBlockingAutoSend(tail)).toBe(false);
  });

  it('blocks while Codex is booting multiple MCP servers (plural form)', () => {
    expect(isStartupBlockingAutoSend('Booting MCP servers: forge\n›')).toBe(true);
  });

  it('blocks during mid-redraw: screen-clear issued but new frame not yet drawn', () => {
    // Codex emits \x1b[2J\x1b[H to start a new frame, but no content has arrived yet.
    // normalizeCurrentFrame returns '' in this window — treat as blocking so we
    // don't start stability checks against an empty snapshot.
    const tail = 'model: loading...\x1b[2J\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('blocks during cursor-home-only mid-redraw (no screen clear)', () => {
    const tail = 'Starting MCP servers (1/2)\x1b[H';
    expect(isStartupBlockingAutoSend(tail)).toBe(true);
  });

  it('does not block when the current frame has visible non-startup content', () => {
    // A screen clear followed by something unrelated to startup is ready.
    expect(isStartupBlockingAutoSend('\x1b[2J\x1b[H›')).toBe(false);
  });
});

describe('normalizeCurrentFrame (used to gate initial-prompt delivery)', () => {
  it('returns falsy while no renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('')).toBeFalsy();
  });

  it('returns falsy for control-only renderer output', () => {
    expect(normalizeCurrentFrame('\x1b[?2004h\x1b[?1004h')).toBeFalsy();
  });

  it('returns truthy once any renderer tail has been observed', () => {
    expect(normalizeCurrentFrame('› Explain this codebase')).toBeTruthy();
  });
});

describe('shouldAbortInitialPromptAfterTimeout', () => {
  it('does not abort before the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 44_999,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps coordinated sub-task initial assignments alive after the readiness timeout', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: 'coordinator-1',
        tail: '› Explain this codebase',
      }),
    ).toBe(false);
  });

  it('keeps prompt delivery alive after timeout when no renderer tail has been observed', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '',
      }),
    ).toBe(false);
  });

  it('aborts non-coordinated initial prompts after timeout once output is visible', () => {
    expect(
      shouldAbortInitialPromptAfterTimeout({
        elapsedMs: 45_001,
        maxWaitMs: 45_000,
        coordinatedBy: undefined,
        tail: '› Explain this codebase',
      }),
    ).toBe(true);
  });
});
