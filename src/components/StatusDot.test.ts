import { renderToString } from 'solid-js/web';
import { describe, expect, it } from 'vitest';

import { StatusDot, getDotTooltip } from './StatusDot';

describe('getDotTooltip', () => {
  it('describes review status', () => {
    expect(getDotTooltip('review')).toBe('Ready for review');
  });

  it('describes busy status', () => {
    expect(getDotTooltip('busy')).toBe('Busy — agent recently active');
  });

  it('uses attention state before dot status', () => {
    expect(getDotTooltip('ready', 'needs_input')).toBe('Waiting for input');
  });
});

describe('StatusDot', () => {
  it('attaches the tooltip to the dot element', () => {
    const html = renderToString(() => StatusDot({ status: 'review' }));

    expect(html).toContain('title="Ready for review"');
  });

  it('uses attention state for the rendered tooltip', () => {
    const html = renderToString(() => StatusDot({ status: 'ready', attention: 'needs_input' }));

    expect(html).toContain('title="Waiting for input"');
  });
});
