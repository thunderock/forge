import type { AgentDef } from '../ipc/types';

/**
 * Curated model catalogs + agent-capability helpers for the New Task model
 * selector (MDL-04). Model id strings live ONLY here so re-verifying slugs later
 * is a one-file change. Codex ids verified against ~/.codex/models_cache.json
 * (05-RESEARCH.md); claude uses `--model` tier aliases; opencode is dynamic.
 */

/** Dropdown sentinel values — never sent to the CLI as a model. */
export const HOST_DEFAULT = '';
export const OTHER = '__other__';

export const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'] as const;
export const CODEX_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

function basename(command: string): string {
  return command.split('/').pop() ?? command;
}

export function isClaude(agentDef: AgentDef): boolean {
  return basename(agentDef.command) === 'claude';
}

export function isCodex(agentDef: AgentDef): boolean {
  return basename(agentDef.command).includes('codex');
}

export function isOpenCode(agentDef: AgentDef): boolean {
  return basename(agentDef.command) === 'opencode';
}

/** Codex is the only launched agent that honors reasoning effort (opencode --variant is inert). */
export function agentSupportsEffort(agentDef: AgentDef): boolean {
  return isCodex(agentDef);
}

/**
 * Curated model list for the dropdown, or `[]` when the list is dynamic
 * (opencode → `opencode models`) or unknown (custom agents). Excludes the
 * host-default and "Other…" sentinels — the component adds those.
 */
export function curatedModelsFor(agentDef: AgentDef): string[] {
  if (isClaude(agentDef)) return [...CLAUDE_MODELS];
  if (isCodex(agentDef)) return [...CODEX_MODELS];
  return [];
}
