interface ForgeMcpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ForgeMcpConfig {
  mcpServers: {
    forge: ForgeMcpServerConfig;
  };
}

export function isCodexCommand(command: string): boolean {
  return command.split('/').pop()?.includes('codex') === true;
}

export function isAntigravityCommand(command: string): boolean {
  return command.split('/').pop() === 'agy';
}

export function isCopilotCommand(command: string): boolean {
  return command.split('/').pop() === 'copilot';
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlStringMap(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(', ')} }`;
}

export function buildCodexMcpConfigOverride(config: ForgeMcpConfig): string {
  const server = config.mcpServers['forge'];
  return `mcp_servers.forge={ command = ${tomlString(server.command)}, args = ${tomlStringArray(server.args)}, env = ${tomlStringMap(server.env)} }`;
}

export function buildMcpLaunchArgs(
  command: string,
  configPath: string | undefined,
  config: ForgeMcpConfig,
): string[] {
  if (isCodexCommand(command)) {
    return ['--config', buildCodexMcpConfigOverride(config)];
  }
  // Antigravity (agy) has no `--mcp-config` flag; emit nothing so launch is not broken.
  if (isAntigravityCommand(command)) {
    return [];
  }
  // Copilot has no `--mcp-config` flag — passing it makes Copilot exit immediately
  // with "unknown option" before the prompt is ever sent (#146). It accepts
  // `--additional-mcp-config <@file|json>` (and also auto-discovers a workspace
  // `.mcp.json`), both of which take this same config shape.
  if (isCopilotCommand(command)) {
    return configPath ? ['--additional-mcp-config', `@${configPath}`] : [];
  }
  return configPath ? ['--mcp-config', configPath] : [];
}
