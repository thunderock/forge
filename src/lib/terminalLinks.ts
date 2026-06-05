export interface TerminalLinkMouseEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault: () => void;
}

export interface TerminalLinkHandlerOptions {
  isMac: boolean;
  openExternal: (url: string) => Promise<void> | void;
  onOpenError?: () => void;
  requireModifier?: boolean;
}

export function normalizeHttpUrl(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function createTerminalHttpLinkHandler(options: TerminalLinkHandlerOptions) {
  return (event: TerminalLinkMouseEvent, uri: string): void => {
    if (options.requireModifier && !(options.isMac ? event.metaKey : event.ctrlKey)) return;

    event.preventDefault();
    const url = normalizeHttpUrl(uri);
    if (!url) return;

    try {
      Promise.resolve(options.openExternal(url)).catch(() => options.onOpenError?.());
    } catch {
      options.onOpenError?.();
    }
  };
}
