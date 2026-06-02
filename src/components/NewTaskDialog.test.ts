import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// scrollCoordinatorIntoView
//
// Pure helper mirroring the logic inside the createEffect that runs when
// coordinator mode is toggled on. Tests verify: scrolls to scrollHeight when
// enabled, no-ops when disabled, no-ops when the container is absent.
// ---------------------------------------------------------------------------

interface FakeScrollContainer {
  scrollTop: number;
  readonly scrollHeight: number;
}

function fakeContainer(scrollHeight: number): FakeScrollContainer {
  return { scrollTop: 0, scrollHeight };
}

/** Mirrors the body of the createEffect handler in NewTaskDialog. */
function scrollCoordinatorIntoView(
  enabled: boolean,
  container: FakeScrollContainer | null | undefined,
): void {
  if (enabled && container) {
    container.scrollTop = container.scrollHeight;
  }
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

// ---------------------------------------------------------------------------
// defer:true semantics
//
// The createEffect uses on(signal, handler, { defer: true }) so the scroll
// does NOT fire on the dialog's initial render — only on user-driven toggles.
// The handler also wraps the scroll in queueMicrotask so the DOM has updated
// before scrollTop is set.
// ---------------------------------------------------------------------------

describe('coordinator scroll effect timing', () => {
  it('scrollTop is unchanged before the microtask drains', async () => {
    const el = fakeContainer(800);

    // Simulate exactly what the effect handler does
    queueMicrotask(() => {
      scrollCoordinatorIntoView(true, el);
    });

    // Synchronously, before the microtask runs, nothing has changed
    expect(el.scrollTop).toBe(0);

    await Promise.resolve(); // drain microtask queue
    expect(el.scrollTop).toBe(800);
  });

  it('does not scroll after microtask when coordinator mode is false', async () => {
    const el = fakeContainer(800);

    queueMicrotask(() => {
      scrollCoordinatorIntoView(false, el);
    });

    await Promise.resolve();
    expect(el.scrollTop).toBe(0);
  });

  it('does not scroll when the container is absent at microtask time', async () => {
    // Simulates the ref not yet assigned (early mount edge case)
    let container: FakeScrollContainer | undefined;

    queueMicrotask(() => {
      scrollCoordinatorIntoView(true, container);
    });

    await Promise.resolve();
    // No error, and container was never mutated
    expect(container).toBeUndefined();
  });
});
