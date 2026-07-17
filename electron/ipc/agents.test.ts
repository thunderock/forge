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
import { readFileSync } from 'node:fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import {
  DEFAULT_AGENTS,
  getSkipPermissionsArgs,
  listOpenCodeModels,
  listCodexModels,
  parseOpenCodeModels,
  parseCodexModelsCache,
  resetOpenCodeModelsCacheForTests,
  resetCodexModelsCacheForTests,
  resolveClaudeModelIds,
  resolveClaudeModelIdsFrom,
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

describe('parseCodexModelsCache (MDL-06/09/10)', () => {
  // Golden fixture: the REAL ~/.codex/models_cache.json captured 2026-07-16
  // (client 0.144.4), filtered to parse-relevant fields, values verbatim.
  const fixture = readFileSync(path.join(__dirname, 'codex-models-cache.fixture.json'), 'utf8');

  it('reproduces the live 2026-07-16 codex TUI picker: slugs in priority order', () => {
    expect(parseCodexModelsCache(fixture).map((m) => m.slug)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('excludes the hidden codex-auto-review model', () => {
    const slugs = parseCodexModelsCache(fixture).map((m) => m.slug);
    expect(slugs).not.toContain('codex-auto-review');
  });

  it('carries each model’s declared efforts in order', () => {
    const bySlug = new Map(parseCodexModelsCache(fixture).map((m) => [m.slug, m]));
    const full = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    expect(bySlug.get('gpt-5.6-sol')?.efforts).toEqual(full);
    expect(bySlug.get('gpt-5.6-terra')?.efforts).toEqual(full);
    expect(bySlug.get('gpt-5.6-luna')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(bySlug.get('gpt-5.5')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(bySlug.get('gpt-5.4')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(bySlug.get('gpt-5.4-mini')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('carries each model’s default effort (gpt-5.5 is xhigh, the rest medium)', () => {
    const defaults = Object.fromEntries(
      parseCodexModelsCache(fixture).map((m) => [m.slug, m.defaultEffort]),
    );
    expect(defaults).toEqual({
      'gpt-5.6-sol': 'medium',
      'gpt-5.6-terra': 'medium',
      'gpt-5.6-luna': 'medium',
      'gpt-5.5': 'xhigh',
      'gpt-5.4': 'medium',
      'gpt-5.4-mini': 'medium',
    });
  });

  it('carries display names (spot-check GPT-5.6-Sol)', () => {
    expect(parseCodexModelsCache(fixture)[0].displayName).toBe('GPT-5.6-Sol');
  });

  it('returns [] for empty / non-JSON / shape-drifted content', () => {
    expect(parseCodexModelsCache('')).toEqual([]);
    expect(parseCodexModelsCache('not json')).toEqual([]);
    expect(parseCodexModelsCache('{}')).toEqual([]);
    expect(parseCodexModelsCache('{"models":"nope"}')).toEqual([]);
  });

  it('returns [] when no entry has a usable slug', () => {
    const raw = JSON.stringify({ models: [{ visibility: 'list' }, { slug: 42 }] });
    expect(parseCodexModelsCache(raw)).toEqual([]);
  });

  it('keeps valid entries while skipping malformed siblings (per-entry tolerance)', () => {
    const raw = JSON.stringify({
      models: [
        { slug: 'good-model', visibility: 'list', priority: 2 },
        { visibility: 'list' }, // no slug
        { slug: 'hidden', visibility: 'hide', priority: 1 },
        null,
        'garbage',
      ],
    });
    expect(parseCodexModelsCache(raw)).toEqual([
      {
        slug: 'good-model',
        displayName: 'good-model',
        description: undefined,
        defaultEffort: undefined,
        efforts: [],
      },
    ]);
  });
});

describe('listCodexModels (MDL-06/09)', () => {
  const fixture = readFileSync(path.join(__dirname, 'codex-models-cache.fixture.json'), 'utf8');

  beforeEach(() => {
    resetCodexModelsCacheForTests();
    vi.restoreAllMocks();
  });

  it('reads ~/.codex/models_cache.json and returns the parsed models', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue(fixture);

    const models = await listCodexModels();
    expect(models.map((m) => m.slug)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
    ]);
  });

  it('returns [] when the cache file is missing (ENOENT)', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );

    expect(await listCodexModels()).toEqual([]);
  });

  it('returns [] when the cache file contains garbage', async () => {
    vi.spyOn(fs, 'readFile').mockResolvedValue('not json at all');

    expect(await listCodexModels()).toEqual([]);
  });

  it('caches the parsed result within the TTL (single file read)', async () => {
    const spy = vi.spyOn(fs, 'readFile').mockResolvedValue(fixture);

    const first = await listCodexModels();
    const second = await listCodexModels();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('does not cache failures — a later call re-reads the file', async () => {
    const spy = vi
      .spyOn(fs, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce(fixture);

    expect(await listCodexModels()).toEqual([]);
    const retry = await listCodexModels();
    expect(retry.map((m) => m.slug)).toContain('gpt-5.6-sol');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('resolveClaudeModelIdsFrom (MDL-08/10)', () => {
  // Golden parity: the four values captured from THIS host on 2026-07-16 —
  // exactly the claude /model picker rows (settings.json env block + shell env).
  const hostValues = {
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'us.anthropic.claude-fable-5[1m]',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-4-8[1m]',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  };
  const expected = {
    fable: 'us.anthropic.claude-fable-5[1m]',
    opus: 'us.anthropic.claude-opus-4-8[1m]',
    sonnet: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]',
    haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  };

  it('resolves all four aliases from the captured host process env', () => {
    expect(resolveClaudeModelIdsFrom(hostValues, {})).toEqual(expected);
  });

  it('resolves the same four aliases from the settings.json env block alone', () => {
    expect(resolveClaudeModelIdsFrom({}, hostValues)).toEqual(expected);
  });

  it('prefers process env over settings.json on conflict', () => {
    const resolved = resolveClaudeModelIdsFrom(
      { ANTHROPIC_DEFAULT_FABLE_MODEL: 'A' },
      { ANTHROPIC_DEFAULT_FABLE_MODEL: 'B' },
    );
    expect(resolved).toEqual({ fable: 'A' });
  });

  it('returns {} when nothing is declared', () => {
    expect(resolveClaudeModelIdsFrom({}, {})).toEqual({});
  });

  it('skips non-string settings.json values', () => {
    expect(resolveClaudeModelIdsFrom({}, { ANTHROPIC_DEFAULT_OPUS_MODEL: 42 })).toEqual({});
  });

  it('includes only the aliases that are declared (partial env)', () => {
    const resolved = resolveClaudeModelIdsFrom(
      { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
      {},
    );
    expect(resolved).toEqual({ haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
  });
});

describe('resolveClaudeModelIds (MDL-08/09)', () => {
  it('degrades to the process-env-only result when settings.json is unreadable', async () => {
    vi.spyOn(fs, 'readFile').mockRejectedValue(
      Object.assign(new Error('ENOENT: no settings.json'), { code: 'ENOENT' }),
    );

    const resolved = await resolveClaudeModelIds();
    expect(resolved).toEqual(resolveClaudeModelIdsFrom(process.env, {}));

    vi.restoreAllMocks();
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
