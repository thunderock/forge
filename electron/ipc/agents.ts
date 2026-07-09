import { execFile } from 'child_process';
import { promisify } from 'util';
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
