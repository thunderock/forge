import { describe, expect, it, vi, beforeEach } from 'vitest';
import { promisify } from 'util';

vi.mock('child_process', () => {
  const mockExecFile = vi.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: unknown,
    args: unknown,
    opts: unknown,
  ): Promise<{ stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
      mockExecFile(file, args, opts, (err: Error | null, stdout: string, stderr: string) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      });
    });
  return { execFile: mockExecFile };
});

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  DEFAULT_AGENTS,
  getSkipPermissionsArgs,
  listOpenCodeModels,
  parseOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
  mergeSkillNames,
  readSkillNames,
} from './agents.js';

describe('getSkipPermissionsArgs', () => {
  it('returns a copy of default skip-permission args', () => {
    const first = getSkipPermissionsArgs('claude');
    first.push('--mutated');

    expect(getSkipPermissionsArgs('claude')).toEqual(['--dangerously-skip-permissions']);
  });
});

describe('DEFAULT_AGENTS (AGT-01)', () => {
  it('contains exactly the built-in ids claude-code, codex, opencode', () => {
    expect(DEFAULT_AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'opencode']);
  });

  it('no longer offers the removed built-ins gemini, copilot, antigravity', () => {
    const ids = DEFAULT_AGENTS.map((a) => a.id);
    expect(ids).not.toContain('gemini');
    expect(ids).not.toContain('copilot');
    expect(ids).not.toContain('antigravity');
  });
});

describe('parseOpenCodeModels', () => {
  it('keeps only provider/model lines and trims whitespace', () => {
    const out = parseOpenCodeModels('opencode/big-pickle\n  anthropic/claude-x  \n\nnot-a-model\n');
    expect(out).toEqual(['opencode/big-pickle', 'anthropic/claude-x']);
  });
});

describe('listOpenCodeModels (MDL-04)', () => {
  // Reset the module-level TTL cache between cases so the success case's cached
  // value never leaks into the fallback case (plan-checker warning).
  beforeEach(() => {
    resetOpenCodeModelsCacheForTests();
    vi.mocked(execFile).mockReset();
  });

  it('returns parsed provider/model lines from `opencode models`', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(null, 'opencode/big-pickle\nanthropic/claude-x\n', '');
    }) as unknown as typeof execFile);

    expect(await listOpenCodeModels()).toEqual(['opencode/big-pickle', 'anthropic/claude-x']);
  });

  it('returns [] when the command errors (opencode absent / unauthed)', async () => {
    vi.mocked(execFile).mockImplementation(((
      _file: string,
      _args: readonly string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      cb(new Error('command not found: opencode'), '', '');
    }) as unknown as typeof execFile);

    expect(await listOpenCodeModels()).toEqual([]);
  });
});

describe('mergeSkillNames', () => {
  it('dedupes across sources, strips .md, filters junk, and sorts', () => {
    expect(
      mergeSkillNames(['gsd-quick.md', 'gsd-quick', 'find-skills', 'dataviz', '.git', '', '  ']),
    ).toEqual(['dataviz', 'find-skills', 'gsd-quick']);
  });
});

describe('readSkillNames', () => {
  it('unions skill names across dirs and skips absent ones', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-skills-'));
    const claudeCmds = path.join(root, 'claude', 'commands');
    const codexSkills = path.join(root, 'codex', 'skills');
    await fs.mkdir(claudeCmds, { recursive: true });
    await fs.mkdir(codexSkills, { recursive: true });
    await fs.writeFile(path.join(claudeCmds, 'gsd-quick.md'), '');
    await fs.mkdir(path.join(codexSkills, 'gsd-quick')); // same skill, codex side
    await fs.mkdir(path.join(codexSkills, 'gsd-plan-phase'));

    const names = await readSkillNames([
      claudeCmds,
      codexSkills,
      path.join(root, 'does', 'not', 'exist'),
    ]);
    expect(names).toEqual(['gsd-plan-phase', 'gsd-quick']);

    await fs.rm(root, { recursive: true, force: true });
  });
});
