import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { _resetForTests, isTopmost, popDialog, pushDialog, topDialog } from './dialog-stack';

afterEach(() => {
  _resetForTests();
});

describe('dialog-stack', () => {
  it('topmost is the most-recently-pushed id', () => {
    pushDialog('a');
    expect(topDialog()).toBe('a');
    expect(isTopmost('a')).toBe(true);

    pushDialog('b');
    expect(topDialog()).toBe('b');
    expect(isTopmost('a')).toBe(false);
    expect(isTopmost('b')).toBe(true);
  });

  it('popping the topmost restores the previous as topmost', () => {
    pushDialog('a');
    pushDialog('b');
    pushDialog('c');
    expect(topDialog()).toBe('c');
    popDialog('c');
    expect(topDialog()).toBe('b');
    popDialog('b');
    expect(topDialog()).toBe('a');
  });

  it('popping a non-topmost id leaves the topmost as topmost', () => {
    pushDialog('a');
    pushDialog('b');
    pushDialog('c');
    popDialog('b'); // remove the middle
    expect(topDialog()).toBe('c');
    expect(isTopmost('a')).toBe(false);
    expect(isTopmost('b')).toBe(false);
    expect(isTopmost('c')).toBe(true);
  });

  it('pushing the same id twice does not double it', () => {
    pushDialog('a');
    pushDialog('a');
    expect(topDialog()).toBe('a');
    popDialog('a');
    expect(topDialog()).toBe(null);
  });

  it('isTopmost on an unknown id returns false', () => {
    expect(isTopmost('absent')).toBe(false);
    pushDialog('a');
    expect(isTopmost('absent')).toBe(false);
  });

  it('topDialog is null when empty', () => {
    expect(topDialog()).toBe(null);
  });
});

describe('RED: topmost dialog contract', () => {
  it('names the catalog, editor, and confirmation stack and resumes the parent after each pop', () => {
    const catalogId = 'personality-catalog';
    const editorId = 'personality-editor';
    const confirmationId = 'reset-confirmation';

    pushDialog(catalogId);
    pushDialog(editorId);
    pushDialog(confirmationId);

    expect(isTopmost(catalogId)).toBe(false);
    expect(isTopmost(editorId)).toBe(false);
    expect(isTopmost(confirmationId)).toBe(true);

    popDialog(confirmationId);
    expect(isTopmost(editorId)).toBe(true);
    popDialog(editorId);
    expect(isTopmost(catalogId)).toBe(true);
  });

  it('uses one topmost predicate for focus, Escape, overlay close, and aria-modal', () => {
    const source = readFileSync(new URL('../components/Dialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('const isActive = () => props.open && isTopmost(dialogId);');
    expect(source.match(/isTopmost\(dialogId\)/g)).toHaveLength(1);
    expect(source).toMatch(
      /createFocusTrap\([\s\S]*?\(\) => panelRef,[\s\S]*?isActive,[\s\S]*?\);/,
    );
    expect(source).toMatch(/if \(!isActive\(\)\) return;[\s\S]*?props\.onClose\(\);/);
    expect(source).toContain('e.target === e.currentTarget && isActive()');
    expect(source).toContain("aria-modal={isActive() ? 'true' : undefined}");
  });

  it('returns inactive focus traps before preventing Tab or moving focus', () => {
    const source = readFileSync(new URL('./focus-trap.ts', import.meta.url), 'utf8');
    const inactiveGuard = source.indexOf('if (!active()) return;');
    const preventDefault = source.indexOf('e.preventDefault();');
    const focusMove = source.indexOf('next.focus();');

    expect(source).toContain('active: () => boolean = open');
    expect(inactiveGuard).toBeGreaterThan(-1);
    expect(inactiveGuard).toBeLessThan(preventDefault);
    expect(inactiveGuard).toBeLessThan(focusMove);
  });

  it('keeps one focus listener with cleanup and one invoker restore per dialog', () => {
    const dialogSource = readFileSync(new URL('../components/Dialog.tsx', import.meta.url), 'utf8');
    const trapSource = readFileSync(new URL('./focus-trap.ts', import.meta.url), 'utf8');

    expect(dialogSource.match(/createFocusRestore\(/g)).toHaveLength(1);
    expect(dialogSource.match(/createFocusTrap\(/g)).toHaveLength(1);
    expect(trapSource.match(/document\.addEventListener\('keydown', handler\)/g)).toHaveLength(1);
    expect(trapSource.match(/document\.removeEventListener\('keydown', handler\)/g)).toHaveLength(
      1,
    );
  });

  it('exposes reset confirmation layering, alert, autofocus, and cancellation locks', () => {
    const source = readFileSync(
      new URL('../components/ConfirmDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(source).toContain('zIndex?: number;');
    expect(source).toContain('error?: string | JSX.Element;');
    expect(source).toContain('cancelDisabled?: boolean;');
    expect(source).toContain('const actionsDisabled = () =>');
    expect(source).toContain('props.confirmLoading || props.cancelDisabled');
    expect(source).toMatch(
      /function cancel\(\): void \{[\s\S]*?if \(actionsDisabled\(\)\) return;[\s\S]*?props\.onCancel\(\);[\s\S]*?\}/,
    );
    expect(source).toContain('onClose={cancel}');
    expect(source).toContain('zIndex={props.zIndex}');
    expect(source).toMatch(/<Show when=\{props\.error\}>[\s\S]*?role="alert"/);
    expect(source).toContain('const focusCancelBtn = props.autoFocusCancel ?? true;');
    expect(source).toContain('disabled={actionsDisabled()}');
    expect(source).toContain('disabled={props.confirmDisabled || actionsDisabled()}');
  });
});
