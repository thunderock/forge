import * as pty from 'node-pty';
import { execFileSync, execFile, spawn as cpSpawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { BrowserWindow } from 'electron';
import { RingBuffer } from '../remote/ring-buffer.js';
import { resolveUserShell } from '../user-shell.js';
import { ensureClaudeSandboxFiles, ensureSandboxExcludes } from './git.js';
import {
  acquireAgentImage,
  dockerImagePresentByTag,
  dockerImagePresentSync,
  pullDockerImage,
  delay as abortableDelay,
  downloadAndLoadReleaseImage,
  hostImageArch,
  PROJECT_IMAGE_PREFIX,
} from './docker-pull.js';
import { debug as logDebug } from '../log.js';
import {
  DOCKER_CONTAINER_HOME,
  FORGE_SKEL_MOUNT,
  GSD_SEED_ENTRYPOINT,
  ensureGsdSkeleton,
} from './docker-gsd-seed.js';

// Re-exported so the existing './pty.js' import surface is preserved (pty.test.ts
// and spawnAgent's consumers). Its canonical definition now lives in
// docker-gsd-seed.ts — the shared, dependency-light seed source of truth.
export { DOCKER_CONTAINER_HOME };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface PtySession {
  proc: pty.IPty;
  channelId: string;
  taskId: string;
  agentId: string;
  isShell: boolean;
  flushTimer: ReturnType<typeof setTimeout> | null;
  subscribers: Set<(encoded: string) => void>;
  scrollback: RingBuffer;
  /** Assigned container name when running in Docker mode, null otherwise. */
  containerName: string | null;
}

const sessions = new Map<string, PtySession>();

/** Agents whose Docker image pull is in flight (no live PTY session yet). */
const pendingPulls = new Map<string, AbortController>();

/** Images confirmed present locally this session — skip the per-spawn presence check. */
const knownPresentImages = new Set<string>();

function sendToChannel(win: BrowserWindow, channelId: string, msg: unknown): void {
  if (!win.isDestroyed()) {
    win.webContents.send(`channel:${channelId}`, msg);
  }
}

// --- PTY event bus for spawn/exit notifications ---

type PtyEventType = 'spawn' | 'exit' | 'list-changed';
type PtyEventListener = (agentId: string, data?: unknown) => void;
const eventListeners = new Map<PtyEventType, Set<PtyEventListener>>();

/** Register a listener for PTY lifecycle events. Returns an unsubscribe function. */
export function onPtyEvent(event: PtyEventType, listener: PtyEventListener): () => void {
  let listeners = eventListeners.get(event);
  if (!listeners) {
    listeners = new Set();
    eventListeners.set(event, listeners);
  }
  listeners.add(listener);
  return () => {
    eventListeners.get(event)?.delete(listener);
  };
}

function emitPtyEvent(event: PtyEventType, agentId: string, data?: unknown): void {
  if (event === 'spawn' || event === 'exit') {
    logDebug('pty', `${event} ${agentId}`, data ? { data } : undefined);
  }
  eventListeners.get(event)?.forEach((fn) => fn(agentId, data));
}

/** Notify listeners that the agent list has changed (e.g. task deleted). */
export function notifyAgentListChanged(): void {
  emitPtyEvent('list-changed', '');
}

const BATCH_MAX = 64 * 1024;
const BATCH_INTERVAL = 8; // ms
const TAIL_CAP = 8 * 1024;
const MAX_LINES = 50;
const ENV_BLOCK_LIST = new Set([
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  // Prevent renderer from injecting or overriding MCP auth tokens.
  'FORGE_MCP_TOKEN',
]);

export interface SpawnAgentArgs {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  isShell?: boolean;
  dockerMode?: boolean;
  dockerImage?: string;
  shareDockerAgentAuth?: boolean;
  attachExisting?: boolean;
  dockerMountWorktreeParent?: boolean;
  onOutput: { __CHANNEL_ID__: string };
}

function redactedSpawnArgs(command: string, args: string[]): string[] {
  if ((command === '/bin/sh' || command.endsWith('/sh')) && args[0] === '-c') {
    return ['-c', '<redacted>'];
  }
  if (command === 'docker') {
    return redactDockerArgs(args);
  }
  return args;
}

function redactDockerArgs(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNextEnv = false;

  for (const arg of args) {
    if (redactNextEnv) {
      redacted.push(redactEnvAssignment(arg));
      redactNextEnv = false;
      continue;
    }

    if (arg === '-e' || arg === '--env') {
      redacted.push(arg);
      redactNextEnv = true;
      continue;
    }

    if (arg.startsWith('--env=')) {
      redacted.push(`--env=${redactEnvAssignment(arg.slice('--env='.length))}`);
      continue;
    }

    redacted.push(arg);
  }

  return redacted;
}

function redactEnvAssignment(value: string): string {
  const eqIdx = value.indexOf('=');
  if (eqIdx <= 0) return '<redacted>';
  return `${value.slice(0, eqIdx)}=<redacted>`;
}

/** Verify that a command exists in PATH. Throws a descriptive error if not found. */
export function validateCommand(command: string): void {
  if (!command || !command.trim()) {
    throw new Error('Command must not be empty.');
  }
  // Absolute paths: check directly via filesystem
  if (command.startsWith('/')) {
    try {
      fs.accessSync(command, fs.constants.X_OK);
      return;
    } catch {
      throw new Error(
        `Command '${command}' not found or not executable. Check that it is installed.`,
      );
    }
  }
  // Bare names: resolve via `which` (execFileSync — no shell interpolation)
  try {
    execFileSync('which', [command], { encoding: 'utf8', timeout: 3000 });
  } catch {
    throw new Error(
      `Command '${command}' not found in PATH. Make sure it is installed and available in your terminal.`,
    );
  }
}

function copyProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

export function buildPtySpawnEnv(rendererEnv: Record<string, string> = {}): Record<string, string> {
  const spawnEnv: Record<string, string> = {
    ...copyProcessEnv(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };

  for (const [key, value] of Object.entries(rendererEnv)) {
    if (!ENV_BLOCK_LIST.has(key)) spawnEnv[key] = value;
  }

  delete spawnEnv.CLAUDECODE;
  delete spawnEnv.CLAUDE_CODE_SESSION;
  delete spawnEnv.CLAUDE_CODE_ENTRYPOINT;

  return spawnEnv;
}

/** Returns `-v mainGitDir:mainGitDir` mount args so git works inside the container.
 *  Walks up from startPath to find the .git file (worktrees may be nested directories). */
function resolveWorktreeGitDirMount(startPath: string): string[] {
  try {
    let dir = startPath;
    while (true) {
      const gitFile = path.join(dir, '.git');
      if (fs.existsSync(gitFile)) {
        if (!fs.statSync(gitFile).isFile()) return []; // real .git dir, no extra mount needed
        const content = fs.readFileSync(gitFile, 'utf8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (!match) return [];
        // Walk up from the gitdir pointer until we find the dir containing objects/
        // (the main .git dir). Avoids hard-coding a fixed number of levels.
        let candidate = path.resolve(match[1].trim());
        while (true) {
          if (fs.existsSync(path.join(candidate, 'objects'))) {
            return ['-v', `${candidate}:${candidate}`];
          }
          const parent = path.dirname(candidate);
          if (parent === candidate) return [];
          candidate = parent;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return []; // filesystem root
      dir = parent;
    }
  } catch {
    return [];
  }
}

interface PtySpawnSpec {
  spawnCommand: string;
  spawnArgs: string[];
  cwd: string | undefined;
  env: Record<string, string>;
  containerName: string | null;
}

function buildPtySpawnSpec(
  args: SpawnAgentArgs,
  command: string,
  cwd: string,
  spawnEnv: Record<string, string>,
  filteredEnv: Record<string, string>,
): PtySpawnSpec {
  // Derive a predictable, unique container name from the agentId so we can
  // reliably stop it later without having to parse docker inspect output.
  const containerName = args.dockerMode ? `forge-${args.agentId.slice(0, 12)}` : null;

  if (!args.dockerMode) {
    return {
      spawnCommand: command,
      spawnArgs: args.args,
      cwd,
      env: spawnEnv,
      containerName,
    };
  }

  const name = containerName as string;
  const image = args.dockerImage || DOCKER_DEFAULT_IMAGE;
  // Per-agent, user-owned host dir that backs the container HOME. Created here
  // as the run-user so HOME stays writable under --user; unique per agentId so
  // concurrent agents never collide (DOCK-05). Bind-mounted to the fixed
  // DOCKER_CONTAINER_HOME below.
  const hostHome = agentHomeDir(args.agentId);
  try {
    fs.mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  } catch {
    console.warn(`[docker] Could not create agent HOME dir ${hostHome}`);
  }
  return {
    spawnCommand: 'docker',
    spawnArgs: [
      'run',
      '--rm',
      '-it',
      '--name',
      name,
      '--label',
      'forge=true',
      '--network',
      'host',
      '--memory',
      '8g',
      '--pids-limit',
      '512',
      '--user',
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      ...(args.dockerMountWorktreeParent
        ? ['-v', `${path.dirname(cwd)}:${path.dirname(cwd)}`, ...resolveWorktreeGitDirMount(cwd)]
        : []),
      '-v',
      `${cwd}:${cwd}`,
      '-w',
      cwd,
      ...buildDockerEnvFlags(spawnEnv),
      // Per-agent writable HOME: bind-mount the user-owned host dir onto the
      // fixed container path and point HOME at it (see DOCKER_CONTAINER_HOME).
      '-v',
      `${hostHome}:${DOCKER_CONTAINER_HOME}`,
      '-e',
      `HOME=${DOCKER_CONTAINER_HOME}`,
      // Mount SSH and git config read-only for git operations, nested under HOME
      ...buildDockerCredentialMounts(
        args.command,
        args.shareDockerAgentAuth === true,
        cwd,
        DOCKER_CONTAINER_HOME,
      ),
      image,
      // Seed the per-agent HOME from the read-only gsd skeleton staged at
      // /opt/forge-skel (Design B — the image's own /home/agent is 0750/uid-1000
      // and unreadable by the run-user). cp -an is no-clobber so a shared-auth
      // .claude bind mount keeps its credentials, and the seed runs IN-CONTAINER
      // after mounts so that mount is not shadowed (RESEARCH Pitfall 3). Failures
      // SURFACE (DOCK-04): an unwritable HOME is FATAL (exit 1); a cp miss WARNs
      // and continues (an empty skel dir must still let the agent run).
      'sh',
      '-c',
      GSD_SEED_ENTRYPOINT,
      '--',
      command,
      ...args.args,
    ],
    cwd: undefined,
    env: filteredEnv,
    containerName,
  };
}

function cleanupExistingSession(agentId: string, existing: PtySession | undefined): void {
  if (!existing) return;
  if (existing.flushTimer) clearTimeout(existing.flushTimer);
  existing.subscribers.clear();
  existing.proc.kill();
  sessions.delete(agentId);
}

function attachPtyOutputHandlers(
  win: BrowserWindow,
  session: PtySession,
  args: SpawnAgentArgs,
  command: string,
): void {
  let batchChunks: Buffer[] = [];
  let batchSize = 0;
  let tailChunks: Buffer[] = [];
  let tailSize = 0;
  const containerName = session.containerName;

  const send = (msg: unknown) => {
    sendToChannel(win, session.channelId, msg);
  };

  if (args.dockerMode) {
    const image = args.dockerImage || DOCKER_DEFAULT_IMAGE;
    const innerCmd = [command, ...args.args].join(' ');
    const banner =
      `\x1b[2m[docker] container: ${containerName}\r\n` +
      `[docker] image: ${image}\r\n` +
      `[docker] command: ${innerCmd}\r\n` +
      `[docker] waiting for container to start…\x1b[0m\r\n\r\n`;
    console.warn(`[docker] spawning container ${containerName} — image=${image} cmd=${innerCmd}`);
    send({ type: 'Data', data: Buffer.from(banner, 'utf8').toString('base64') });
  }

  const flush = () => {
    if (batchSize === 0) return;
    const batch = Buffer.concat(batchChunks);
    const encoded = batch.toString('base64');
    send({ type: 'Data', data: encoded });
    session.scrollback.write(batch);
    for (const sub of session.subscribers) {
      sub(encoded);
    }
    batchChunks = [];
    batchSize = 0;
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  };

  session.proc.onData((data: string) => {
    const chunk = Buffer.from(data, 'utf8');

    tailChunks.push(chunk);
    tailSize += chunk.length;
    if (tailSize > TAIL_CAP) {
      const combined = Buffer.concat(tailChunks);
      const trimmed = combined.subarray(combined.length - TAIL_CAP);
      tailChunks = [trimmed];
      tailSize = trimmed.length;
    }

    batchChunks.push(chunk);
    batchSize += chunk.length;

    if (batchSize >= BATCH_MAX || chunk.length < 1024) {
      flush();
      return;
    }

    if (!session.flushTimer) {
      session.flushTimer = setTimeout(flush, BATCH_INTERVAL);
    }
  });

  session.proc.onExit(({ exitCode, signal }) => {
    if (sessions.get(args.agentId) !== session) return;

    if (containerName) {
      console.warn(
        `[docker] container ${containerName} exited — code=${exitCode} signal=${signal ?? 'none'}`,
      );
    }

    flush();

    const tailBuf = Buffer.concat(tailChunks);
    const tailStr = tailBuf.toString('utf8');
    const lines = tailStr
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0)
      .slice(-MAX_LINES);

    send({
      type: 'Exit',
      data: {
        exit_code: exitCode,
        signal: signal !== undefined ? String(signal) : null,
        last_output: lines,
      },
    });

    emitPtyEvent('exit', args.agentId, { exitCode, signal });
    sessions.delete(args.agentId);
  });
}

export function spawnAgent(win: BrowserWindow, args: SpawnAgentArgs): void {
  const channelId = args.onOutput.__CHANNEL_ID__;
  const command = args.command || resolveUserShell();
  const cwd = args.cwd || process.env.HOME || '/';

  // A renderer reload while a Docker image pull is in flight has no live
  // session to reattach to. Abort the stale pull (it resumes from cache next
  // time) so its captured old channel goes silent, then fall through to a
  // fresh spawn on the new channel.
  if (args.attachExisting) {
    const inflightPull = pendingPulls.get(args.agentId);
    if (inflightPull) {
      inflightPull.abort();
      pendingPulls.delete(args.agentId);
    }
  }

  // Renderer reloads should reattach to still-running PTYs before validating
  // the launch command. The process already exists; a missing binary after
  // reload should not strand the live session on the old renderer channel.
  const existing = sessions.get(args.agentId);
  if (existing && args.attachExisting) {
    existing.channelId = channelId;
    existing.taskId = args.taskId;
    existing.isShell = args.isShell ?? existing.isShell;
    existing.proc.resume();
    if (args.cols > 0 && args.rows > 0) {
      existing.proc.resize(args.cols, args.rows);
    }
    const scrollback = existing.scrollback.toBase64();
    if (scrollback) {
      sendToChannel(win, channelId, { type: 'Data', data: scrollback });
    }
    emitPtyEvent('spawn', args.agentId);
    return;
  }

  // Reject commands with shell metacharacters (node-pty uses execvp, but
  // guard against accidental misuse). Allow bare names (resolved via PATH)
  // and absolute paths.
  if (/[;&|`$(){}\n]/.test(command)) {
    throw new Error(`Command contains disallowed characters: ${command}`);
  }

  // In Docker mode, we validate `docker` exists rather than the inner command
  if (!args.dockerMode) {
    validateCommand(command);
  } else {
    validateCommand('docker');
  }

  cleanupExistingSession(args.agentId, existing);

  const filteredEnv = copyProcessEnv();
  const spawnEnv = buildPtySpawnEnv(args.env);

  // Backfill sandbox placeholders for pre-existing worktrees (and anywhere
  // Claude Code may launch). See ensureClaudeSandboxFiles for the why.
  if (!args.dockerMode && fs.existsSync(cwd)) {
    ensureClaudeSandboxFiles(cwd);
    ensureSandboxExcludes(cwd);
  }

  const spawnSpec = buildPtySpawnSpec(args, command, cwd, spawnEnv, filteredEnv);

  const resolvedImage = args.dockerImage || DOCKER_DEFAULT_IMAGE;

  const launch = () => {
    // Design B gsd seed: stage the baked skeleton once per image-id and mount it
    // read-only at /opt/forge-skel for the entrypoint to cp -an into HOME. Done
    // here (not at argv-build time) because the image is guaranteed present by the
    // time launch() runs — the fast-path cache, post-pull, and fallback all funnel
    // through launch(), so this single insertion covers every spawn path.
    let finalArgs = spawnSpec.spawnArgs;
    if (args.dockerMode) {
      const skelDir = ensureGsdSkeleton(resolvedImage);
      if (skelDir) {
        // Insert the read-only skeleton mount before the image positional so
        // docker parses it as a flag (a `-v` after the image is command args).
        const imageIdx = spawnSpec.spawnArgs.indexOf(resolvedImage);
        const insertAt = imageIdx >= 0 ? imageIdx : spawnSpec.spawnArgs.length;
        finalArgs = [
          ...spawnSpec.spawnArgs.slice(0, insertAt),
          '-v',
          `${skelDir}:${FORGE_SKEL_MOUNT}:ro`,
          ...spawnSpec.spawnArgs.slice(insertAt),
        ];
      }
    }

    logDebug('pty', `spawn command ${args.agentId}`, {
      taskId: args.taskId,
      command: spawnSpec.spawnCommand,
      args: redactedSpawnArgs(spawnSpec.spawnCommand, finalArgs),
      cwd,
      dockerMode: args.dockerMode === true,
    });

    const proc = pty.spawn(spawnSpec.spawnCommand, finalArgs, {
      name: 'xterm-256color',
      cols: args.cols,
      rows: args.rows,
      cwd: spawnSpec.cwd,
      env: spawnSpec.env,
    });

    const session: PtySession = {
      proc,
      channelId,
      taskId: args.taskId,
      agentId: args.agentId,
      isShell: args.isShell ?? false,
      flushTimer: null,
      subscribers: new Set(),
      scrollback: new RingBuffer(),
      containerName: spawnSpec.containerName,
    };
    sessions.set(args.agentId, session);
    attachPtyOutputHandlers(win, session, args, command);

    emitPtyEvent('spawn', args.agentId);
  };

  // Non-Docker tasks (and locally-built project images) spawn immediately.
  // Registry images get a resilient pre-pull so a transient Docker Hub blip
  // doesn't hard-fail the task with a cryptic `docker run` daemon error.
  if (args.dockerMode && !resolvedImage.startsWith(PROJECT_IMAGE_PREFIX)) {
    // Fast path: a cached image spawns synchronously (no async tick) — this is
    // the common case and keeps task launch snappy.
    if (knownPresentImages.has(resolvedImage) || dockerImagePresentSync(resolvedImage)) {
      knownPresentImages.add(resolvedImage);
      launch();
      return;
    }
    const ac = new AbortController();
    pendingPulls.set(args.agentId, ac);
    const cleanup = () => {
      if (pendingPulls.get(args.agentId) === ac) pendingPulls.delete(args.agentId);
    };
    const sendData = (text: string) =>
      sendToChannel(win, channelId, {
        type: 'Data',
        data: Buffer.from(text, 'utf8').toString('base64'),
      });
    void (async () => {
      try {
        const isDefaultImage = resolvedImage === DOCKER_DEFAULT_IMAGE;
        const res = await acquireAgentImage(resolvedImage, {
          imagePresent: dockerImagePresentByTag,
          pull: (img, signal) => pullDockerImage(img, sendData, signal),
          delay: abortableDelay,
          onStatus: (line) => sendData(`\x1b[2m[docker] ${line}\x1b[0m\r\n`),
          signal: ac.signal,
          // Default image only: when a registry is unreachable (e.g. the daemon's VM
          // has no egress), fetch the image host-side from the GitHub release and
          // `docker load` it; local build is the final rung.
          downloadRelease: isDefaultImage
            ? (signal) => fetchDefaultImageFromRelease(sendData, signal)
            : undefined,
          localBuild: isDefaultImage
            ? (signal) => runDefaultImageBuild(sendData, signal)
            : undefined,
        });
        // Killed or superseded by a reattach — another path owns the lifecycle.
        if (ac.signal.aborted || (!res.ok && res.reason === 'cancelled')) {
          cleanup();
          return;
        }
        if (!res.ok) {
          cleanup();
          const tried = isDefaultImage
            ? 'registry pull, GitHub release download, and local build'
            : 'registry pull';
          sendData(
            `\r\n\x1b[31m[docker] Could not obtain ${resolvedImage}.\x1b[0m\r\n` +
              `\x1b[2m[docker] Tried: ${tried}.\r\n` +
              `[docker] If Docker runs in a VM (Colima/Lima/Docker Desktop), a VPN can leave the VM\r\n` +
              `[docker] unable to reach the internet even when the host can. Try restarting the Docker\r\n` +
              `[docker] VM (e.g. \`colima restart\`) or reconnecting the network, then retry.\x1b[0m\r\n`,
          );
          sendToChannel(win, channelId, {
            type: 'Exit',
            data: {
              exit_code: 1,
              signal: null,
              last_output: [`Failed to pull Docker image ${resolvedImage}`],
            },
          });
          emitPtyEvent('exit', args.agentId, { exitCode: 1, signal: undefined });
          return;
        }
        knownPresentImages.add(resolvedImage);
        launch();
        cleanup();
      } catch (err) {
        cleanup();
        sendData(`\r\n\x1b[31m[docker] Error preparing image: ${String(err)}\x1b[0m\r\n`);
        sendToChannel(win, channelId, {
          type: 'Exit',
          data: { exit_code: 1, signal: null, last_output: [] },
        });
        emitPtyEvent('exit', args.agentId, { exitCode: 1, signal: undefined });
      }
    })();
    return;
  }

  launch();
}

export function writeToAgent(agentId: string, data: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.write(data);
}

export function resizeAgent(agentId: string, cols: number, rows: number): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.resize(cols, rows);
}

export function pauseAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.pause();
}

export function resumeAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (!session) throw new Error(`Agent not found: ${agentId}`);
  session.proc.resume();
}

export function killAgent(agentId: string): void {
  const session = sessions.get(agentId);
  if (session) {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    // Clear subscribers before kill so the onExit flush doesn't
    // notify stale listeners. Let onExit handle sessions.delete
    // and emitPtyEvent to avoid the race condition.
    session.subscribers.clear();
    // Stop the Docker container first so it doesn't keep running after the
    // local PTY process (docker run) is killed. Fire-and-forget; the PTY kill
    // below is the authoritative termination signal.
    if (session.containerName) {
      stopDockerContainer(session.containerName);
    }
    session.proc.kill();
    return;
  }
  // No live session — a Docker image pull may still be in flight; abort it so
  // it doesn't launch a container for a task the user already killed.
  const pendingPull = pendingPulls.get(agentId);
  if (pendingPull) {
    pendingPull.abort();
    pendingPulls.delete(agentId);
  }
}

export function countRunningAgents(): number {
  return sessions.size;
}

export function killAllAgents(): void {
  for (const ac of pendingPulls.values()) ac.abort();
  pendingPulls.clear();
  for (const [, session] of sessions) {
    if (session.flushTimer) clearTimeout(session.flushTimer);
    session.subscribers.clear();
    if (session.containerName) {
      // Use synchronous docker kill with a short timeout so containers are
      // terminated before the Electron process exits. Errors are ignored
      // (container may already be gone).
      try {
        execFileSync('docker', ['kill', session.containerName], { timeout: 3000, stdio: 'pipe' });
      } catch {
        // Intentionally ignore: container may not exist or may have already stopped.
      }
    }
    session.proc.kill();
    // Best-effort quit-time GC of this live agent's persistent host HOME.
    cleanupAgentHome(session.agentId);
  }
  // Let onExit handlers clean up sessions individually
}

// --- Subscriber helpers for remote access ---

/** Subscribe to live base64-encoded output from an agent. */
export function subscribeToAgent(agentId: string, cb: (encoded: string) => void): boolean {
  const session = sessions.get(agentId);
  if (!session) return false;
  session.subscribers.add(cb);
  return true;
}

/** Remove a previously registered output subscriber. */
export function unsubscribeFromAgent(agentId: string, cb: (encoded: string) => void): void {
  sessions.get(agentId)?.subscribers.delete(cb);
}

/** Get the scrollback buffer for an agent as a base64 string. */
export function getAgentScrollback(agentId: string): string | null {
  return sessions.get(agentId)?.scrollback.toBase64() ?? null;
}

/** Return all active agent IDs. */
export function getActiveAgentIds(): string[] {
  return Array.from(sessions.keys());
}

/** Return metadata for a specific agent, or null if not found. */
export function getAgentMeta(
  agentId: string,
): { taskId: string; agentId: string; isShell: boolean } | null {
  const s = sessions.get(agentId);
  return s ? { taskId: s.taskId, agentId: s.agentId, isShell: s.isShell } : null;
}

/** Return the current column width of an agent's PTY. */
export function getAgentCols(agentId: string): number {
  const s = sessions.get(agentId);
  return s ? s.proc.cols : 80;
}

// --- Docker mode helpers ---

/**
 * Host directory that backs a single agent's container HOME.
 *
 * Created by spawnAgent as the run-user and bind-mounted to
 * DOCKER_CONTAINER_HOME. Lives under ~/.forge (inside the Colima-shared /Users
 * tree) and is keyed on the stable agentId so reattach/respawn reuse it. Single
 * source of the path convention so the spawn and cleanup paths never diverge.
 */
export function agentHomeDir(agentId: string): string {
  return path.join(process.env.HOME ?? '', '.forge', 'agent-homes', agentId);
}

/**
 * Remove an agent's persistent host HOME dir. Best-effort: a missing dir is
 * fine and any error is swallowed so cleanup never blocks task deletion/quit.
 * Not called on container exit — reattach relies on the HOME surviving.
 */
export function cleanupAgentHome(agentId: string): void {
  try {
    fs.rmSync(agentHomeDir(agentId), { recursive: true, force: true });
  } catch {
    // Ignore: dir may not exist or may have already been removed.
  }
}

/**
 * Env vars that are desktop/host-specific and must NOT be forwarded into the
 * container. Everything else is forwarded so agents can use arbitrary vars
 * (custom API keys, feature flags, tool config, etc.) without needing an
 * ever-growing allowlist.
 */

const DOCKER_ENV_BLOCK_LIST = new Set([
  // Host PATH must not override the container's PATH — agent CLIs like
  // `claude` are installed at /usr/local/bin inside the image and won't be
  // found if the host PATH (pointing at host-only dirs) is forwarded.
  'PATH',
  // Host HOME points to a non-writable directory inside the container when we
  // run as the host user's uid/gid. Agents need a writable HOME for config
  // files, so Docker mode sets HOME to DOCKER_CONTAINER_HOME — a bind-mounted,
  // user-owned host dir — explicitly.
  'HOME',
  // Display / desktop session
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DBUS_SYSTEM_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'XDG_CURRENT_DESKTOP',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_CLASS',
  'XDG_SESSION_ID',
  'XDG_SESSION_TYPE',
  'XDG_VTNR',
  'WINDOWID',
  'XAUTHORITY',
  // Electron / Node host internals
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  // Host-specific paths / linker
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  // Session / PAM
  'LOGNAME',
  'MAIL',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  // Active Claude Code session markers (prevent nested session confusion)
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  // SSH / GPG / k8s — agent sockets and credentials must not leak into container
  'SSH_AUTH_SOCK',
  'GPG_AGENT_INFO',
  'KUBECONFIG',
  // macOS-specific temp dir (/var/folders/…) does not exist in Linux containers.
  // Shell init scripts and tools that use $TMPDIR will fail to mkdir on Linux.
  'TMPDIR',
  'TEMPDIR',
  'TMP',
  'TEMP',
]);

/** Returns true for env var names that should be blocked from Docker forwarding. */
function isBlockedDockerEnvKey(key: string): boolean {
  if (DOCKER_ENV_BLOCK_LIST.has(key)) return true;
  // Block all remaining XDG_* vars not explicitly listed above
  if (key.startsWith('XDG_')) return true;
  // Block all ELECTRON_* vars not explicitly listed above
  if (key.startsWith('ELECTRON_')) return true;
  // Block all SUDO_* vars (e.g. SUDO_USER, SUDO_UID) — host privilege context
  if (key.startsWith('SUDO_')) return true;
  return false;
}

function buildDockerEnvFlags(env: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isBlockedDockerEnvKey(key) && value !== undefined) {
      flags.push('-e', `${key}=${value}`);
    }
  }
  return flags;
}

// Config directories each agent CLI uses for auth/settings, relative to HOME.
const AGENT_CONFIG_DIRS: Record<string, string[]> = {
  claude: ['.claude'],
  codex: ['.codex'],
  gemini: ['.gemini'],
  opencode: ['.config/opencode'],
  copilot: ['.config/github-copilot'],
  agy: ['.gemini/antigravity-cli'],
};

// Config files (not directories) each agent CLI uses for auth, relative to HOME.
const AGENT_CONFIG_FILES: Record<string, string[]> = {
  claude: ['.claude.json'],
};

function seedClaudeProjectTrust(hostFile: string, worktreePath: string): void {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(hostFile) && fs.statSync(hostFile).size > 0) {
    try {
      config = JSON.parse(fs.readFileSync(hostFile, 'utf8')) as Record<string, unknown>;
    } catch {
      console.warn(`[docker-auth] Could not parse ${hostFile}, skipping Claude trust seed`);
      return;
    }
  }

  const projects =
    config.projects && typeof config.projects === 'object' && !Array.isArray(config.projects)
      ? (config.projects as Record<string, Record<string, unknown>>)
      : {};
  const existing =
    projects[worktreePath] &&
    typeof projects[worktreePath] === 'object' &&
    !Array.isArray(projects[worktreePath])
      ? projects[worktreePath]
      : {};

  projects[worktreePath] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  config.projects = projects;

  // Atomic write: write to a temp file first, then rename over the original.
  // rename() is atomic on POSIX filesystems, so concurrent spawns won't corrupt
  // each other's data even if both read before either writes.
  const tmpFile = `${hostFile}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmpFile, hostFile);
}

function buildDockerCredentialMounts(
  agentCommand: string,
  shareAgentAuth: boolean,
  worktreePath: string,
  containerHome: string,
): string[] {
  const mounts: string[] = [];
  const home = process.env.HOME;
  if (!home) return mounts;

  /** Mount a host path read-only into the container home. Skips if absent. */
  const mountIfExists = (hostPath: string, containerPath: string): void => {
    try {
      fs.accessSync(hostPath, fs.constants.R_OK);
      mounts.push('-v', `${hostPath}:${containerPath}:ro`);
    } catch {
      // Path absent or unreadable — skip
    }
  };

  // SSH keys for git push/pull
  mountIfExists(`${home}/.ssh`, `${containerHome}/.ssh`);

  // Git identity / config
  mountIfExists(`${home}/.gitconfig`, `${containerHome}/.gitconfig`);

  // GitHub CLI auth tokens (~/.config/gh/)
  mountIfExists(`${home}/.config/gh`, `${containerHome}/.config/gh`);

  // npm auth token
  mountIfExists(`${home}/.npmrc`, `${containerHome}/.npmrc`);

  // General HTTP/git HTTPS credentials (used by git credential helper)
  mountIfExists(`${home}/.netrc`, `${containerHome}/.netrc`);

  // Google Application Credentials file (for Vertex AI / gcloud) — mounted
  // at its original path since the env var points there.
  const googleCredsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCredsFile) {
    mountIfExists(googleCredsFile, googleCredsFile);
  }

  // When "Share agent auth across Linux containers" is enabled, bind-mount a
  // host directory (created here, owned by the current user) into the agent's
  // config location inside the container. Using a host directory avoids the
  // root-ownership problem of Docker named volumes: the directory is created
  // by this process (running as the user), so the containerised agent can
  // write credentials on first login and read them on subsequent runs.
  if (shareAgentAuth) {
    const baseCommand = path.basename(agentCommand);
    for (const relDir of AGENT_CONFIG_DIRS[baseCommand] ?? []) {
      const hostDir = path.join(home, '.forge', 'agent-auth', baseCommand, relDir);
      try {
        fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
        mounts.push('-v', `${hostDir}:${containerHome}/${relDir}`);
      } catch {
        console.warn(`[docker-auth] Could not create host auth dir ${hostDir}, skipping mount`);
      }
    }
    for (const relFile of AGENT_CONFIG_FILES[baseCommand] ?? []) {
      const hostFile = path.join(home, '.forge', 'agent-auth', baseCommand, relFile);
      try {
        const hostDir = path.dirname(hostFile);
        fs.mkdirSync(hostDir, { recursive: true, mode: 0o700 });
        if (!fs.existsSync(hostFile) || fs.statSync(hostFile).size === 0) {
          fs.writeFileSync(hostFile, '{}', { mode: 0o600 });
        }
        if (baseCommand === 'claude' && relFile === '.claude.json') {
          seedClaudeProjectTrust(hostFile, worktreePath);
        }
        mounts.push('-v', `${hostFile}:${containerHome}/${relFile}`);
      } catch {
        console.warn(`[docker-auth] Could not create host auth file ${hostFile}, skipping mount`);
      }
    }
  }

  return mounts;
}

/**
 * Asynchronously stop a Docker container by name. Fire-and-forget — errors are
 * silently swallowed because the container may have already exited by the time
 * this is called.
 */
function stopDockerContainer(name: string): void {
  execFile('docker', ['stop', name], { timeout: 10_000 }, () => {
    // Intentionally ignore errors: container may not exist or may have already stopped.
  });
}

/** Check if Docker is available on the system. */
export async function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('docker', ['info'], { encoding: 'utf8', timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

/** The default image name for Docker-isolated tasks. */
export const DOCKER_DEFAULT_IMAGE = 'thunderockforge/forge-agent:latest';

/** Label key used to stamp the Dockerfile content hash on built images. */
const DOCKERFILE_HASH_LABEL = 'forge-dockerfile-hash';

/**
 * Resolve the path to the bundled Dockerfile.
 * In dev mode it lives at `<repo>/docker/Dockerfile`;
 * in production it's inside the asar resources directory.
 */
function resolveDockerfilePath(): string | null {
  const devDockerDir = path.join(__dirname, '..', '..', 'docker');
  const prodDockerDir = path.join(process.resourcesPath ?? '', 'docker');
  const dockerDir = fs.existsSync(path.join(devDockerDir, 'Dockerfile'))
    ? devDockerDir
    : prodDockerDir;
  const p = path.join(dockerDir, 'Dockerfile');
  return fs.existsSync(p) ? p : null;
}

/** SHA-256 hex digest of an arbitrary Dockerfile, or null if unreadable. */
export function hashDockerfile(dockerfilePath: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(dockerfilePath)).digest('hex');
  } catch {
    return null;
  }
}

/** SHA-256 hex digest of the bundled Dockerfile, or null if not found. */
function getDockerfileHash(): string | null {
  const p = resolveDockerfilePath();
  if (!p) return null;
  return hashDockerfile(p);
}

/**
 * Check if a project has a local Dockerfile at .forge/Dockerfile.
 * Returns the absolute path if found, null otherwise.
 */
export function resolveProjectDockerfile(projectRoot: string): string | null {
  const p = path.join(projectRoot, '.forge', 'Dockerfile');
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Derive a deterministic image tag for a project Dockerfile.
 * Tag format: forge-project:<first-12-of-sha256>
 */
export function projectImageTag(dockerfilePath: string): string {
  const hash = hashDockerfile(dockerfilePath);
  return `forge-project:${(hash ?? 'unknown').slice(0, 12)}`;
}

/**
 * Check if a Docker image exists locally **and** matches the current Dockerfile.
 * Returns false when the image is missing or was built from a different Dockerfile,
 * so the UI will prompt the user to (re)build.
 *
 * When `opts.dockerfilePath` is provided, hash that file for the staleness check.
 * When the image is not the default and no `dockerfilePath` is given, skip the hash
 * check entirely (just verify the image exists).
 */
export async function dockerImageExists(
  image: string,
  opts?: { dockerfilePath?: string },
): Promise<boolean> {
  const customPath = opts?.dockerfilePath;
  const expectedHash = customPath
    ? hashDockerfile(customPath)
    : image === DOCKER_DEFAULT_IMAGE
      ? getDockerfileHash()
      : null;

  if (customPath && !expectedHash) {
    return false;
  }

  // Docker Desktop's containerd image store breaks `docker image inspect <tag>` —
  // tag-based inspection fails even when the image exists. Work around by fetching
  // the image ID via `docker image ls --filter` first, then inspecting by ID.
  const imageId = await new Promise<string | null>((resolve) => {
    execFile(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });

  if (!imageId) return false;
  if (!expectedHash) return true;

  return new Promise((resolve) => {
    execFile(
      'docker',
      ['inspect', '--format', `{{index .Config.Labels "${DOCKERFILE_HASH_LABEL}"}}`, imageId],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => resolve(!err && stdout.trim() === expectedHash),
    );
  });
}

/** Deduplicates concurrent calls to buildDockerImage. Null when no build is in progress. */
let activeBuild: Promise<{ ok: boolean; error?: string }> | null = null;

/**
 * Build a Dockerfile into a Docker image.
 * Streams build output to the renderer via an IPC channel so the user can see progress.
 * Returns a promise that resolves on success, rejects on failure.
 *
 * When no `opts` are given, builds the bundled Dockerfile into the default image
 * (backward compatible). Concurrent calls for the default image share the same
 * in-flight promise; custom builds are never deduplicated.
 */
export function buildDockerImage(
  win: BrowserWindow,
  onOutputChannel: string,
  opts?: { dockerfilePath?: string; buildContext?: string; imageTag?: string },
): Promise<{ ok: boolean; error?: string }> {
  const isDefaultBuild = !opts?.dockerfilePath && !opts?.buildContext && !opts?.imageTag;

  // Only dedup when building the default image
  if (isDefaultBuild && activeBuild !== null) {
    return activeBuild;
  }

  const buildPromise = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const finish = (result: { ok: boolean; error?: string }) => {
      if (isDefaultBuild) {
        activeBuild = null;
      }
      resolve(result);
    };

    const resolvedDockerfilePath = opts?.dockerfilePath ?? resolveDockerfilePath();
    if (!resolvedDockerfilePath) {
      finish({ ok: false, error: 'Dockerfile not found' });
      return;
    }
    const buildContext = opts?.buildContext ?? path.dirname(resolvedDockerfilePath);
    const hash = hashDockerfile(resolvedDockerfilePath) ?? 'unknown';
    const imageTag = opts?.imageTag ?? DOCKER_DEFAULT_IMAGE;

    const send = (text: string) => {
      if (!win.isDestroyed()) {
        win.webContents.send(onOutputChannel, text);
      }
    };

    const proc = cpSpawn(
      'docker',
      [
        'build',
        '-t',
        imageTag,
        '--label',
        `${DOCKERFILE_HASH_LABEL}=${hash}`,
        '-f',
        resolvedDockerfilePath,
        buildContext,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    proc.stdout?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));
    proc.stderr?.on('data', (chunk: Buffer) => send(chunk.toString('utf8')));

    proc.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: `docker build exited with code ${code}` });
      }
    });
  });

  if (isDefaultBuild) {
    activeBuild = buildPromise;
  }

  return buildPromise;
}

/**
 * Fetch the default agent image host-side from the GitHub release and `docker load`
 * it into the daemon. Used when a registry pull fails because the daemon (often a
 * Colima/Lima VM) has no internet egress but the host does. Streams to the terminal.
 */
async function fetchDefaultImageFromRelease(
  sendData: (text: string) => void,
  signal: AbortSignal,
): Promise<boolean> {
  const arch = hostImageArch();
  if (!arch) {
    sendData(
      `\x1b[2m[docker] No prebuilt agent image for this architecture (${process.arch}).\x1b[0m\r\n`,
    );
    return false;
  }
  let version = '';
  try {
    const { app } = await import('electron');
    version = app.getVersion();
  } catch {
    // Dev/test without an Electron runtime — fall back to the repo's latest release.
  }
  return downloadAndLoadReleaseImage(
    { owner: 'thunderock', repo: 'forge', version, arch },
    (line) => sendData(`\x1b[2m[docker] ${line}\x1b[0m\r\n`),
    signal,
  );
}

/** Build the bundled Dockerfile into the default image, streaming to the terminal. */
function runDefaultImageBuild(
  sendData: (text: string) => void,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    const dockerfile = resolveDockerfilePath();
    if (!dockerfile) {
      sendData(`\x1b[2m[docker] Bundled Dockerfile not found; cannot build locally.\x1b[0m\r\n`);
      return resolve(false);
    }
    const hash = hashDockerfile(dockerfile) ?? 'unknown';
    const proc = cpSpawn(
      'docker',
      [
        'build',
        '-t',
        DOCKER_DEFAULT_IMAGE,
        '--label',
        `${DOCKERFILE_HASH_LABEL}=${hash}`,
        '-f',
        dockerfile,
        path.dirname(dockerfile),
      ],
      { signal },
    );
    proc.stdout?.on('data', (d: Buffer) => sendData(d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => sendData(d.toString('utf8')));
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}
