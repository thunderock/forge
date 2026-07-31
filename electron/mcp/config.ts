import os from 'os';
import { join, dirname } from 'path';
import { atomicWriteFile, atomicWriteFileSync } from './atomic.js';

export interface SubTaskMcpConfigOpts {
  serverPath: string;
  serverUrl: string;
  subtaskToken: string;
  taskId: string;
  doneToken: string;
}

export interface SubTaskMcpConfig {
  mcpServers: {
    forge: {
      type: 'stdio';
      command: 'node';
      args: string[];
      env: {
        FORGE_MCP_TOKEN: string;
        FORGE_MCP_DONE_TOKEN: string;
      };
    };
  };
}

export function getMCPRemoteServerUrl(
  port: number,
  dockerContainerName?: string,
  platform = os.platform(),
): string {
  if (!dockerContainerName) return `http://127.0.0.1:${port}`;
  // macOS Docker Desktop: host.docker.internal resolves to the host automatically.
  // Linux with --network host: the container shares the host's network namespace, so
  // 127.0.0.1 inside the container IS the host's loopback.
  return platform === 'darwin' ? `http://host.docker.internal:${port}` : `http://127.0.0.1:${port}`;
}

/**
 * Where to write a sub-task's MCP config file.
 *
 * In Docker mode the sub-task worktree is NOT an explicit volume mount, so
 * auto-discovery inside the container is unreliable. Instead, write the config
 * to the coordinator's .forge/ dir (same dir as mcp-server.cjs) which
 * IS the explicit volume, and always pass it via --mcp-config.
 *
 * In host mode, use the OS temp directory (existing behaviour).
 */
export function getSubTaskMcpConfigPath(
  dockerContainerName: string | null | undefined,
  serverPath: string,
  taskId: string,
  tempDir = os.tmpdir(),
): string {
  return dockerContainerName
    ? join(dirname(serverPath), `subtask-${taskId}.json`)
    : join(tempDir, `forge-subtask-${taskId}.json`);
}

export function buildSubTaskMcpConfig(args: SubTaskMcpConfigOpts): SubTaskMcpConfig {
  return {
    mcpServers: {
      forge: {
        type: 'stdio',
        command: 'node',
        args: [args.serverPath, '--url', args.serverUrl, '--task-id', args.taskId],
        env: {
          FORGE_MCP_TOKEN: args.subtaskToken,
          FORGE_MCP_DONE_TOKEN: args.doneToken,
        },
      },
    },
  };
}

export async function writeSubTaskMcpConfig(
  configPath: string,
  config: SubTaskMcpConfig,
): Promise<void> {
  await atomicWriteFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function writeSubTaskMcpConfigSync(configPath: string, config: SubTaskMcpConfig): void {
  atomicWriteFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function isAllowedSubTaskMcpConfigPath(
  configPath: string | undefined,
  args: {
    taskId: string;
    serverPath?: string;
    dockerContainerName?: string | null;
    tempDir?: string;
  },
): boolean {
  if (!configPath) return false;
  const tempDir = args.tempDir ?? os.tmpdir();
  const allowed = new Set([getSubTaskMcpConfigPath(null, '', args.taskId, tempDir)]);
  if (args.dockerContainerName && args.serverPath) {
    allowed.add(
      getSubTaskMcpConfigPath(args.dockerContainerName, args.serverPath, args.taskId, tempDir),
    );
  }
  return allowed.has(configPath);
}

/**
 * Returns a warning string if a Docker coordinator has a stale 127.0.0.1 URL
 * in its MCP config (unreachable from macOS containers). Returns null if OK.
 */
export function detectStaleDockerMCPUrl(
  url: string,
  containerName: string | undefined,
  currentPlatform = os.platform(),
): string | null {
  if (!containerName) return null; // non-Docker: 127.0.0.1 is correct
  if (currentPlatform === 'darwin' && url.includes('127.0.0.1')) {
    return (
      `Docker coordinator MCP URL contains 127.0.0.1 but container "${containerName}" ` +
      `cannot reach 127.0.0.1 on macOS. Use host.docker.internal instead.`
    );
  }
  return null;
}
