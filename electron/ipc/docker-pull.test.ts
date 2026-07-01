/**
 * Unit tests for the Docker image pre-pull resilience orchestrator.
 * Pure logic — Docker is fully faked, no network/subprocess/timers.
 */

import { describe, expect, it, vi } from 'vitest';
import { ensureDockerImageAvailable } from './docker-pull.js';

const IMAGE = 'thunderockforge/forge-agent:latest';

/** Build a deps object with sensible fakes; override per test. */
function makeDeps(over: { present?: boolean[]; pullCodes?: number[]; signal?: AbortSignal }) {
  const present = [...(over.present ?? [])];
  const pullCodes = [...(over.pullCodes ?? [])];
  const status: string[] = [];
  const pull = vi.fn(async () => (pullCodes.length ? (pullCodes.shift() as number) : -1));
  const delay = vi.fn(async () => {});
  const imagePresent = vi.fn(async () => (present.length ? (present.shift() as boolean) : false));
  return {
    deps: {
      imagePresent,
      pull,
      delay,
      onStatus: (l: string) => status.push(l),
      signal: over.signal ?? new AbortController().signal,
    },
    status,
    pull,
    delay,
    imagePresent,
  };
}

describe('ensureDockerImageAvailable', () => {
  it('skips the pull entirely when the image is already cached locally', async () => {
    const { deps, pull } = makeDeps({ present: [true] });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: true, usedLocal: true });
    expect(pull).not.toHaveBeenCalled();
  });

  it('pulls once and succeeds when the image is missing', async () => {
    const { deps, pull } = makeDeps({ present: [false], pullCodes: [0] });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff and succeeds on a later attempt', async () => {
    const { deps, pull, delay, status } = makeDeps({
      present: [false],
      pullCodes: [1, 0], // fail, then succeed
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: true, usedLocal: false });
    expect(pull).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledTimes(1);
    expect(status.some((s) => /retry/i.test(s))).toBe(true);
  });

  it('gives up after maxAttempts when pulls keep failing and nothing is cached', async () => {
    const { deps, pull } = makeDeps({
      present: [false, false], // initial check + final fallback check
      pullCodes: [1, 1, 1],
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: false, reason: 'pull-failed' });
    expect(pull).toHaveBeenCalledTimes(3);
  });

  it('falls back to a locally cached copy when pulls fail but the image is present', async () => {
    const { deps } = makeDeps({
      present: [false, true], // missing up front, but present on the final fallback check
      pullCodes: [1, 1, 1],
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: true, usedLocal: true });
  });

  it('returns cancelled without pulling when aborted before start', async () => {
    const ac = new AbortController();
    ac.abort();
    const { deps, pull } = makeDeps({ present: [false], signal: ac.signal });
    const res = await ensureDockerImageAvailable(IMAGE, deps);
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
    expect(pull).not.toHaveBeenCalled();
  });

  it('returns cancelled when aborted during a pull', async () => {
    const ac = new AbortController();
    const { deps } = makeDeps({ present: [false], pullCodes: [-1], signal: ac.signal });
    // Abort as soon as the pull is attempted.
    deps.pull = vi.fn(async () => {
      ac.abort();
      return -1;
    });
    const res = await ensureDockerImageAvailable(IMAGE, deps, { maxAttempts: 3 });
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
  });
});
