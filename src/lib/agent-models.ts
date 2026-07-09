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
// Claude Code effort levels (`claude --effort`), including `max` ("max mode").
// Codex tops out at xhigh; only claude offers `max`.
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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

/**
 * Reasoning-effort levels offered for this agent, or `[]` when it has none.
 * claude → `--effort` (low|medium|high|xhigh|max); codex → `-c model_reasoning_effort=`
 * (low|medium|high|xhigh). opencode's `--variant` is inert on the launched TUI, so none.
 */
export function effortsFor(agentDef: AgentDef): string[] {
  if (isClaude(agentDef)) return [...CLAUDE_EFFORTS];
  if (isCodex(agentDef)) return [...CODEX_EFFORTS];
  return [];
}

/** True when the agent honors a reasoning-effort selector (claude or codex). */
export function agentSupportsEffort(agentDef: AgentDef): boolean {
  return effortsFor(agentDef).length > 0;
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
