import { describe, it, expect } from 'vitest';
import { DEFAULT_BINDINGS } from '../defaults';
import { modifiersMatch } from '../match';

const APP_LAYER_IDS = [
  'app.nav.row-up',
  'app.nav.row-down',
  'app.nav.column-left',
  'app.nav.column-right',
  'app.task.reorder-left',
  'app.task.reorder-right',
  'app.task.reorder-left-linux',
  'app.task.reorder-right-linux',
  'app.task.close-shell',
  'app.task.close',
  'app.task.merge',
  'app.task.push',
  'app.task.new-shell',
  'app.task.send-prompt',
  'app.new-terminal',
  'app.new-task',
  'app.new-task-alt',
  'app.broadcast',
  'app.toggle-sidebar',
  'app.toggle-focus-mode',
  'app.toggle-help',
  'app.toggle-help-f1',
  'app.toggle-settings',
  'app.personality-library',
  'app.close-dialogs',
  'app.reset-zoom',
  ...Array.from({ length: 9 }, (_, i) => `app.nav.jump-to-task-${i + 1}`),
];

const TERMINAL_LAYER_IDS = [
  'term.copy',
  'term.copy-linux',
  'term.paste',
  'term.paste-linux',
  'term.find',
  'term.shift-enter',
  'term.home',
  'term.end',
  'term.kill-line',
  'term.scroll-line-up',
  'term.scroll-line-down',
  'term.scroll-page-up',
  'term.scroll-page-down',
];

describe('DEFAULT_BINDINGS', () => {
  it('contains all expected app-layer shortcuts', () => {
    const ids = new Set(DEFAULT_BINDINGS.map((b) => b.id));
    for (const id of APP_LAYER_IDS) {
      expect(ids.has(id), `Missing app-layer binding: ${id}`).toBe(true);
    }
  });

  it('contains all expected terminal-layer shortcuts', () => {
    const ids = new Set(DEFAULT_BINDINGS.map((b) => b.id));
    for (const id of TERMINAL_LAYER_IDS) {
      expect(ids.has(id), `Missing terminal-layer binding: ${id}`).toBe(true);
    }
  });

  it('has no duplicate IDs', () => {
    const ids = DEFAULT_BINDINGS.map((b) => b.id);
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('every app-layer binding has an action', () => {
    const appBindings = DEFAULT_BINDINGS.filter((b) => b.layer === 'app');
    for (const binding of appBindings) {
      expect(binding.action, `App-layer binding "${binding.id}" is missing an action`).toBeTruthy();
    }
  });

  it('every terminal-layer binding has an action or escapeSequence', () => {
    const terminalBindings = DEFAULT_BINDINGS.filter((b) => b.layer === 'terminal');
    for (const binding of terminalBindings) {
      const hasActionOrSequence =
        (binding.action !== undefined && binding.action !== '') ||
        (binding.escapeSequence !== undefined && binding.escapeSequence !== '');
      expect(
        hasActionOrSequence,
        `Terminal-layer binding "${binding.id}" has neither action nor escapeSequence`,
      ).toBe(true);
    }
  });

  it('platform:both bindings do not use meta without cmdOrCtrl', () => {
    const bothBindings = DEFAULT_BINDINGS.filter((b) => b.platform === 'both');
    for (const b of bothBindings) {
      if (b.modifiers.meta) {
        expect(
          b.modifiers.cmdOrCtrl,
          `${b.id} uses meta on platform:both — should use cmdOrCtrl`,
        ).toBe(true);
      }
    }
  });

  it('defines one exact, conflict-free Personality Library shortcut on macOS and Linux', () => {
    const matches = DEFAULT_BINDINGS.filter((binding) => binding.id === 'app.personality-library');

    expect(matches).toEqual([
      {
        id: 'app.personality-library',
        layer: 'app',
        category: 'App',
        description: 'Toggle Personality Library',
        platform: 'both',
        key: 'Y',
        modifiers: { cmdOrCtrl: true, shift: true },
        action: 'togglePersonalityLibrary',
        global: true,
        dialogSafe: true,
      },
    ]);

    const personalityBinding = matches[0];
    for (const isMac of [true, false]) {
      const conflicts = DEFAULT_BINDINGS.filter((binding) => {
        const platformMatches =
          binding.platform === 'both' ||
          (isMac && binding.platform === 'mac') ||
          (!isMac && binding.platform === 'linux');
        return (
          binding.id !== personalityBinding.id &&
          platformMatches &&
          binding.key.toLowerCase() === personalityBinding.key.toLowerCase() &&
          modifiersMatch(binding.modifiers, personalityBinding.modifiers, isMac)
        );
      });

      expect(
        conflicts,
        `Personality Library default conflicts on ${isMac ? 'macOS' : 'Linux'}`,
      ).toEqual([]);
    }
  });
});

// Locks the per-platform task-reorder modifiers so a future edit can't
// silently regress to a combo that shadows native text selection
// (Cmd+Shift = select-to-line, Opt+Shift / Ctrl+Shift = select-by-word).
describe('task-reorder split avoids native text-selection shadowing', () => {
  const byId = (id: string) => {
    const binding = DEFAULT_BINDINGS.find((b) => b.id === id);
    if (!binding) throw new Error(`expected binding not found: ${id}`);
    return binding;
  };

  it('macOS variant uses Ctrl+Shift (not Cmd+Shift / Opt+Shift)', () => {
    for (const id of ['app.task.reorder-left', 'app.task.reorder-right']) {
      const b = byId(id);
      expect(b.platform).toBe('mac');
      // Exactly Ctrl+Shift — NOT cmdOrCtrl (Cmd+Shift = select-to-line) nor
      // alt (Opt+Shift = select-by-word); toEqual is exhaustive so this also
      // proves those modifiers are absent.
      expect(b.modifiers).toEqual({ ctrl: true, shift: true });
    }
  });

  it('Linux variant uses Alt+Shift (not Ctrl+Shift)', () => {
    for (const id of ['app.task.reorder-left-linux', 'app.task.reorder-right-linux']) {
      const b = byId(id);
      expect(b.platform).toBe('linux');
      expect(b.modifiers).toEqual({ alt: true, shift: true });
    }
  });
});
