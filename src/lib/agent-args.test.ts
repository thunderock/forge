import { describe, expect, it } from 'vitest';

import { buildTaskAgentArgs } from './agent-args';

const codexAgent = {
  id: 'codex',
  name: 'Codex',
  description: 'Codex agent',
  command: 'codex',
  args: ['resume', '--last'],
  resume_args: ['resume', '--last'],
  skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
};

const claudeAgent = {
  id: 'claude',
  name: 'Claude',
  description: 'Claude agent',
  command: 'claude',
  args: [],
  resume_args: [],
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

const antigravityAgent = {
  id: 'antigravity',
  name: 'Antigravity CLI',
  description: 'Antigravity agent',
  command: 'agy',
  args: [],
  resume_args: ['-c'],
  skip_permissions_args: ['--dangerously-skip-permissions'],
};

describe('buildTaskAgentArgs', () => {
  it('uses explicit MCP launch args when provided', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: true,
          mcpConfigPath: '/tmp/mcp.json',
          mcpLaunchArgs: ['--config', 'mcp_servers.parallel-code={ command = "node" }'],
        },
        false,
      ),
    ).toEqual([
      'resume',
      '--last',
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'mcp_servers.parallel-code={ command = "node" }',
    ]);
  });

  it('does not fall back to --mcp-config for Codex', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual(['resume', '--last']);
  });

  it('keeps --mcp-config fallback for Claude-compatible agents', () => {
    expect(
      buildTaskAgentArgs(
        claudeAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual(['--mcp-config', '/tmp/mcp.json']);
  });

  it('does not fall back to --mcp-config for Antigravity', () => {
    expect(
      buildTaskAgentArgs(
        antigravityAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual([]);
  });

  it('passes the resume flag for Antigravity without --mcp-config', () => {
    expect(
      buildTaskAgentArgs(
        antigravityAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
      ),
    ).toEqual(['-c']);
  });
});
