import type { AgentDef } from '../ipc/types';
import type { Task } from '../store/types';

function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

function isAntigravityCommand(command: string): boolean {
  return command.split('/').pop() === 'agy';
}

function legacyMcpConfigArgs(command: string, mcpConfigPath: string | undefined): string[] {
  // Codex and Antigravity have no `--mcp-config` flag; passing it would break launch.
  if (!mcpConfigPath || isCodexCommand(command) || isAntigravityCommand(command)) return [];
  return ['--mcp-config', mcpConfigPath];
}

export function buildTaskAgentArgs(
  agentDef: AgentDef,
  task: Pick<Task, 'skipPermissions' | 'mcpConfigPath' | 'mcpLaunchArgs'>,
  resumed: boolean,
): string[] {
  return [
    ...(resumed && agentDef.resume_args?.length ? (agentDef.resume_args ?? []) : agentDef.args),
    ...(task.skipPermissions && agentDef.skip_permissions_args?.length
      ? (agentDef.skip_permissions_args ?? [])
      : []),
    ...(task.mcpLaunchArgs ?? legacyMcpConfigArgs(agentDef.command, task.mcpConfigPath)),
  ];
}
