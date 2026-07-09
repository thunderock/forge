import type { AgentDef } from '../ipc/types';
import type { Task } from '../store/types';

function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

function isAntigravityCommand(command: string): boolean {
  return command.split('/').pop() === 'agy';
}

function isCopilotCommand(command: string): boolean {
  return command.split('/').pop() === 'copilot';
}

const RESUME_FAILURE_PATTERNS: Record<string, string[]> = {
  claude: ['No conversation found to continue'],
};

export function isResumeArgsFailure(command: string, lastOutput: string[]): boolean {
  const base = command.split('/').pop() ?? command;
  const patterns = RESUME_FAILURE_PATTERNS[base];
  if (!patterns || lastOutput.length === 0) return false;
  const text = lastOutput.join('\n');
  return patterns.some((pattern) => text.includes(pattern));
}

function agentBasename(command: string): string {
  return command.split('/').pop() ?? command;
}

/**
 * Model-selection flags for the launch argv, or `[]` for the host CLI default
 * (MDL-01). Flags are global-position and get PREPENDED in `buildTaskAgentArgs`
 * so they stay valid ahead of subcommands like codex `resume`. Verified against
 * the installed claude/codex/opencode binaries (05-RESEARCH.md).
 * Unrecognized (custom) commands emit nothing — their flag surface is unknown.
 */
export function buildModelArgs(agentDef: AgentDef): string[] {
  const base = agentBasename(agentDef.command);
  const out: string[] = [];
  const model = agentDef.model?.trim();
  const effort = agentDef.reasoningEffort?.trim();

  if (base === 'claude') {
    if (model) out.push('--model', model); // opus | sonnet | haiku | <custom>
    if (effort) out.push('--effort', effort); // low | medium | high | xhigh | max ("max mode")
  } else if (base.includes('codex')) {
    if (model) out.push('-m', model); // gpt-5.5 | gpt-5.4 | gpt-5.4-mini | <custom>
    if (effort) out.push('-c', `model_reasoning_effort=${effort}`);
  } else if (base === 'opencode') {
    if (model) out.push('-m', model); // provider/model
    // NOTE: --variant is a `run`-only flag; the launched TUI ignores it. Omit.
  }
  return out;
}

function legacyMcpConfigArgs(command: string, mcpConfigPath: string | undefined): string[] {
  // Codex and Antigravity have no `--mcp-config` flag; passing it would break launch.
  if (!mcpConfigPath || isCodexCommand(command) || isAntigravityCommand(command)) return [];
  // Copilot has no `--mcp-config` flag either — it exits with "unknown option" (#146).
  // Use its `--additional-mcp-config <@file>` flag, which takes the same config shape.
  if (isCopilotCommand(command)) return ['--additional-mcp-config', `@${mcpConfigPath}`];
  return ['--mcp-config', mcpConfigPath];
}

export function buildTaskAgentArgs(
  agentDef: AgentDef,
  task: Pick<Task, 'skipPermissions' | 'mcpConfigPath' | 'mcpLaunchArgs'>,
  resumed: boolean,
): string[] {
  return [
    ...buildModelArgs(agentDef),
    ...(resumed && agentDef.resume_args?.length ? (agentDef.resume_args ?? []) : agentDef.args),
    ...(task.skipPermissions && agentDef.skip_permissions_args?.length
      ? (agentDef.skip_permissions_args ?? [])
      : []),
    ...(task.mcpLaunchArgs ?? legacyMcpConfigArgs(agentDef.command, task.mcpConfigPath)),
  ];
}
