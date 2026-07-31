import { describe, expect, it } from 'vitest';
import type { AgentDef, CodexModelInfo } from '../ipc/types';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  agentSupportsEffort,
  claudeModelOptions,
  curatedModelsFor,
  effortsFor,
  effortsForModel,
  isClaude,
  isCodex,
  isEffortSupported,
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

function codexModel(slug: string, efforts: string[]): CodexModelInfo {
  return { slug, displayName: slug, efforts };
}

// Mirrors the golden ~/.codex/models_cache.json capture (2026-07-16): the six
// visible models in priority order with their real per-model effort lists.
const FETCHED_CODEX_MODELS: CodexModelInfo[] = [
  codexModel('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-terra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
  codexModel('gpt-5.6-luna', ['low', 'medium', 'high', 'xhigh', 'max']),
  codexModel('gpt-5.5', ['low', 'medium', 'high', 'xhigh']),
  codexModel('gpt-5.4', ['low', 'medium', 'high', 'xhigh']),
  codexModel('gpt-5.4-mini', ['low', 'medium', 'high', 'xhigh']),
];

// The captured host alias->ID resolution (2026-07-16, same values as the
// main-process resolution suite) — golden input for label parity.
const HOST_RESOLVED: Record<string, string> = {
  fable: 'us.anthropic.claude-fable-5[1m]',
  opus: 'us.anthropic.claude-opus-4-8[1m]',
  sonnet: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]',
  haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

describe('agent-models catalog', () => {
  it('exposes the verified curated ids', () => {
    expect([...CLAUDE_MODELS]).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect([...CODEX_MODELS]).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect([...CODEX_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh']);
    // Claude adds `max` ("max mode") on top of codex's static levels.
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

  it('curated list: claude/codex have fallback lists; opencode + custom are empty', () => {
    expect(curatedModelsFor(agent('claude'))).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(curatedModelsFor(agent('codex'))).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
    expect(curatedModelsFor(agent('opencode'))).toEqual([]);
    expect(curatedModelsFor(agent('my-custom-cli'))).toEqual([]);
  });
});

describe('effortsForModel (MDL-07/09)', () => {
  it('codex: per-model efforts from the fetched cache — sol offers ultra, 5.4 stops at xhigh', () => {
    expect(effortsForModel(agent('codex'), 'gpt-5.6-sol', FETCHED_CODEX_MODELS)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    expect(effortsForModel(agent('codex'), 'gpt-5.4', FETCHED_CODEX_MODELS)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('codex: unknown slug (Other… free-text) falls back to the static effort list', () => {
    expect(effortsForModel(agent('codex'), 'my-custom-model', FETCHED_CODEX_MODELS)).toEqual([
      ...CODEX_EFFORTS,
    ]);
  });

  it('codex: no selected model (Host default) falls back to the static effort list', () => {
    expect(effortsForModel(agent('codex'), undefined, FETCHED_CODEX_MODELS)).toEqual([
      ...CODEX_EFFORTS,
    ]);
    expect(effortsForModel(agent('codex'), '', FETCHED_CODEX_MODELS)).toEqual([...CODEX_EFFORTS]);
  });

  it('codex: empty fetch (missing/drifted cache) falls back to the static effort list', () => {
    expect(effortsForModel(agent('codex'), 'gpt-5.6-sol', [])).toEqual([...CODEX_EFFORTS]);
  });

  it('codex: a matched model declaring no efforts falls back to the static effort list', () => {
    expect(effortsForModel(agent('codex'), 'weird', [codexModel('weird', [])])).toEqual([
      ...CODEX_EFFORTS,
    ]);
  });

  it('claude: efforts are model-independent and include max', () => {
    expect(effortsForModel(agent('claude'), 'fable', [])).toEqual([...CLAUDE_EFFORTS]);
    expect(effortsForModel(agent('claude'), undefined, [])).toEqual([...CLAUDE_EFFORTS]);
  });

  it('opencode/custom: no effort control regardless of model', () => {
    expect(effortsForModel(agent('opencode'), 'anthropic/claude-opus', [])).toEqual([]);
    expect(effortsForModel(agent('my-custom-cli'), 'anything', [])).toEqual([]);
  });
});

describe('isEffortSupported (MDL-07)', () => {
  it('Default (undefined or empty) is always supported', () => {
    expect(isEffortSupported(undefined, ['low', 'medium'])).toBe(true);
    expect(isEffortSupported('', ['low', 'medium'])).toBe(true);
    expect(isEffortSupported(undefined, [])).toBe(true);
  });

  it('listed efforts are supported; missing ones are not', () => {
    const gpt54Efforts = ['low', 'medium', 'high', 'xhigh'];
    expect(isEffortSupported('high', gpt54Efforts)).toBe(true);
    expect(isEffortSupported('ultra', gpt54Efforts)).toBe(false);
  });
});

describe('claudeModelOptions — golden label parity (MDL-08/09)', () => {
  it('labels every alias with the captured host-resolved ID; values stay bare aliases', () => {
    expect(claudeModelOptions(HOST_RESOLVED)).toEqual([
      { value: 'fable', label: 'fable — us.anthropic.claude-fable-5[1m]' },
      { value: 'opus', label: 'opus — us.anthropic.claude-opus-4-8[1m]' },
      { value: 'sonnet', label: 'sonnet — us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]' },
      { value: 'haiku', label: 'haiku — us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    ]);
  });

  it('degrades to plain aliases when nothing resolves (MDL-09)', () => {
    expect(claudeModelOptions({})).toEqual([
      { value: 'fable', label: 'fable' },
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'haiku', label: 'haiku' },
    ]);
  });

  it('labels only the aliases the host declares (partial resolution)', () => {
    expect(claudeModelOptions({ haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' })).toEqual([
      { value: 'fable', label: 'fable' },
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'haiku', label: 'haiku — us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    ]);
  });

  it('option values track curatedModelsFor(claude) exactly — the selectValue membership contract', () => {
    // ModelSelector's selectValue() checks membership against listedModels()
    // (= curatedModelsFor for claude) while options render from claudeModelOptions;
    // the two must never diverge or a stored alias would fall into Other….
    expect(claudeModelOptions({}).map((o) => o.value)).toEqual(curatedModelsFor(agent('claude')));
  });
});

describe('claudeModelOptions — entitlement-filtered alias list (MDL-11)', () => {
  it('renders only the aliases the host is entitled to when a fetched list is given', () => {
    expect(claudeModelOptions({}, ['opus', 'sonnet', 'haiku'])).toEqual([
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
      { value: 'haiku', label: 'haiku' },
    ]);
  });

  it('still labels filtered aliases with host-resolved IDs', () => {
    expect(
      claudeModelOptions({ opus: 'us.anthropic.claude-opus-4-8[1m]' }, ['opus', 'haiku']),
    ).toEqual([
      { value: 'opus', label: 'opus — us.anthropic.claude-opus-4-8[1m]' },
      { value: 'haiku', label: 'haiku' },
    ]);
  });

  it('defaults to the full curated list when no fetched list is given (fallback)', () => {
    expect(claudeModelOptions({}).map((o) => o.value)).toEqual([
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);
  });
});
