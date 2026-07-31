import type { KeyBinding } from './types';
import type { Modifiers } from './types';

// Safe platform detection — navigator may not exist in test/SSR environments
export const isMacPlatform: boolean =
  typeof navigator !== 'undefined' ? navigator.userAgent.includes('Mac') : false;

export interface NormalizedModifiers {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export function normalizeModifiers(
  modifiers: Modifiers,
  isMac: boolean = isMacPlatform,
): NormalizedModifiers {
  return {
    ctrl: !!modifiers.ctrl || (!isMac && !!modifiers.cmdOrCtrl),
    meta: !!modifiers.meta || (isMac && !!modifiers.cmdOrCtrl),
    alt: !!modifiers.alt,
    shift: !!modifiers.shift,
  };
}

export function modifiersMatch(
  a: Modifiers,
  b: Modifiers,
  isMac: boolean = isMacPlatform,
): boolean {
  const normalizedA = normalizeModifiers(a, isMac);
  const normalizedB = normalizeModifiers(b, isMac);
  return (
    normalizedA.ctrl === normalizedB.ctrl &&
    normalizedA.meta === normalizedB.meta &&
    normalizedA.alt === normalizedB.alt &&
    normalizedA.shift === normalizedB.shift
  );
}

/**
 * Check whether a KeyboardEvent matches a KeyBinding's key + modifiers.
 * Handles cmdOrCtrl → Cmd on macOS / Ctrl on Linux, and raw meta/ctrl.
 * Shared by both app-layer (shortcuts.ts) and terminal-layer (TerminalView).
 */
export function matchesKeyEvent(e: KeyboardEvent, binding: KeyBinding): boolean {
  if (e.key.toLowerCase() !== binding.key.toLowerCase()) return false;
  const expected = normalizeModifiers(binding.modifiers);

  if (e.metaKey !== expected.meta) return false;
  if (e.ctrlKey !== expected.ctrl) return false;
  if (e.altKey !== expected.alt) return false;
  if (e.shiftKey !== expected.shift) return false;
  return true;
}
