import { describe, expect, it } from 'vitest';

import { formatKeyCombo } from '../format';

describe('formatKeyCombo', () => {
  it('keeps additive Ctrl visible when cmdOrCtrl maps to Cmd on macOS', () => {
    expect(formatKeyCombo({ key: 'k', modifiers: { cmdOrCtrl: true, ctrl: true } }, true)).toBe(
      'Cmd + Ctrl + K',
    );
  });

  it('keeps additive Meta visible when cmdOrCtrl maps to Ctrl on Linux', () => {
    expect(formatKeyCombo({ key: 'k', modifiers: { cmdOrCtrl: true, meta: true } }, false)).toBe(
      'Ctrl + Super + K',
    );
  });

  it('does not duplicate platform-equivalent modifiers', () => {
    expect(formatKeyCombo({ key: 'k', modifiers: { cmdOrCtrl: true, meta: true } }, true)).toBe(
      'Cmd + K',
    );
    expect(formatKeyCombo({ key: 'k', modifiers: { cmdOrCtrl: true, ctrl: true } }, false)).toBe(
      'Ctrl + K',
    );
  });
});
