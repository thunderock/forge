import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectDefined } from './test-helpers';
import { getAgentPromptReadiness } from '../../electron/mcp/prompt-detect';
import {
  READY_AGENT_FRAME_FIXTURES,
  NOT_READY_AGENT_FRAME_FIXTURES,
  PROMPT_ECHO_FRAME_FIXTURES,
} from '../../electron/mcp/agent-frame-fixtures';
import { decideBroadcastDelivery, type BroadcastDecisionParams } from './broadcast-decision';

const STABILITY_MS = 50;
const NEVER_IDLE_MS = 120_000;

function params(overrides: Partial<BroadcastDecisionParams> = {}): BroadcastDecisionParams {
  return {
    phase: 'flush',
    queueLength: 1,
    ready: true,
    questionActive: false,
    writeLocked: false,
    idle: true,
    now: 0,
    stabilityMs: STABILITY_MS,
    neverIdleTimeoutMs: NEVER_IDLE_MS,
    neverIdlePolicy: 'drop',
    ...overrides,
  };
}

// ── Hardened detection over recorded frames ─────────────────────────────────
// decideBroadcastDelivery consumes a boolean `ready`; these assertions prove the
// boolean is produced by the HARDENED getAgentPromptReadiness over the shared
// fixtures (never a loose /[❯›]/ scan), so the decision fn is fed trustworthy input.
describe('hardened readiness over recorded frames', () => {
  it.each(READY_AGENT_FRAME_FIXTURES)('ready frame -> ready=true: $name', ({ frame }) => {
    expect(getAgentPromptReadiness(frame).ready).toBe(true);
  });

  it.each(PROMPT_ECHO_FRAME_FIXTURES)('prompt-echo frame -> ready=true: $name', ({ frame }) => {
    expect(getAgentPromptReadiness(frame).ready).toBe(true);
  });

  it.each(NOT_READY_AGENT_FRAME_FIXTURES)('not-ready frame -> ready=false: $name', ({ frame }) => {
    expect(getAgentPromptReadiness(frame).ready).toBe(false);
  });

  it('a `❯ Yes` selector reads not-ready (selection cursor, not the bare prompt)', () => {
    const fx = expectDefined(
      NOT_READY_AGENT_FRAME_FIXTURES.find((f) => f.name === 'Two-option ❯ selection cursor'),
    );
    expect(getAgentPromptReadiness(fx.frame)).toMatchObject({ ready: false, reason: 'no_prompt' });
  });

  it('a busy diff `>` line reads not-ready via the busy short-circuit', () => {
    const fx = expectDefined(
      NOT_READY_AGENT_FRAME_FIXTURES.find((f) => f.name === 'Busy diff hunk with quoted > line'),
    );
    expect(getAgentPromptReadiness(fx.frame)).toMatchObject({ ready: false, reason: 'busy' });
  });

  it('a diff `>` line with NO busy marker reads not-ready via the line-anchored scan', () => {
    // The load-bearing case: with no busy marker to short-circuit, a bare quoted
    // `>` diff line must NOT be mistaken for the Gemini `> ` ready prompt.
    const fx = expectDefined(
      NOT_READY_AGENT_FRAME_FIXTURES.find(
        (f) => f.name === 'Diff hunk with quoted > line, no busy marker',
      ),
    );
    expect(getAgentPromptReadiness(fx.frame)).toMatchObject({ ready: false, reason: 'no_prompt' });
  });
});

// ── dispatch phase (write-through vs enqueue) ───────────────────────────────
describe('decideBroadcastDelivery — dispatch phase', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('idle + ready + empty queue -> write-through even with promptFirstReadyAt undefined', () => {
    // BLOCKER-2 regression guard: dispatch has NO stability requirement. A
    // freshly-idle agent (promptReadySeenAt never set inside tryFlush) must still
    // write-through immediately; the debounced `idle` gate encodes ">50ms at rest".
    expect(
      decideBroadcastDelivery(
        params({
          phase: 'dispatch',
          queueLength: 0,
          ready: true,
          idle: true,
          promptFirstReadyAt: undefined,
          now: 9_999,
        }),
      ),
    ).toEqual({ action: 'write-through' });
  });

  it('ready but NOT idle -> enqueue (idle gate)', () => {
    expect(
      decideBroadcastDelivery(
        params({ phase: 'dispatch', queueLength: 0, ready: true, idle: false }),
      ),
    ).toEqual({ action: 'enqueue' });
  });

  it('busy (ready=false) -> enqueue', () => {
    expect(
      decideBroadcastDelivery(
        params({ phase: 'dispatch', queueLength: 0, ready: false, idle: true }),
      ),
    ).toEqual({ action: 'enqueue' });
  });

  it('non-empty queue -> enqueue even when idle+ready', () => {
    expect(
      decideBroadcastDelivery(
        params({ phase: 'dispatch', queueLength: 2, ready: true, idle: true }),
      ),
    ).toEqual({ action: 'enqueue' });
  });

  it('question active -> enqueue', () => {
    expect(
      decideBroadcastDelivery(
        params({
          phase: 'dispatch',
          queueLength: 0,
          ready: true,
          idle: true,
          questionActive: true,
        }),
      ),
    ).toEqual({ action: 'enqueue' });
  });
});

// ── flush phase (stability-gated drain) ─────────────────────────────────────
describe('decideBroadcastDelivery — flush phase', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('ready but marker flickered (<50ms) -> wait; then (>=50ms) -> flush', () => {
    const firstReadyAt = Date.now(); // 0
    vi.advanceTimersByTime(40);
    expect(
      decideBroadcastDelivery(
        params({ ready: true, promptFirstReadyAt: firstReadyAt, now: Date.now() }),
      ),
    ).toEqual({ action: 'wait' });

    vi.advanceTimersByTime(10); // now = 50ms since first ready
    expect(
      decideBroadcastDelivery(
        params({ ready: true, promptFirstReadyAt: firstReadyAt, now: Date.now() }),
      ),
    ).toEqual({ action: 'flush' });
  });

  it('question active -> wait', () => {
    expect(
      decideBroadcastDelivery(
        params({ ready: true, questionActive: true, promptFirstReadyAt: 0, now: 1_000 }),
      ),
    ).toEqual({ action: 'wait' });
  });

  it('write locked -> wait', () => {
    expect(
      decideBroadcastDelivery(
        params({ ready: true, writeLocked: true, promptFirstReadyAt: 0, now: 1_000 }),
      ),
    ).toEqual({ action: 'wait' });
  });

  it('suppressed (now < suppressUntil) -> wait', () => {
    expect(
      decideBroadcastDelivery(
        params({ ready: true, promptFirstReadyAt: 0, now: 100, suppressUntil: 500 }),
      ),
    ).toEqual({ action: 'wait' });
  });

  it('never-idle past timeout with `drop` policy -> drop', () => {
    expect(
      decideBroadcastDelivery(
        params({ ready: false, enqueuedAt: 0, now: NEVER_IDLE_MS, neverIdlePolicy: 'drop' }),
      ),
    ).toEqual({ action: 'drop', reason: 'never-idle' });
  });

  it('never-idle past timeout with `force-write` policy -> flush', () => {
    expect(
      decideBroadcastDelivery(
        params({ ready: false, enqueuedAt: 0, now: NEVER_IDLE_MS, neverIdlePolicy: 'force-write' }),
      ),
    ).toEqual({ action: 'flush' });
  });

  it('not yet at never-idle timeout and not stable -> wait', () => {
    expect(
      decideBroadcastDelivery(params({ ready: false, enqueuedAt: 0, now: NEVER_IDLE_MS - 1 })),
    ).toEqual({ action: 'wait' });
  });
});
