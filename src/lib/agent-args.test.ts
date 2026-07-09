import { describe, expect, it } from 'vitest';

import {
  buildModelArgs,
  buildTaskAgentArgs,
  isResumeArgsFailure,
  isSkillInvocation,
  renderSkillInvocation,
  shouldBypassBracketedPaste,
} from './agent-args';

const codexAgent = {
  id: 'codex',
  name: 'Codex',
  description: 'Codex agent',
  command: 'codex',
  args: [],
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

const copilotAgent = {
  id: 'copilot',
  name: 'Copilot CLI',
  description: 'Copilot agent',
  command: 'copilot',
  args: [],
  resume_args: ['--continue'],
  skip_permissions_args: ['--yolo'],
};

const opencodeAgent = {
  id: 'opencode',
  name: 'OpenCode',
  description: 'OpenCode agent',
  command: 'opencode',
  args: [],
  resume_args: [],
  skip_permissions_args: [],
};

const customAgent = {
  id: 'custom-1',
  name: 'My CLI',
  description: 'Custom agent',
  command: 'mycli',
  args: [],
  resume_args: [],
  skip_permissions_args: [],
};

describe('buildTaskAgentArgs', () => {
  it('uses explicit MCP launch args when provided (new task)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: true,
          mcpConfigPath: '/tmp/mcp.json',
          mcpLaunchArgs: ['--config', 'mcp_servers.forge={ command = "node" }'],
        },
        false,
      ),
    ).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'mcp_servers.forge={ command = "node" }',
    ]);
  });

  it('uses explicit MCP launch args when provided (resumed task)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: true,
          mcpConfigPath: '/tmp/mcp.json',
          mcpLaunchArgs: ['--config', 'mcp_servers.forge={ command = "node" }'],
        },
        true,
      ),
    ).toEqual([
      'resume',
      '--last',
      '--dangerously-bypass-approvals-and-sandbox',
      '--config',
      'mcp_servers.forge={ command = "node" }',
    ]);
  });

  it('does not fall back to --mcp-config for Codex (new task, no args)', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual([]);
  });

  it('uses resume_args for Codex when resuming', () => {
    expect(
      buildTaskAgentArgs(
        codexAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
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

  it('uses Copilot --additional-mcp-config fallback instead of the unsupported --mcp-config', () => {
    expect(
      buildTaskAgentArgs(
        copilotAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        false,
      ),
    ).toEqual(['--additional-mcp-config', '@/tmp/mcp.json']);
  });

  it('passes the Copilot resume flag alongside the --additional-mcp-config fallback', () => {
    expect(
      buildTaskAgentArgs(
        copilotAgent,
        {
          skipPermissions: false,
          mcpConfigPath: '/tmp/mcp.json',
        },
        true,
      ),
    ).toEqual(['--continue', '--additional-mcp-config', '@/tmp/mcp.json']);
  });

  it('emits no model flag for the host CLI default (MDL-01)', () => {
    // Guards the existing behaviour: no model set => argv identical to pre-feature.
    expect(
      buildTaskAgentArgs(
        claudeAgent,
        { skipPermissions: false, mcpConfigPath: '/tmp/mcp.json' },
        false,
      ),
    ).toEqual(['--mcp-config', '/tmp/mcp.json']);
  });

  it('prepends codex -m/-c before the resume subcommand (MDL-02/MDL-03)', () => {
    expect(
      buildTaskAgentArgs(
        { ...codexAgent, model: 'gpt-5.4', reasoningEffort: 'high' },
        { skipPermissions: false, mcpConfigPath: undefined },
        true,
      ),
    ).toEqual(['-m', 'gpt-5.4', '-c', 'model_reasoning_effort=high', 'resume', '--last']);
  });
});

describe('buildModelArgs', () => {
  it('returns [] for the host CLI default (no model) — MDL-01', () => {
    expect(buildModelArgs(claudeAgent)).toEqual([]);
    expect(buildModelArgs(codexAgent)).toEqual([]);
    expect(buildModelArgs(opencodeAgent)).toEqual([]);
  });

  it('emits claude --model <alias> first', () => {
    const args = buildModelArgs({ ...claudeAgent, model: 'opus' });
    expect(args).toEqual(['--model', 'opus']);
    expect(args[0]).toBe('--model');
  });

  it('emits claude --effort (incl. max) alongside --model', () => {
    expect(buildModelArgs({ ...claudeAgent, model: 'opus', reasoningEffort: 'max' })).toEqual([
      '--model',
      'opus',
      '--effort',
      'max',
    ]);
  });

  it('emits claude --effort even when the model is host-default', () => {
    expect(buildModelArgs({ ...claudeAgent, reasoningEffort: 'high' })).toEqual([
      '--effort',
      'high',
    ]);
  });

  it('emits codex -m and -c model_reasoning_effort when both set', () => {
    expect(buildModelArgs({ ...codexAgent, model: 'gpt-5.4', reasoningEffort: 'high' })).toEqual([
      '-m',
      'gpt-5.4',
      '-c',
      'model_reasoning_effort=high',
    ]);
  });

  it('emits codex effort even when the model is host-default', () => {
    expect(buildModelArgs({ ...codexAgent, reasoningEffort: 'xhigh' })).toEqual([
      '-c',
      'model_reasoning_effort=xhigh',
    ]);
  });

  it('emits opencode -m provider/model with NO --variant', () => {
    const args = buildModelArgs({ ...opencodeAgent, model: 'opencode/deepseek-v4-flash-free' });
    expect(args).toEqual(['-m', 'opencode/deepseek-v4-flash-free']);
    expect(args).not.toContain('--variant');
  });

  it('emits no model flag for an unknown/custom command', () => {
    expect(buildModelArgs({ ...customAgent, model: 'whatever', reasoningEffort: 'high' })).toEqual(
      [],
    );
  });
});

describe('isResumeArgsFailure', () => {
  describe('Claude resume failure patterns', () => {
    it('returns true when Claude reports no conversation to continue', () => {
      expect(isResumeArgsFailure('claude', ['No conversation found to continue'])).toBe(true);
    });

    it('returns true for a Claude command with a full path', () => {
      expect(
        isResumeArgsFailure('/usr/local/bin/claude', ['No conversation found to continue']),
      ).toBe(true);
    });

    it('returns false when Claude output does not match a resume failure', () => {
      expect(isResumeArgsFailure('claude', ['Resuming conversation...'])).toBe(false);
    });

    it('matches Claude resume failures across multiple output lines', () => {
      expect(
        isResumeArgsFailure('claude', [
          '\x1b[1mClaude Code\x1b[22m',
          '────────────────────────────────',
          'No conversation found to continue',
          'Run claude without --continue to start a new conversation',
          '❯ ',
        ]),
      ).toBe(true);
    });
  });

  describe('unsupported commands', () => {
    it('returns false for commands without configured resume failure patterns', () => {
      expect(isResumeArgsFailure('unknown-agent', ['No conversation found to continue'])).toBe(
        false,
      );
    });

    it('returns false for full-path commands without configured resume failure patterns', () => {
      expect(
        isResumeArgsFailure('/usr/local/bin/unknown-agent', ['No conversation found to continue']),
      ).toBe(false);
    });
  });

  it('returns false for empty last output', () => {
    expect(isResumeArgsFailure('claude', [])).toBe(false);
  });
});

describe('isSkillInvocation', () => {
  it('detects a leading /name or $name (with or without args)', () => {
    expect(isSkillInvocation('/gsd-quick fix the prompt')).toBe(true);
    expect(isSkillInvocation('$gsd-quick fix the prompt')).toBe(true);
    expect(isSkillInvocation('/gsd-quick')).toBe(true);
    expect(isSkillInvocation('  /model')).toBe(true); // leading whitespace tolerated
  });

  it('does not misread an absolute path or plain prose', () => {
    expect(isSkillInvocation('/Users/foo/bar')).toBe(false); // path, not a command
    expect(isSkillInvocation('fix the /gsd-quick thing')).toBe(false); // not leading
    expect(isSkillInvocation('just a normal prompt')).toBe(false);
    expect(isSkillInvocation('$')).toBe(false);
    expect(isSkillInvocation('')).toBe(false);
  });
});

describe('renderSkillInvocation', () => {
  it('renders codex with $ and everyone else with /', () => {
    expect(renderSkillInvocation(codexAgent, 'gsd-quick')).toBe('$gsd-quick');
    expect(renderSkillInvocation(claudeAgent, 'gsd-quick')).toBe('/gsd-quick');
    expect(renderSkillInvocation(opencodeAgent, 'gsd-quick')).toBe('/gsd-quick');
  });

  it('normalizes a user-typed leading slash/dollar and blank input', () => {
    expect(renderSkillInvocation(codexAgent, '/gsd-quick')).toBe('$gsd-quick');
    expect(renderSkillInvocation(claudeAgent, '$gsd-quick')).toBe('/gsd-quick');
    expect(renderSkillInvocation(claudeAgent, '   ')).toBe('');
  });
});

describe('shouldBypassBracketedPaste', () => {
  it('bypasses only for claude + a skill invocation', () => {
    expect(shouldBypassBracketedPaste('claude', '/gsd-quick fix')).toBe(true);
    expect(shouldBypassBracketedPaste('/usr/local/bin/claude', '/gsd-quick')).toBe(true);
    // codex keeps bracketed paste ($ is a message mention, not a slash command)
    expect(shouldBypassBracketedPaste('codex', '$gsd-quick fix')).toBe(false);
    // claude with a normal prompt keeps bracketed paste
    expect(shouldBypassBracketedPaste('claude', 'just a normal prompt')).toBe(false);
  });
});
