import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTerminalSearchDecorations, getTerminalTheme, theme } from './theme';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme tokens', () => {
  it('exposes semantic diff and search colors', () => {
    expect(theme).toMatchObject({
      diffAddBg: 'var(--diff-add-bg)',
      diffRemoveBg: 'var(--diff-remove-bg)',
      searchMatch: 'var(--search-match)',
      searchMatchActive: 'var(--search-match-active)',
    });
  });
});

describe('getTerminalTheme', () => {
  it('derives a built-in terminal background from the preset task panel token', () => {
    const root = { dataset: { look: 'classic', customTheme: 'custom-id' } };
    vi.stubGlobal('document', {
      documentElement: root,
      getElementById: () => null,
    });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--task-panel-bg' && root.dataset.look === 'islands-light' ? '#fefefe' : '',
    }));

    expect(getTerminalTheme('islands-light').background).toBe('#fefefe');
    expect(root.dataset).toEqual({ look: 'classic', customTheme: 'custom-id' });
  });
});

describe('getTerminalSearchDecorations', () => {
  it('resolves the active preset search tokens for xterm', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) =>
        name === '--search-match' ? '#112233' : name === '--search-match-active' ? '#445566' : '',
    }));

    expect(getTerminalSearchDecorations()).toEqual({
      matchBackground: 'rgba(17, 34, 51, 0.4)',
      matchOverviewRuler: '#112233',
      activeMatchBackground: 'rgba(68, 85, 102, 0.85)',
      activeMatchColorOverviewRuler: '#445566',
    });
  });

  it('falls back to readable search colors when custom token values are invalid', () => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => 'not-a-color',
    }));

    expect(getTerminalSearchDecorations()).toEqual({
      matchBackground: 'rgba(255, 213, 79, 0.4)',
      matchOverviewRuler: '#ffd54f',
      activeMatchBackground: 'rgba(255, 138, 0, 0.85)',
      activeMatchColorOverviewRuler: '#ff8a00',
    });
  });
});
