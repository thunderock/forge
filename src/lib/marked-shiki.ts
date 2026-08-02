import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import { createEffect, createSignal } from 'solid-js';
import { highlightLines } from './shiki-highlighter';

/**
 * Render markdown to HTML with Shiki syntax highlighting for fenced code blocks.
 *
 * Two-pass approach:
 *  1. Walk tokens to collect code blocks, highlight them in parallel via Shiki.
 *  2. Render markdown, substituting highlighted HTML for each code block.
 */
type MarkdownHighlighter = (code: string, language: string) => Promise<string[]>;

export async function renderMarkdownWithHighlighting(
  markdown: string,
  highlighter: MarkdownHighlighter = highlightLines,
): Promise<string> {
  const marked = new Marked();

  // First pass — collect code blocks
  const codeBlocks: { lang: string; text: string }[] = [];
  const tokens = marked.lexer(markdown);
  collectCodeTokens(tokens, codeBlocks);

  // Highlight all blocks in parallel
  const highlighted = await Promise.all(
    codeBlocks.map(({ text, lang }) => highlighter(text, lang || 'plaintext')),
  );

  // Second pass — render with a custom renderer that swaps in highlighted HTML
  let blockIndex = 0;
  const renderer = {
    code(token: Tokens.Code): string {
      const idx = blockIndex++;
      const lines = idx < highlighted.length ? highlighted[idx] : null;
      const langAttr = token.lang ? ` data-lang="${escapeAttr(token.lang)}"` : '';
      if (lines) {
        return `<pre class="shiki-block"${langAttr}><code>${lines.join('\n')}</code></pre>`;
      }
      // Fallback for unmatched blocks
      return `<pre class="shiki-block"${langAttr}><code>${escapeHtml(token.text ?? '')}</code></pre>`;
    },
  };

  marked.use({ renderer });
  const raw = marked.parser(tokens);
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['data-lang'] });
}

interface TokenLike {
  type: string;
  lang?: string;
  text?: string;
  tokens?: TokenLike[];
  items?: { tokens?: TokenLike[] }[];
}

/** Recursively collect code-fence tokens from a token tree (including list items). */
function collectCodeTokens(
  tokens: readonly TokenLike[],
  out: { lang: string; text: string }[],
): void {
  for (const token of tokens) {
    if (token.type === 'code') {
      out.push({ lang: (token.lang as string) ?? '', text: (token.text as string) ?? '' });
    }
    if (Array.isArray(token.tokens)) {
      collectCodeTokens(token.tokens, out);
    }
    // List tokens store children under .items[].tokens
    if (Array.isArray(token.items)) {
      for (const item of token.items) {
        if (Array.isArray(item.tokens)) {
          collectCodeTokens(item.tokens, out);
        }
      }
    }
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * SolidJS primitive that reactively renders markdown with Shiki syntax highlighting.
 * Returns a signal accessor for the rendered HTML string.
 * Falls back to plain marked rendering on highlighting failure.
 */
export function createHighlightedMarkdown(source: () => string | undefined): () => string {
  return createHighlightedMarkdownState(source).html;
}

export interface HighlightedMarkdownState {
  html: () => string;
  loading: () => boolean;
}

type MarkdownRenderer = (markdown: string) => Promise<string>;

export function createHighlightedMarkdownState(
  source: () => string | undefined,
  renderer: MarkdownRenderer = renderMarkdownWithHighlighting,
): HighlightedMarkdownState {
  const [html, setHtml] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  let generation = 0;

  createEffect(() => {
    const content = source();
    const currentGeneration = ++generation;

    if (!content) {
      setHtml('');
      setLoading(false);
      return;
    }

    setLoading(true);
    renderer(content)
      .then((result) => {
        if (currentGeneration === generation) setHtml(result);
      })
      .catch(() => {
        if (currentGeneration !== generation) return;
        setHtml(
          DOMPurify.sanitize(new Marked().parse(content, { async: false }) as string, {
            ADD_ATTR: ['data-lang'],
          }),
        );
      })
      .finally(() => {
        if (currentGeneration === generation) setLoading(false);
      });
  });

  return { html, loading };
}
