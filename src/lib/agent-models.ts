import type { AgentDef, CodexModelInfo } from '../ipc/types';

/**
 * Curated model catalogs + agent-capability helpers for the New Task model
 * selector (MDL-04/06/07/08). Model id strings live ONLY here so re-verifying
 * slugs later is a one-file change. Codex ids are now the FALLBACK for the
 * dynamic `~/.codex/models_cache.json` read over IPC.ListCodexModels (MDL-09);
 * claude uses `--model` tier aliases labeled via IPC.ResolveClaudeModels;
 * opencode is dynamic.
 */

/** Dropdown sentinel values — never sent to the CLI as a model. */
export const HOST_DEFAULT = '';
export const OTHER = '__other__';

export const CLAUDE_MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
// Fallback list = the six visible cache models on 2026-07-16, in priority order.
export const CODEX_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
] as const;
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
// Claude Code effort levels (`claude --effort`), including `max` ("max mode").
// Codex's static list tops out at xhigh; per-model cache data may add more.
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
 * (static fallback list). opencode's `--variant` is inert on the launched TUI, so none.
 * Answers "does this agent have an effort control at all" — per-model lists come
 * from `effortsForModel`.
 */
export function effortsFor(agentDef: AgentDef): string[] {
  if (isClaude(agentDef)) return [...CLAUDE_EFFORTS];
  if (isCodex(agentDef)) return [...CODEX_EFFORTS];
  return [];
}

/**
 * Effort levels for the SELECTED model (MDL-07): claude is model-independent;
 * codex uses the fetched cache entry's own list when available, else the static
 * fallback (covers Host default, Other… free-text, and an empty fetch — MDL-09).
 */
export function effortsForModel(
  agentDef: AgentDef,
  model: string | undefined,
  codexModels: CodexModelInfo[],
): string[] {
  if (isClaude(agentDef)) return [...CLAUDE_EFFORTS];
  if (isCodex(agentDef)) {
    const match = model ? codexModels.find((m) => m.slug === model) : undefined;
    if (match && match.efforts.length > 0) return [...match.efforts];
    return [...CODEX_EFFORTS];
  }
  return [];
}

/** True when `effort` is valid against `efforts` — Default (unset) always is. */
export function isEffortSupported(effort: string | undefined, efforts: string[]): boolean {
  if (!effort) return true;
  return efforts.includes(effort);
}

/**
 * Claude dropdown options (MDL-08): value = the bare alias stored and later
 * passed to `--model`; label carries the host-resolved concrete ID when
 * IPC.ResolveClaudeModels declared one, else the plain alias (MDL-09).
 * `aliases` is the entitlement-filtered list from IPC.ListClaudeModels
 * (MDL-11); omitted/empty means "no entitlement signal" → full curated list.
 */
export function claudeModelOptions(
  resolved: Record<string, string>,
  aliases: readonly string[] = CLAUDE_MODELS,
): { value: string; label: string }[] {
  return aliases.map((alias) => ({
    value: alias,
    label: resolved[alias] ? `${alias} — ${resolved[alias]}` : alias,
  }));
}

/** True when the agent honors a reasoning-effort selector (claude or codex). */
export function agentSupportsEffort(agentDef: AgentDef): boolean {
  return effortsFor(agentDef).length > 0;
}

/**
 * Curated model list for the dropdown, or `[]` when the list is dynamic
 * (opencode → `opencode models`) or unknown (custom agents). For codex this is
 * the fallback when the dynamic cache read returns empty. Excludes the
 * host-default and "Other…" sentinels — the component adds those.
 */
export function curatedModelsFor(agentDef: AgentDef): string[] {
  if (isClaude(agentDef)) return [...CLAUDE_MODELS];
  if (isCodex(agentDef)) return [...CODEX_MODELS];
  return [];
}
