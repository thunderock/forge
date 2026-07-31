import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_BINDINGS } from './keybindings/defaults';
import {
  initShortcuts,
  registerFromRegistry,
  registerJumpToTaskShortcuts,
  registerZoomShortcuts,
} from './shortcuts';

type KeyboardEventStub = Pick<
  KeyboardEvent,
  | 'altKey'
  | 'ctrlKey'
  | 'key'
  | 'metaKey'
  | 'preventDefault'
  | 'shiftKey'
  | 'stopPropagation'
  | 'target'
>;

describe('registerFromRegistry — jump-to-task bindings', () => {
  let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        if (type === 'keydown' && typeof handler === 'function') {
          keydownHandler = handler as (event: KeyboardEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    keydownHandler = undefined;
    vi.unstubAllGlobals();
  });

  it('fires jumpToTask:1 handler on Ctrl+1 (key="1") on non-Mac platforms', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: '1',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).toHaveBeenCalledTimes(1);

    cleanupShortcuts();
    cleanupRegistry();
  });

  it('fires jumpToTask handler on Ctrl+Shift+1 via registerJumpToTaskShortcuts (AZERTY)', () => {
    const handler = vi.fn();
    const cleanupJump = registerJumpToTaskShortcuts(handler);
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: '1',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(0);

    cleanupShortcuts();
    cleanupJump();
  });

  it('does NOT fire cmdOrCtrl bindings for Meta on non-Mac platforms', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: KeyboardEventStub = {
      key: '1',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).not.toHaveBeenCalled();

    cleanupShortcuts();
    cleanupRegistry();
  });

  it('does NOT fire when key is "Digit1" (old broken binding format)', () => {
    const handler = vi.fn();
    const cleanupRegistry = registerFromRegistry(DEFAULT_BINDINGS, { 'jumpToTask:1': handler });
    const cleanupShortcuts = initShortcuts();

    const event: Pick<
      KeyboardEvent,
      | 'key'
      | 'ctrlKey'
      | 'metaKey'
      | 'altKey'
      | 'shiftKey'
      | 'target'
      | 'preventDefault'
      | 'stopPropagation'
    > = {
      key: 'Digit1',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(handler).not.toHaveBeenCalled();

    cleanupShortcuts();
    cleanupRegistry();
  });
});

describe('registerZoomShortcuts', () => {
  let keydownHandler: ((event: KeyboardEvent) => void) | undefined;

  beforeEach(() => {
    vi.stubGlobal('document', { querySelector: () => null });
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListenerOrEventListenerObject) => {
        if (type === 'keydown' && typeof handler === 'function') {
          keydownHandler = handler as (event: KeyboardEvent) => void;
        }
      },
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    keydownHandler = undefined;
    vi.unstubAllGlobals();
  });

  it('resets zoom for shifted Ctrl+0 layouts', () => {
    const resetZoom = vi.fn();
    const cleanupZoomShortcuts = registerZoomShortcuts({
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      resetZoom,
    });
    const cleanupShortcuts = initShortcuts();

    const event: KeyboardEventStub = {
      key: '0',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      target: null,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };

    keydownHandler?.(event as KeyboardEvent);

    expect(resetZoom).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);

    cleanupShortcuts();
    cleanupZoomShortcuts();
  });
});
