/**
 * Env-gated (RUN_GSD_DOCKER_TEST=1) in-container gsd-seeding regression check —
 * the load-bearing Phase 3 gate (RESEARCH § "The Central Design Decision").
 *
 * It exercises the REAL runtime seed path and asserts gsd is present in the
 * SEEDED HOME (/home/forge) — NOT the baked /home/agent — for BOTH Claude and
 * codex. It imports the shared seed surface (GSD_SEED_ENTRYPOINT, FORGE_SKEL_MOUNT,
 * DOCKER_CONTAINER_HOME, ensureGsdSkeleton) from ./docker-gsd-seed.js — the SAME
 * module spawnAgent uses — so it can never drift from production (Pitfall 5).
 *
 * It stages via the real ensureGsdSkeleton (the --user 0:0 root extract), mounts
 * it read-only at /opt/forge-skel, and runs the real GSD_SEED_ENTRYPOINT as a
 * NON-1000 uid (process.getuid(): CI=1001, dev=501) with HOME=/home/forge —
 * precisely the check that would have FAILED on the original silent bug (the baked
 * /home/agent existed the whole time; the runtime seed into the run-user HOME was
 * empty).
 *
 * No-egress (VER-02): it consumes an ALREADY-PRESENT image (FORGE_AGENT_IMAGE) and
 * never fetches one from a registry — if the image is absent it fails fast with a
 * clear message (build+load in CI, or `docker load` the release tarball). The
 * default `npm test` (no env var) COLLECTS this file but SPAWNS NO container: every
 * it() is gated behind describe.skip, exactly like coordinator-real-pty.
 *
 * HONESTY (RESEARCH Pitfall 3): file-presence is a NECESSARY PROXY for the Claude
 * /gsd-* and codex /prompts:gsd-* slash-commands, NOT proof they invoke live — that
 * needs an authed interactive CLI and remains a MANUAL deciding test (see
 * pty.test.ts). This check proves the seed LANDS the files in the run-user HOME,
 * not that the slash-commands execute. Ownership/uid is never asserted inside the
 * container (Colima virtiofs misreports it — Pitfall 2): only test/ls presence.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCKER_CONTAINER_HOME,
  FORGE_SKEL_MOUNT,
  GSD_SEED_ENTRYPOINT,
  ensureGsdSkeleton,
} from './docker-gsd-seed.js';

// Same gate shape as RUN_COORDINATOR_PTY_TEST: describe.skip unless opted in, so
// the default `npm test` collects the file but spawns no container (Pitfall 7).
const RUN = process.env.RUN_GSD_DOCKER_TEST === '1';
const describeDocker = RUN ? describe : describe.skip;

// Default equals DOCKER_DEFAULT_IMAGE (pty.ts). Hardcoded (not imported) so this
// file stays free of the Electron/node-pty stack.
const image = process.env.FORGE_AGENT_IMAGE ?? 'thunderockforge/forge-agent:latest';

// The VER-01 assertion block, run AS the "agent" (exec "$@") against the SEEDED
// $HOME=/home/forge. Verbatim from RESEARCH § "Exact File-Presence Assertions":
// set -e makes any miss (Claude OR codex) a non-zero exit; the GSD_SEED_OK sentinel
// (echoed last) proves the seed ran to completion, not a partial set -e abort.
const ASSERTION_BLOCK = [
  'set -e',
  'ls -d "$HOME"/.claude/skills/gsd-* >/dev/null', // Claude /gsd-* proxy (gsd-cc installs skills, not commands/gsd)
  'test -f "$HOME/.gsd/defaults.json"', // ~/.gsd/defaults.json (VER-01)
  'test "$(ls "$HOME"/.codex/prompts/gsd-*.md | wc -l)" -ge 20', // codex /prompts:gsd-* proxy
  'grep -q "\\[agents.gsd-" "$HOME/.codex/config.toml"', // codex agent registrations
  'ls -d "$HOME"/.codex/skills >/dev/null', // non-deprecated /prompts: fallback (OQ2)
  'test -d "$HOME/.codex/get-shit-done" || test -d "$HOME/.claude/get-shit-done"', // engine (OQ1)
  'echo GSD_SEED_OK',
].join('\n');

// Complementary BAKED sanity block (uid 1000 → ~ = /home/agent). NON-load-bearing:
// it reads the baked skeleton — the exact false-pass that shipped the bug — so it is
// a bake sanity net, not the regression gate. Mirrors docker-image.yml's baked block.
const BAKED_ASSERTION_BLOCK = [
  'set -e',
  'test "$(ls ~/.codex/prompts/gsd-*.md | wc -l)" -ge 20',
  'test -f ~/.codex/prompts/gsd-plan-phase.md',
  'grep -q "\\[agents.gsd-" ~/.codex/config.toml',
  'ls -d ~/.codex/agents ~/.codex/skills >/dev/null',
  'ls -d ~/.claude/skills/gsd-* >/dev/null', // Claude /gsd-* proxy (skills, not commands/gsd)
  'echo GSD_BAKE_OK',
].join('\n');

function imageMissingMessage(ref: string): string {
  return (
    `image "${ref}" is not present in the local docker daemon — build and ` +
    'load it in CI (build-push-action load: true, tags: forge-agent:ci) or run ' +
    '`docker load` on the release tarball from a networked host. The no-egress ' +
    'VM has no registry egress; this check consumes an already-present image and ' +
    'never fetches one.'
  );
}

// Local-only presence probe (never fetches from a registry) for the fast baked
// pre-check, which does not stage a skeleton. `docker image inspect` fails on an
// absent image WITHOUT reaching out — that is the VER-02 fail-fast.
function assertImagePresent(ref: string): void {
  try {
    execFileSync('docker', ['image', 'inspect', ref], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    throw new Error(imageMissingMessage(ref));
  }
}

function restoreHome(value: string | undefined): void {
  if (value === undefined) delete process.env.HOME;
  else process.env.HOME = value;
}

describeDocker('in-container gsd seeding (VER-01/VER-02)', () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
    restoreHome(originalHome);
  });

  it('Claude + codex gsd present in the SEEDED /home/forge (not /home/agent) (VER-01/VER-02)', () => {
    // Force a CLEAN skel stage (Pitfall 1 — a stale skel must not mask a broken
    // seed): ensureGsdSkeleton caches under $HOME/.forge/gsd-skeleton/<imageId>,
    // so point HOME at a fresh temp dir before staging, then restore it. The
    // image-id cache key already prevents cross-image reuse; the temp HOME
    // guarantees a clean stage per run.
    const stagingHome = mkdtempSync(join(tmpdir(), 'forge-gsd-staging-'));
    tempDirs.push(stagingHome);
    process.env.HOME = stagingHome;

    // Real --user 0:0 root extract of the baked skeleton (never fetches; returns
    // null iff the image is absent — that IS the VER-02 fail-fast).
    const skel = ensureGsdSkeleton(image);
    restoreHome(originalHome);
    if (!skel) throw new Error(imageMissingMessage(image));

    // Fresh /home/forge backing dir per run (Pitfall 1).
    const home = mkdtempSync(join(tmpdir(), 'forge-gsd-home-'));
    tempDirs.push(home);

    // Faithful reproduction of spawnAgent's Docker branch using the SHARED seed
    // surface — non-1000 uid, HOME=/home/forge, skel mounted read-only, real
    // entrypoint, then `exec "$@"` runs the assertion block as the "agent"
    // (sh -c ENTRY -- sh -c ASSERT: the `--` is $0, `sh -c ASSERT` is $@). A
    // broken seed → empty $HOME → set -e fails → non-zero exit → execFileSync
    // throws → the test fails (VER-01 non-zero-on-break).
    const out = execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '--user',
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '-v',
        `${home}:${DOCKER_CONTAINER_HOME}`,
        '-e',
        `HOME=${DOCKER_CONTAINER_HOME}`,
        '-v',
        `${skel}:${FORGE_SKEL_MOUNT}:ro`,
        image,
        'sh',
        '-c',
        GSD_SEED_ENTRYPOINT,
        '--',
        'sh',
        '-c',
        ASSERTION_BLOCK,
      ],
      { encoding: 'utf8' },
    );

    expect(out).toContain('GSD_SEED_OK');
  }, 120_000);

  it('baked skeleton sanity pre-check in /home/agent (NON-load-bearing — the known false-pass)', () => {
    // Fast bake sanity net ONLY: runs as uid 1000 so ~ = the baked /home/agent
    // skeleton. This is the exact false-pass that shipped the original bug (it
    // reads the baked dir, not the runtime-seeded HOME) — NOT the regression gate,
    // the runtime it() above is. It catches "the bake produced 0 prompts" (e.g. a
    // yanked gsd-codex-cli). Fail fast without fetching if the image is absent.
    assertImagePresent(image);
    const out = execFileSync(
      'docker',
      ['run', '--rm', '--user', '1000:1000', image, 'sh', '-c', BAKED_ASSERTION_BLOCK],
      { encoding: 'utf8' },
    );
    expect(out).toContain('GSD_BAKE_OK');
  }, 120_000);
});
