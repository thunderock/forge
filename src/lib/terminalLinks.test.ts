import { describe, expect, it, vi } from 'vitest';
import { createTerminalHttpLinkHandler, normalizeHttpUrl } from './terminalLinks';

function event(overrides: Partial<MouseEvent> = {}) {
  return {
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  };
}

describe('normalizeHttpUrl', () => {
  it('accepts and normalizes web URLs', () => {
    expect(normalizeHttpUrl('HTTPS://EXAMPLE.COM/pr/1')).toBe('https://example.com/pr/1');
  });

  it('rejects invalid and non-web URLs', () => {
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeHttpUrl('not a url')).toBeNull();
  });
});

describe('createTerminalHttpLinkHandler', () => {
  it('does nothing for unmodified desktop clicks when a modifier is required', () => {
    const openExternal = vi.fn();
    const e = event();
    const handler = createTerminalHttpLinkHandler({
      isMac: false,
      requireModifier: true,
      openExternal,
    });

    handler(e, 'https://example.com/');

    expect(openExternal).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('opens with Ctrl on non-mac platforms', () => {
    const openExternal = vi.fn();
    const e = event({ ctrlKey: true });
    const handler = createTerminalHttpLinkHandler({
      isMac: false,
      requireModifier: true,
      openExternal,
    });

    handler(e, 'HTTPS://EXAMPLE.COM/pr/1');

    expect(openExternal).toHaveBeenCalledWith('https://example.com/pr/1');
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(e.stopPropagation).not.toHaveBeenCalled();
  });

  it('opens with Cmd on macOS', () => {
    const openExternal = vi.fn();
    const e = event({ metaKey: true });
    const handler = createTerminalHttpLinkHandler({
      isMac: true,
      requireModifier: true,
      openExternal,
    });

    handler(e, 'https://example.com/');

    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
  });

  it('blocks invalid URLs after taking over the click', () => {
    const openExternal = vi.fn();
    const e = event({ ctrlKey: true });
    const handler = createTerminalHttpLinkHandler({
      isMac: false,
      requireModifier: true,
      openExternal,
    });

    handler(e, 'javascript:alert(1)');

    expect(openExternal).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('reports opener failures without throwing', async () => {
    const onOpenError = vi.fn();
    const handler = createTerminalHttpLinkHandler({
      isMac: false,
      openExternal: () => Promise.reject(new Error('failed')),
      onOpenError,
    });

    handler(event(), 'https://example.com/');
    await Promise.resolve();

    expect(onOpenError).toHaveBeenCalledTimes(1);
  });
});
