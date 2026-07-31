import { isMacPlatform } from './match';
import type { KeyBinding, Modifiers } from './types';

function formatKeyName(key: string): string {
  if (key === 'ArrowLeft') return '\u2190';
  if (key === 'ArrowRight') return '\u2192';
  if (key === 'ArrowUp') return '\u2191';
  if (key === 'ArrowDown') return '\u2193';
  if (key === 'Backspace') return '\u232B';
  if (key === 'Enter') return '\u21B5';
  if (key === 'Escape') return 'Esc';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function formatModifiers(modifiers: Modifiers, isMac: boolean = isMacPlatform): string[] {
  const parts: string[] = [];
  if (modifiers.cmdOrCtrl) parts.push(isMac ? 'Cmd' : 'Ctrl');
  if (modifiers.ctrl && (isMac || !modifiers.cmdOrCtrl)) parts.push('Ctrl');
  if (modifiers.meta && (!isMac || !modifiers.cmdOrCtrl)) {
    parts.push(isMac ? 'Cmd' : 'Super');
  }
  if (modifiers.alt) parts.push(isMac ? 'Opt' : 'Alt');
  if (modifiers.shift) parts.push('Shift');
  return parts;
}

export function formatKeyCombo(
  binding: Pick<KeyBinding, 'key' | 'modifiers'>,
  isMac: boolean = isMacPlatform,
): string {
  return [...formatModifiers(binding.modifiers, isMac), formatKeyName(binding.key)].join(' + ');
}
