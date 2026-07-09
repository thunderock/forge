import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../ipc/types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  agentSupportsEffort,
  effortsFor,
  curatedModelsFor,
  isClaude,
  isCodex,
  isOpenCode,
} from './agent-models';

function agent(command: string): AgentDef {
  return {
    id: command,
    name: command,
    command,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
  };
}

describe('agent-models catalog', () => {
  it('exposes the verified curated ids', () => {
    expect([...CLAUDE_MODELS]).toEqual(['opus', 'sonnet', 'haiku']);
    expect([...CODEX_MODELS]).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    expect([...CODEX_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh']);
    // Claude adds `max` ("max mode") on top of codex's levels.
    expect([...CLAUDE_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('classifies agents by command basename', () => {
    expect(isClaude(agent('claude'))).toBe(true);
    expect(isCodex(agent('/usr/local/bin/codex'))).toBe(true);
    expect(isOpenCode(agent('opencode'))).toBe(true);
    expect(isCodex(agent('claude'))).toBe(false);
  });

  it('supports reasoning effort for claude and codex, not opencode/custom', () => {
    expect(agentSupportsEffort(agent('codex'))).toBe(true);
    expect(agentSupportsEffort(agent('claude'))).toBe(true);
    expect(agentSupportsEffort(agent('opencode'))).toBe(false);
    expect(agentSupportsEffort(agent('my-custom-cli'))).toBe(false);
  });

  it('effortsFor: claude includes max, codex tops out at xhigh, others empty', () => {
    expect(effortsFor(agent('claude'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(agent('codex'))).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(effortsFor(agent('opencode'))).toEqual([]);
    expect(effortsFor(agent('my-custom-cli'))).toEqual([]);
  });

  it('curated list: claude/codex have lists; opencode + custom are empty (dynamic/unknown)', () => {
    expect(curatedModelsFor(agent('claude'))).toEqual(['opus', 'sonnet', 'haiku']);
    expect(curatedModelsFor(agent('codex'))).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    expect(curatedModelsFor(agent('opencode'))).toEqual([]);
    expect(curatedModelsFor(agent('my-custom-cli'))).toEqual([]);
  });
});
