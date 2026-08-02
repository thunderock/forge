import { createRoot, createSignal } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockHighlightLines, mockSanitize } = vi.hoisted(() => ({
  mockHighlightLines: vi.fn<(code: string, language: string) => Promise<string[]>>(),
  mockSanitize: vi.fn<(html: string) => string>(),
}));

vi.mock('solid-js', async () =>
  vi.importActual<typeof import('solid-js')>('solid-js/dist/solid.js'),
);

vi.mock('dompurify', () => ({
  default: { sanitize: mockSanitize },
}));

import { createHighlightedMarkdownState, renderMarkdownWithHighlighting } from './marked-shiki';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stripExecutableMarkup(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/\s+on\w+=(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\b(href|src)=(['"])\s*javascript:[\s\S]*?\2/gi, '$1=$2#$2');
}

function createPreviewHarness(
  initialSource: string | undefined,
  renderer: (markdown: string) => Promise<string> = async (markdown) => markdown,
) {
  return createRoot((dispose) => {
    const [source, setSource] = createSignal<string | undefined>(initialSource);
    return {
      dispose,
      setSource,
      state: createHighlightedMarkdownState(source, renderer),
    };
  });
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSanitize.mockImplementation(stripExecutableMarkup);
});

describe('RED: markdown preview contract', () => {
  it('starts no renderer for hidden or empty preview sources', async () => {
    const renderer = vi.fn<(markdown: string) => Promise<string>>();
    const preview = createPreviewHarness(undefined, renderer);
    await flushEffects();

    expect(preview.state.html()).toBe('');
    expect(preview.state.loading()).toBe(false);
    expect(renderer).not.toHaveBeenCalled();

    preview.setSource('');
    await flushEffects();
    expect(renderer).not.toHaveBeenCalled();
    preview.dispose();
  });

  it('reports rendering until the current non-empty preview commits', async () => {
    const rendering = deferred<string[]>();
    const renderer = vi.fn(() => rendering.promise.then((lines) => lines.join('\n')));
    const preview = createPreviewHarness('current', renderer);
    await flushEffects();

    expect(renderer).toHaveBeenCalledTimes(1);
    expect(preview.state.loading()).toBe(true);
    expect(preview.state.html()).toBe('');

    rendering.resolve(['<span>const current = true;</span>']);
    await flushEffects();
    expect(preview.state.loading()).toBe(false);
    expect(preview.state.html()).toContain('const current = true;');
    preview.dispose();
  });

  it('prevents hidden and older generations from repainting or clearing current loading', async () => {
    const older = deferred<string[]>();
    const current = deferred<string[]>();
    const renderer = vi
      .fn<(markdown: string) => Promise<string>>()
      .mockImplementationOnce(() => older.promise.then((lines) => lines.join('\n')))
      .mockImplementationOnce(() => current.promise.then((lines) => lines.join('\n')));
    const preview = createPreviewHarness('older', renderer);
    await flushEffects();

    preview.setSource(undefined);
    await flushEffects();
    expect(preview.state.html()).toBe('');
    expect(preview.state.loading()).toBe(false);

    preview.setSource('current');
    await flushEffects();
    expect(preview.state.loading()).toBe(true);

    older.resolve(['<span>const generation = "older";</span>']);
    await flushEffects();
    expect(preview.state.html()).toBe('');
    expect(preview.state.loading()).toBe(true);

    current.resolve(['<span>const generation = "current";</span>']);
    await flushEffects();
    expect(preview.state.html()).toContain('generation = "current"');
    expect(preview.state.html()).not.toContain('generation = "older"');
    expect(preview.state.loading()).toBe(false);
    preview.dispose();
  });

  it('sanitizes highlighted HTML before exposing it', async () => {
    mockHighlightLines.mockResolvedValueOnce([
      '<img src="javascript:alert(1)" onerror="alert(2)"><script>alert(3)</script>',
    ]);

    const html = await renderMarkdownWithHighlighting('```html\nunsafe\n```', mockHighlightLines);

    expect(mockSanitize).toHaveBeenCalledTimes(1);
    expect(html).not.toMatch(/<script|onerror|javascript:/i);
  });

  it('sanitizes fallback HTML and clears loading only for its generation', async () => {
    const renderer = vi
      .fn<(markdown: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('highlight failed'));
    const preview = createPreviewHarness(
      '<a href="javascript:alert(1)" onclick="alert(2)">unsafe</a>\n\n```ts\nfail\n```',
      renderer,
    );
    await flushEffects();

    expect(mockSanitize).toHaveBeenCalledTimes(1);
    expect(preview.state.html()).not.toMatch(/onclick|javascript:/i);
    expect(preview.state.loading()).toBe(false);
    preview.dispose();
  });

  it('treats Mermaid as inert code instead of a second rendering system', async () => {
    mockHighlightLines.mockResolvedValueOnce(['graph TD; A--&gt;B']);

    const html = await renderMarkdownWithHighlighting(
      '```mermaid\ngraph TD; A-->B\n```',
      mockHighlightLines,
    );

    expect(mockHighlightLines).toHaveBeenCalledWith('graph TD; A-->B', 'mermaid');
    expect(html).not.toContain('mermaid-block');
    expect(html).toContain('shiki-block');
  });
});
