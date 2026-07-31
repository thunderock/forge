import type { KeyBinding, KeybindingConfig, Modifiers } from './types';
import { getPreset } from './presets';
import { isMacPlatform, modifiersMatch } from './match';

function platformMatches(binding: KeyBinding): boolean {
  if (binding.platform === 'both') return true;
  if (binding.platform === 'mac') return isMacPlatform;
  if (binding.platform === 'linux') return !isMacPlatform;
  return true;
}

interface ResolvedBindingState {
  binding: KeyBinding;
  unbound: boolean;
}

function resolveOneBindingState(
  binding: KeyBinding,
  config: KeybindingConfig,
): ResolvedBindingState | null {
  if (!platformMatches(binding)) return null;

  const preset = getPreset(config.preset);
  const userOverride = Object.prototype.hasOwnProperty.call(config.userOverrides, binding.id)
    ? config.userOverrides[binding.id]
    : undefined;

  const presetOverride = Object.prototype.hasOwnProperty.call(preset.overrides, binding.id)
    ? preset.overrides[binding.id]
    : undefined;

  const unbound = userOverride === null || (presetOverride === null && userOverride === undefined);

  if (unbound) {
    return { binding: { ...binding, unbound: true }, unbound: true };
  }

  const key = userOverride?.key ?? presetOverride?.key ?? binding.key;
  const modifiers: Modifiers =
    userOverride?.modifiers ?? presetOverride?.modifiers ?? binding.modifiers;

  return { binding: { ...binding, key, modifiers }, unbound: false };
}

export function resolveOneBinding(
  binding: KeyBinding,
  config: KeybindingConfig,
): KeyBinding | null {
  const resolved = resolveOneBindingState(binding, config);
  if (!resolved || resolved.unbound) return null;
  return resolved.binding;
}

/**
 * Resolves the full list of active keybindings by applying preset overrides
 * and user overrides on top of the provided defaults, filtered by platform.
 *
 * Priority (highest to lowest): userOverrides > preset overrides > defaults
 * A null override removes (unbinds) the binding.
 */
export function resolveBindings(defaults: KeyBinding[], config: KeybindingConfig): KeyBinding[] {
  const resolved: KeyBinding[] = [];

  for (const binding of defaults) {
    const one = resolveOneBinding(binding, config);
    if (one) resolved.push(one);
  }

  return resolved;
}

/**
 * Like resolveBindings, but includes ALL platform-filtered bindings — even those
 * unbound by a preset or user override. Unbound bindings have `unbound: true`.
 * Used by the keybinding editor to show the full picture.
 */
export function resolveAllBindings(defaults: KeyBinding[], config: KeybindingConfig): KeyBinding[] {
  const result: KeyBinding[] = [];

  for (const binding of defaults) {
    const one = resolveOneBindingState(binding, config);
    if (one) result.push(one.binding);
  }

  return result;
}

/**
 * Checks for a keybinding conflict when assigning a proposed key+modifiers
 * to the binding identified by `editingId`.
 *
 * Returns the conflicting binding, or null if no conflict exists.
 * The binding being edited is excluded from the check (no self-conflict).
 */
export function findConflict(
  resolved: KeyBinding[],
  editingId: string,
  proposed: Pick<KeyBinding, 'key' | 'modifiers'>,
): KeyBinding | null {
  for (const binding of resolved) {
    if (binding.id === editingId) continue;
    if (
      binding.key.toLowerCase() === proposed.key.toLowerCase() &&
      modifiersMatch(binding.modifiers, proposed.modifiers)
    ) {
      return binding;
    }
  }
  return null;
}
