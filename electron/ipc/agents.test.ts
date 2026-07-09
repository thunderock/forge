import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS, getSkipPermissionsArgs } from './agents.js';

describe('getSkipPermissionsArgs', () => {
  it('returns a copy of default skip-permission args', () => {
    const first = getSkipPermissionsArgs('claude');
    first.push('--mutated');

    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('DEFAULT_AGENTS (AGT-01)', () => {
  it('contains exactly the built-in ids claude-code, codex, opencode', () => {
    expect(DEFAULT_AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('no longer offers the removed built-ins gemini, copilot, antigravity', () => {
    const ids = DEFAULT_AGENTS.map((a) => a.id);
    expect(ids).not.toContain('gemini');
    expect(ids).not.toContain('copilot');
    expect(ids).not.toContain('antigravity');
  });
});
