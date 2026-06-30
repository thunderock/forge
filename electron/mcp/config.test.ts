import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getMCPRemoteServerUrl,
  getSubTaskMcpConfigPath,
  detectStaleDockerMCPUrl,
} from './config.js';

describe('getMCPRemoteServerUrl', () => {
  it('uses localhost for host-run MCP servers', () => {
    expect(getMCPRemoteServerUrl(7777)).toBe('http://127.0.0.1:7777');
  });

  it('uses host.docker.internal on macOS Docker Desktop', () => {
    expect(getMCPRemoteServerUrl(7777, 'forge-container', 'darwin')).toBe(
      'http://host.docker.internal:7777',
    );
  });

  it('uses localhost on Linux (--network host shares host loopback)', () => {
    expect(getMCPRemoteServerUrl(7777, 'forge-container', 'linux')).toBe('http://127.0.0.1:7777');
  });
});

describe('getSubTaskMcpConfigPath', () => {
  it('in Docker mode, places config in coordinator .forge dir (the explicit volume)', () => {
    const serverPath = '/worktree/.forge/mcp-server.cjs';
    expect(getSubTaskMcpConfigPath('my-container', serverPath, 'task-abc')).toBe(
      '/worktree/.forge/subtask-task-abc.json',
    );
  });

  it('in Docker mode, never places config in the sub-task worktree (not a volume mount)', () => {
    const serverPath = '/coordinator-worktree/.forge/mcp-server.cjs';
    const result = getSubTaskMcpConfigPath('my-container', serverPath, 'task-abc');
    expect(result).not.toContain('sub-task-worktree');
    expect(result).toContain('.forge');
  });

  it('in host mode, places config in the OS temp directory', () => {
    const serverPath = '/usr/lib/forge/mcp-server.cjs';
    expect(getSubTaskMcpConfigPath(null, serverPath, 'task-xyz', '/tmp')).toBe(
      '/tmp/forge-subtask-task-xyz.json',
    );
  });

  it('in host mode with no container, uses OS tmpdir default', () => {
    const serverPath = '/usr/lib/forge/mcp-server.cjs';
    const result = getSubTaskMcpConfigPath(undefined, serverPath, 'task-123');
    expect(result).toBe(join(tmpdir(), 'forge-subtask-task-123.json'));
  });
});

describe('detectStaleDockerMCPUrl — stale config detection', () => {
  it('returns null for non-Docker (no containerName)', () => {
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', undefined)).toBeNull();
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', '')).toBeNull();
  });

  it('returns warning on macOS when URL contains 127.0.0.1 and containerName is set', () => {
    const warning = detectStaleDockerMCPUrl('http://127.0.0.1:3001', 'my-container', 'darwin');
    expect(warning).not.toBeNull();
    expect(warning).toContain('127.0.0.1');
    expect(warning).toContain('host.docker.internal');
    expect(warning).toContain('my-container');
  });

  it('returns null on macOS when URL uses host.docker.internal', () => {
    expect(
      detectStaleDockerMCPUrl('http://host.docker.internal:3001', 'my-container', 'darwin'),
    ).toBeNull();
  });

  it('returns null on Linux even with 127.0.0.1 (host network makes it reachable)', () => {
    expect(detectStaleDockerMCPUrl('http://127.0.0.1:3001', 'my-container', 'linux')).toBeNull();
  });
});
