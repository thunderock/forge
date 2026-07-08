import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Shared, dependency-light Docker gsd-seed surface — the single source of truth.
 *
 * The load-bearing runtime-seeding facts (the container HOME, the read-only
 * skeleton mount path, the exact entrypoint bootstrap string, and the root-staging
 * one-shot) live HERE rather than inline in pty.ts, so production (spawnAgent) and
 * the Phase 3 in-container check import the SAME constants and cannot drift — the
 * exact class of silent blind spot Phase 3 exists to prevent (RESEARCH § "The DRY
 * Seam", Pitfall 5).
 *
 * This module imports ONLY node builtins (fs / path / child_process / process): no
 * Electron, no node-pty, no logger — so a plain vitest file (or a compiled node
 * script) can import it without pulling in the whole PTY/Electron stack.
 */

/**
 * Fixed container path for every agent's writable HOME.
 *
 * Docker tasks run as the host user's uid/gid so files created in the mounted
 * project worktree stay owned by the host user. On macOS that is often 501:20,
 * which cannot write to (nor even traverse the 0750) image-owned /home/agent
 * directory — and codex refuses a HOME under /tmp. So instead of /tmp we
 * bind-mount a per-agent host dir the run-user created (see spawnAgent) onto
 * this fixed path, keeping HOME writable under --user. (The baked gsd skeleton
 * also lives under the unreadable /home/agent, so it is staged out to a
 * run-user-readable /opt/forge-skel mount — see ensureGsdSkeleton.)
 *
 * The path is FIXED (shared across agents), not per-agent: each container has
 * its own mount namespace, so isolation comes from the unique host SOURCE dir,
 * not the container path. A fixed path also avoids leaking host FS layout and
 * keeps every credential mount at a stable, same-across-agents location.
 */
export const DOCKER_CONTAINER_HOME = '/home/forge';

/**
 * Read-only in-container mount point for the staged gsd skeleton (Design B).
 *
 * The entrypoint cp -an's from here into HOME; ensureGsdSkeleton stages the
 * run-user-owned host dir that backs this mount. Named constant so the seed
 * string (GSD_SEED_ENTRYPOINT) and the mount splice in spawnAgent share ONE
 * path and can never diverge.
 */
export const FORGE_SKEL_MOUNT = '/opt/forge-skel';

/**
 * The exact in-container bootstrap spawnAgent runs before exec'ing the agent
 * command (Design B seed). Single source of truth: pty.ts references this
 * constant, so the Phase 3 check runs the byte-identical string.
 *
 * Seeds the per-agent HOME from the read-only gsd skeleton staged at
 * FORGE_SKEL_MOUNT (the image's own /home/agent is 0750/uid-1000 and unreadable
 * by the run-user). cp -an is no-clobber so a shared-auth .claude bind mount keeps
 * its credentials, and the seed runs IN-CONTAINER after mounts so that mount is
 * not shadowed (RESEARCH Pitfall 3). Failures SURFACE (DOCK-04): an unwritable
 * HOME is FATAL (exit 1); a cp miss WARNs and continues (an empty skel dir must
 * still let the agent run). Byte-identical to the previous pty.ts inline literal.
 */
export const GSD_SEED_ENTRYPOINT =
  'mkdir -p "$HOME/.claude" "$HOME/.gsd" "$HOME/.codex" || { echo "[forge] FATAL: HOME not writable ($HOME)" >&2; exit 1; }; ' +
  `cp -an ${FORGE_SKEL_MOUNT}/.claude/. "$HOME/.claude/" || echo "[forge] WARN: gsd .claude seed failed" >&2; ` +
  `cp -an ${FORGE_SKEL_MOUNT}/.gsd/. "$HOME/.gsd/" || echo "[forge] WARN: gsd .gsd seed failed" >&2; ` +
  `cp -an ${FORGE_SKEL_MOUNT}/.codex/. "$HOME/.codex/" || echo "[forge] WARN: gsd .codex seed failed" >&2; ` +
  'exec "$@"';

/**
 * Resolved image-id → staged gsd-skeleton host dir. Guards the Design B root
 * staging one-shot so it runs at most once per image per session (a new image =
 * a new id = a new dir; stale dirs are ignorable). See ensureGsdSkeleton.
 */
const stagedSkeletons = new Map<string, string>();

/**
 * Resolve an image's local image-id synchronously (trimmed), or null if absent.
 * Same `docker image ls --filter reference=<image> --format {{.ID}}` shape as
 * dockerImagePresentSync, but returns the id (the gsd-skeleton staging cache key)
 * instead of a boolean. Bounded timeout; any failure resolves to null.
 */
function resolveImageIdSync(image: string): string | null {
  try {
    const out = execFileSync(
      'docker',
      ['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return (
      out
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Stage the image's baked gsd skeleton (.claude + .gsd, baked under /home/agent)
 * into a run-user-owned host dir and return it for a read-only /opt/forge-skel
 * mount. Design B (RESEARCH "The Decision Point"): the image's /home/agent is mode
 * 0750 owned by uid 1000, so the macOS run-user (uid 501) cannot traverse it to cp
 * the skeleton directly. A throwaway --user 0:0 root container (root CAN traverse)
 * extracts the skeleton into ~/.forge/gsd-skeleton/<imageId> and chowns it to the
 * run-user; the agent entrypoint then cp -an's from the readable mount into HOME.
 *
 * Blocking one-shot, cached by resolved image-id: runs at most once per image per
 * session — a sub-second, image-present-gated extract, so there is no need to
 * defer launch() like the async pull path. Best-effort: a project/stale image with
 * no skeleton yields an empty dir (the entrypoint WARNs, non-fatal); a docker
 * failure warns and still returns the (possibly empty) dir so the agent launches.
 */
export function ensureGsdSkeleton(image: string): string | null {
  const imageId = resolveImageIdSync(image);
  if (!imageId) return null;

  const cached = stagedSkeletons.get(imageId);
  if (cached && fs.existsSync(cached)) return cached;

  const skelDir = path.join(process.env.HOME ?? '', '.forge', 'gsd-skeleton', imageId);

  // Cross-session cache: reuse a previously-staged, populated dir as-is.
  try {
    if (fs.readdirSync(skelDir).length > 0) {
      stagedSkeletons.set(imageId, skelDir);
      return skelDir;
    }
  } catch {
    // Missing/unreadable — fall through to (re)stage.
  }

  try {
    fs.mkdirSync(skelDir, { recursive: true });
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    // Root traverses the 0750 /home/agent fine; on virtiofs its writes map to the
    // host user, and the chown makes ownership correct on real Linux too. The
    // extract is best-effort (|| true) — a missing skeleton is non-fatal HERE;
    // surfacing the resulting empty seed is the ENTRYPOINT's job (DOCK-04).
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        '0:0',
        '-v',
        `${skelDir}:/out`,
        image,
        'sh',
        '-c',
        `cp -a /home/agent/.claude /home/agent/.gsd /home/agent/.codex /out/ 2>/dev/null || true; chown -R ${uid}:${gid} /out 2>/dev/null || true`,
      ],
      { timeout: 60_000, stdio: 'ignore' },
    );
  } catch (err) {
    console.warn(`[docker] gsd skeleton staging failed for ${image}: ${String(err)}`);
  }

  // Record even an empty dir so the root container never re-runs per agent.
  stagedSkeletons.set(imageId, skelDir);
  return skelDir;
}
