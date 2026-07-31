import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldAnimateTaskAppearance } from './reducedMotion';

describe('shouldAnimateTaskAppearance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('allows animation when reduced motion is not requested', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: false });
    vi.stubGlobal('window', { matchMedia });

    expect(shouldAnimateTaskAppearance()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('disables animation when reduced motion is requested', () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('window', { matchMedia });

    expect(shouldAnimateTaskAppearance()).toBe(false);
  });

  it('allows animation when matchMedia is unavailable', () => {
    vi.stubGlobal('window', {});

    expect(shouldAnimateTaskAppearance()).toBe(true);
  });
});
