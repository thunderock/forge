import { describe, expect, it } from 'vitest';
import type { AgentDef } from '../ipc/types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CODEX_EFFORTS,
  agentSupportsEffort,
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
  });

  it('classifies agents by command basename', () => {
    expect(isClaude(agent('claude'))).toBe(true);
    expect(isCodex(agent('/usr/local/bin/codex'))).toBe(true);
    expect(isOpenCode(agent('opencode'))).toBe(true);
    expect(isCodex(agent('claude'))).toBe(false);
  });

  it('supports reasoning effort only for codex', () => {
    expect(agentSupportsEffort(agent('codex'))).toBe(true);
    expect(agentSupportsEffort(agent('claude'))).toBe(false);
    expect(agentSupportsEffort(agent('opencode'))).toBe(false);
  });

  it('curated list: claude/codex have lists; opencode + custom are empty (dynamic/unknown)', () => {
    expect(curatedModelsFor(agent('claude'))).toEqual(['opus', 'sonnet', 'haiku']);
    expect(curatedModelsFor(agent('codex'))).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
    expect(curatedModelsFor(agent('opencode'))).toEqual([]);
    expect(curatedModelsFor(agent('my-custom-cli'))).toEqual([]);
  });
});
