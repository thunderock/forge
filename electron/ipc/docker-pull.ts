import { execFile, execFileSync, spawn as cpSpawn } from 'child_process';

/** Project images are built locally (forge-project:<hash>), never pulled from a registry. */
export const PROJECT_IMAGE_PREFIX = 'forge-project:';

interface EnsureImageDeps {
  /** Resolve true if an image with this tag is already present locally. */
  imagePresent: (image: string) => Promise<boolean>;
  /** Pull the image; resolve with the process exit code (0 = success). */
  pull: (image: string, signal: AbortSignal) => Promise<number>;
  /** Abortable sleep. */
  delay: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Emit a human-friendly status line to the terminal. */
  onStatus: (line: string) => void;
  signal: AbortSignal;
}

interface EnsureImageOptions {
  maxAttempts?: number;
  /** Backoff before retry N (index 0 = wait before 2nd attempt). Last value reused. */
  backoffMs?: number[];
}

export type EnsureImageResult =
  | { ok: true; usedLocal: boolean }
  | { ok: false; reason: 'cancelled' | 'pull-failed' };

/**
 * Ensure a registry image is available locally before `docker run`.
 *
 * Fast-paths when the image is already cached (no network). Otherwise pulls with
 * bounded retries + backoff so a transient Docker Hub blip doesn't hard-fail the
 * task, and falls back to any locally cached copy before giving up.
 */
export async function ensureDockerImageAvailable(
  image: string,
  deps: EnsureImageDeps,
  opts: EnsureImageOptions = {},
): Promise<EnsureImageResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoffMs ?? [2000, 4000];

  if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };

  // Already cached — `docker run` will use it, no network round-trip needed.
  if (await deps.imagePresent(image)) return { ok: true, usedLocal: true };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    deps.onStatus(
      attempt === 1
        ? `Pulling ${image} … (first run can take a few minutes)`
        : `Retrying pull (attempt ${attempt}/${maxAttempts}) …`,
    );

    const code = await deps.pull(image, deps.signal).catch(() => -1);
    if (deps.signal.aborted) return { ok: false, reason: 'cancelled' };
    if (code === 0) return { ok: true, usedLocal: false };

    if (attempt < maxAttempts) {
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)];
      deps.onStatus(`Pull failed — retrying in ${Math.round(wait / 1000)}s …`);
      await deps.delay(wait, deps.signal);
    }
  }

  // Retries exhausted — use any locally cached copy rather than fail outright
  // (e.g. a concurrent pull landed it, or an older image is good enough).
  if (await deps.imagePresent(image)) return { ok: true, usedLocal: true };

  return { ok: false, reason: 'pull-failed' };
}

/**
 * Synchronous existence check, used on the spawn fast-path so a cached image
 * still launches without deferring to an async tick. Bounded timeout; treats
 * any failure (incl. a hung daemon) as "not present" so we fall back to a pull.
 */
export function dockerImagePresentSync(image: string): boolean {
  try {
    const out = execFileSync(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return !!out.trim();
  } catch {
    return false;
  }
}

/** True if an image with this tag exists locally (existence only — no staleness check). */
export function dockerImagePresentByTag(image: string): Promise<boolean> {
  return new Promise((resolve) => {
    // `docker image ls --filter reference=` works around the containerd store
    // breaking tag-based `docker image inspect`.
    execFile(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 5000 },
      (err, stdout) => resolve(!err && !!String(stdout).trim()),
    );
  });
}

/** Stream `docker pull <image>` output to `onData`; resolve with the exit code (-1 on spawn error/abort). */
export function pullDockerImage(
  image: string,
  onData: (text: string) => void,
  signal: AbortSignal,
): Promise<number> {
  return new Promise((resolve) => {
    const child = cpSpawn('docker', ['pull', image], { signal });
    child.stdout?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.stderr?.on('data', (d: Buffer) => onData(d.toString('utf8')));
    child.on('error', () => resolve(-1)); // includes AbortError when signal fires
    child.on('close', (code) => resolve(code ?? -1));
  });
}

/** Promise that resolves after `ms`, or immediately if the signal aborts. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
