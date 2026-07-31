import { describe, expect, it } from 'vitest';
import { resolveBindings, resolveOneBinding, findConflict } from '../resolve';
import { DEFAULT_BINDINGS } from '../defaults';

function defaultBinding(id: string) {
  const binding = DEFAULT_BINDINGS.find((b) => b.id === id);
  if (!binding) throw new Error(`Missing default binding: ${id}`);
  return binding;
}

describe('resolveBindings', () => {
  it('returns defaults unchanged when no preset or user overrides', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const navLeft = resolved.find((b) => b.id === 'app.nav.column-left');
    expect(navLeft?.key).toBe('ArrowLeft');
    expect(navLeft?.modifiers.alt).toBe(true);
  });

  it('applies preset overrides on top of defaults', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'claude-code',
      userOverrides: {},
    });
    // Claude Code preset unbinds Option+Left for column nav
    const navLeft = resolved.find((b) => b.id === 'app.nav.column-left');
    expect(navLeft).toBeUndefined(); // null override removes the binding
  });

  it('applies user overrides on top of preset', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'claude-code',
      userOverrides: {
        'app.toggle-sidebar': { key: 'b', modifiers: { cmdOrCtrl: true, shift: true } },
      },
    });
    const sidebar = resolved.find((b) => b.id === 'app.toggle-sidebar');
    expect(sidebar?.modifiers.shift).toBe(true);
  });

  it('user override of null unbinds the key', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'default',
      userOverrides: { 'app.toggle-sidebar': null },
    });
    const sidebar = resolved.find((b) => b.id === 'app.toggle-sidebar');
    expect(sidebar).toBeUndefined();
  });

  it('unknown preset falls back to default', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, {
      preset: 'nonexistent',
      userOverrides: {},
    });
    // Should have same count as defaults filtered to current platform
    expect(resolved.length).toBeGreaterThan(0);
  });
});

describe('resolveOneBinding', () => {
  it('applies user overrides for one binding', () => {
    const binding = defaultBinding('app.toggle-sidebar');

    const resolved = resolveOneBinding(binding, {
      preset: 'default',
      userOverrides: {
        'app.toggle-sidebar': { key: 'B', modifiers: { cmdOrCtrl: true, shift: true } },
      },
    });

    expect(resolved?.key).toBe('B');
    expect(resolved?.modifiers).toEqual({ cmdOrCtrl: true, shift: true });
  });

  it('returns null for an unbound binding', () => {
    const binding = defaultBinding('app.toggle-sidebar');

    expect(
      resolveOneBinding(binding, {
        preset: 'default',
        userOverrides: { 'app.toggle-sidebar': null },
      }),
    ).toBeNull();
  });
});

describe('findConflict', () => {
  it('detects conflict when two bindings share the same key+modifiers', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    // Try to assign Cmd+B (toggle-sidebar's binding) to new-task
    const conflict = findConflict(resolved, 'app.new-task', {
      key: 'b',
      modifiers: { cmdOrCtrl: true },
    });
    expect(conflict?.id).toBe('app.toggle-sidebar');
  });

  it('returns null when no conflict exists', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const conflict = findConflict(resolved, 'app.new-task', {
      key: 'F12',
      modifiers: {},
    });
    expect(conflict).toBeNull();
  });

  it('ignores the binding being edited (no self-conflict)', () => {
    const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });
    const conflict = findConflict(resolved, 'app.toggle-sidebar', {
      key: 'b',
      modifiers: { cmdOrCtrl: true },
    });
    expect(conflict).toBeNull();
  });
});

// Regression guard for the task-reorder shortcut change: the old global
// Cmd/Ctrl+Shift+Arrow binding shadowed "extend selection by word" in
// terminals/inputs. The fix is a per-platform split. The test env has no
// `navigator` → isMac=false → this exercises the Linux (Alt+Shift) path,
// which is exactly where the original word-select conflict lived.
describe('task-reorder shortcut does not shadow text selection', () => {
  const resolved = resolveBindings(DEFAULT_BINDINGS, { preset: 'default', userOverrides: {} });

  it('resolves the Linux Alt+Shift+Arrow variant, filtering out the mac-only one', () => {
    const linuxLeft = resolved.find((b) => b.id === 'app.task.reorder-left-linux');
    expect(linuxLeft?.key).toBe('ArrowLeft');
    expect(linuxLeft?.modifiers).toEqual({ alt: true, shift: true });
    expect(resolved.find((b) => b.id === 'app.task.reorder-left')).toBeUndefined();
  });

  it('Alt+Shift+Arrow reorder is disjoint from Alt+Arrow pane-focus nav', () => {
    // The core correctness claim: adding Shift keeps reorder distinct from
    // column nav, so Ctrl+Shift+Arrow word-select is freed without a new clash.
    expect(
      findConflict(resolved, 'app.task.reorder-left-linux', {
        key: 'ArrowLeft',
        modifiers: { alt: true, shift: true },
      }),
    ).toBeNull();
    // Inverse direction: plain Alt+Arrow still belongs to column nav alone.
    expect(
      findConflict(resolved, 'app.nav.column-left', {
        key: 'ArrowLeft',
        modifiers: { alt: true },
      }),
    ).toBeNull();
  });
});
