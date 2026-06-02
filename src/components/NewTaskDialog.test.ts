import { describe, expect, it } from 'vitest';
import { scrollCoordinatorIntoView } from './scrollCoordinatorIntoView';

interface FakeScrollContainer {
  scrollTop: number;
  readonly scrollHeight: number;
}

function fakeContainer(scrollHeight: number): FakeScrollContainer {
  return { scrollTop: 0, scrollHeight };
}

describe('scrollCoordinatorIntoView', () => {
  it('scrolls to scrollHeight when coordinator mode is enabled', () => {
    const el = fakeContainer(800);
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(800);
  });

  it('does not scroll when coordinator mode is disabled', () => {
    const el = fakeContainer(800);
    scrollCoordinatorIntoView(false, el);
    expect(el.scrollTop).toBe(0);
  });

  it('does not throw when the container ref is null (not yet mounted)', () => {
    expect(() => scrollCoordinatorIntoView(true, null)).not.toThrow();
  });

  it('does not throw when the container ref is undefined', () => {
    expect(() => scrollCoordinatorIntoView(true, undefined)).not.toThrow();
  });

  it('scrolls to the exact scrollHeight value, not a fixed offset', () => {
    const el = fakeContainer(1234);
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(1234);
  });

  it('is idempotent — calling again when already scrolled to bottom is harmless', () => {
    const el = fakeContainer(800);
    el.scrollTop = 800;
    scrollCoordinatorIntoView(true, el);
    expect(el.scrollTop).toBe(800);
  });
});
