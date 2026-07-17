import { execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const execFileAsync = promisify(execFile);

interface AgentDef {
  id: string;
  name: string;
  command: string;
  args: string[];
  resume_args: string[];
  skip_permissions_args: string[];
  description: string;
  available?: boolean;
  prompt_ready_delay_ms?: number;
}

export const DEFAULT_AGENTS: AgentDef[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    args: [],
    resume_args: ['--continue'],
    skip_permissions_args: ['--dangerously-skip-permissions'],
    description: "Anthropic's Claude Code CLI agent",
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    args: [],
    resume_args: ['resume', '--last'],
    skip_permissions_args: ['--dangerously-bypass-approvals-and-sandbox'],
    description: "OpenAI's Codex CLI agent",
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: 'Open source AI coding agent (opencode.ai)',
  },
];

async function isCommandAvailable(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command], { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// TTL cache to avoid repeated `which` calls
let cachedAgents: AgentDef[] | null = null;
let cacheTime = 0;
const AGENT_CACHE_TTL = 30_000;

export function getSkipPermissionsArgs(command: string): string[] {
  const base = path.basename(command);
  const agent = DEFAULT_AGENTS.find((a) => a.command === base || a.command === command);
  return agent ? [...agent.skip_permissions_args] : [];
}

export async function listAgents(): Promise<AgentDef[]> {
  const now = Date.now();
  if (cachedAgents && now - cacheTime < AGENT_CACHE_TTL) {
    return cachedAgents;
  }

  cachedAgents = await Promise.all(
    DEFAULT_AGENTS.map(async (agent) => ({
      ...agent,
      available: await isCommandAvailable(agent.command),
    })),
  );
  cacheTime = now;
  return cachedAgents;
}

// --- OpenCode dynamic model discovery (MDL-04) ---

/** Parse `opencode models` stdout into `provider/model` lines. */
export function parseOpenCodeModels(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/'));
}

let cachedOpenCodeModels: string[] | null = null;
let openCodeModelsCacheTime = 0;
const OPENCODE_MODELS_TTL = 5 * 60_000;

/** Test-only: clear the module-level cache so cases don't leak into each other. */
export function resetOpenCodeModelsCacheForTests(): void {
  cachedOpenCodeModels = null;
  openCodeModelsCacheTime = 0;
}

/**
 * Discover the user's opencode models via `opencode models` (one `provider/model`
 * per line, authed providers only). TTL-cached; returns `[]` when opencode is
 * absent / unauthed / errors — never throws (MDL-04).
 */
export async function listOpenCodeModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedOpenCodeModels && now - openCodeModelsCacheTime < OPENCODE_MODELS_TTL) {
    return cachedOpenCodeModels;
  }
  try {
    const { stdout } = await execFileAsync('opencode', ['models'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    cachedOpenCodeModels = parseOpenCodeModels(stdout);
    openCodeModelsCacheTime = now;
    return cachedOpenCodeModels;
  } catch {
    return [];
  }
}

// --- Codex dynamic model discovery (MDL-06) ---

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description?: string;
  defaultEffort?: string;
  efforts: string[]; // that model's supported_reasoning_levels[].effort, in declared order
}

/**
 * Parse the raw contents of `~/.codex/models_cache.json` — the same file the codex
 * TUI picker renders from — into the visible models, priority-sorted. Pure and
 * tolerant: any parse/shape failure yields `[]` so the renderer falls back to the
 * curated list instead of crashing (MDL-09); malformed entries are skipped
 * individually.
 */
export function parseCodexModelsCache(raw: string): CodexModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return [];

  const rows: { info: CodexModelInfo; priority: number }[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const m = entry as Record<string, unknown>;
    if (typeof m.slug !== 'string' || m.visibility !== 'list') continue;
    const levels = m.supported_reasoning_levels;
    const efforts = Array.isArray(levels)
      ? levels
          .map((l) => (l as { effort?: unknown } | null)?.effort)
          .filter((e): e is string => typeof e === 'string')
      : [];
    rows.push({
      info: {
        slug: m.slug,
        displayName: typeof m.display_name === 'string' ? m.display_name : m.slug,
        description: typeof m.description === 'string' ? m.description : undefined,
        defaultEffort:
          typeof m.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined,
        efforts,
      },
      priority: typeof m.priority === 'number' ? m.priority : Infinity,
    });
  }
  // Stable sort: ties keep input order (Array.prototype.sort is stable in Node).
  rows.sort((a, b) => a.priority - b.priority);
  return rows.map((r) => r.info);
}

let cachedCodexModels: CodexModelInfo[] | null = null;
let codexModelsCacheTime = 0;
const CODEX_MODELS_TTL = 5 * 60_000;

/** Test-only: clear the module-level cache so cases don't leak into each other. */
export function resetCodexModelsCacheForTests(): void {
  cachedCodexModels = null;
  codexModelsCacheTime = 0;
}

/**
 * Discover the codex models visible in its TUI picker by reading
 * `~/.codex/models_cache.json`. TTL-cached; returns `[]` when the file is
 * missing / unreadable / drifted — never throws (MDL-09). Failures are not
 * cached so a later read can recover.
 */
export async function listCodexModels(): Promise<CodexModelInfo[]> {
  const now = Date.now();
  if (cachedCodexModels && now - codexModelsCacheTime < CODEX_MODELS_TTL) {
    return cachedCodexModels;
  }
  try {
    const raw = await fs.readFile(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8');
    cachedCodexModels = parseCodexModelsCache(raw);
    codexModelsCacheTime = now;
    return cachedCodexModels;
  } catch {
    return [];
  }
}

// --- Agent skill discovery (autocomplete for the New Task "Skill" field) ---

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/** Config dirs where installed claude/codex skills + commands live on the host. */
export function defaultSkillDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, '.claude', 'commands'),
    path.join(home, '.claude', 'skills'),
    path.join(home, '.codex', 'skills'),
  ];
}

/** Dedupe + sort skill names from raw dir entries. Strips a `.md` suffix (command files)
 *  and drops anything that isn't a plausible skill name. */
export function mergeSkillNames(entries: string[]): string[] {
  const names = new Set<string>();
  for (const raw of entries) {
    const name = raw.replace(/\.md$/i, '').trim();
    if (name && SKILL_NAME_RE.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** Read + merge skill names from the given dirs. Missing dirs are skipped; never throws. */
export async function readSkillNames(dirs: string[]): Promise<string[]> {
  const all: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) all.push(e.name);
    } catch {
      /* dir absent / unreadable — skip (discovery is best-effort) */
    }
  }
  return mergeSkillNames(all);
}

let cachedSkills: string[] | null = null;
let skillsCacheTime = 0;
const AGENT_SKILLS_TTL = 5 * 60_000;

/**
 * Discover installed skill names across the host's claude/codex config dirs, for the New
 * Task Skill-field autocomplete. TTL-cached; best-effort (returns whatever it finds, never
 * throws). NOT authoritative — the field accepts free text and the agent validates.
 */
export async function listAgentSkills(): Promise<string[]> {
  const now = Date.now();
  if (cachedSkills && now - skillsCacheTime < AGENT_SKILLS_TTL) return cachedSkills;
  cachedSkills = await readSkillNames(defaultSkillDirs());
  skillsCacheTime = now;
  return cachedSkills;
}
