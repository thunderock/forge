import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePersonalitySeedDir } from './ipc/personalities.js';

interface PackageManifest {
  build?: {
    extraResources?: Array<{ from?: string; to?: string }>;
    linux?: { target?: string[] };
    mac?: { target?: string[] };
  };
}

const REPOSITORY_ROOT = path.join(__dirname, '..');
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, 'package.json');
const MAIN_PATH = path.join(REPOSITORY_ROOT, 'electron', 'main.ts');
const REGISTER_PATH = path.join(REPOSITORY_ROOT, 'electron', 'ipc', 'register.ts');
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe('D-08 explicit personality resource resolution', () => {
  it('uses process.resourcesPath layout for packaged launches regardless of cwd', () => {
    const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'personality-cwd-'));
    try {
      process.chdir(unrelatedCwd);
      expect(
        resolvePersonalitySeedDir({
          isPackaged: true,
          resourcesPath: path.join(path.sep, 'Applications', 'Forge.app', 'Contents', 'Resources'),
          mainModuleDir: path.join(path.sep, 'repo', 'dist-electron'),
        }),
      ).toBe(
        path.join(
          path.sep,
          'Applications',
          'Forge.app',
          'Contents',
          'Resources',
          'seeds',
          'personalities',
        ),
      );
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(unrelatedCwd, { recursive: true, force: true });
    }
  });

  it('uses the compiled main module directory for development regardless of cwd', () => {
    const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'personality-cwd-'));
    try {
      process.chdir(unrelatedCwd);
      expect(
        resolvePersonalitySeedDir({
          isPackaged: false,
          resourcesPath: path.join(path.sep, 'unused', 'resources'),
          mainModuleDir: path.join(path.sep, 'repo', 'dist-electron'),
        }),
      ).toBe(path.join(path.sep, 'repo', 'seeds', 'personalities'));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(unrelatedCwd, { recursive: true, force: true });
    }
  });
});

describe('D-05/D-11 packaged personality startup contract', () => {
  it('packages both personality seeds and the complete Apache license at exact destinations', () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as PackageManifest;
    const resources = manifest.build?.extraResources ?? [];

    expect(resources).toEqual(
      expect.arrayContaining([
        { from: 'seeds/personalities/', to: 'seeds/personalities/' },
        {
          from: 'LICENSES/open-code-review-Apache-2.0.txt',
          to: 'LICENSES/open-code-review-Apache-2.0.txt',
        },
      ]),
    );
  });

  it('retains the supported macOS and Linux package targets', () => {
    const manifest = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as PackageManifest;

    expect(manifest.build?.linux?.target).toEqual(['AppImage', 'deb']);
    expect(manifest.build?.mac?.target).toEqual(['dmg', 'zip']);
  });

  it('reconciles the getStateDir library synchronously inside whenReady before createWindow', () => {
    const main = fs.readFileSync(MAIN_PATH, 'utf8');
    const readyOffset = main.indexOf('app.whenReady().then(() => {');
    const seedOffset = main.indexOf('seedBuiltInPersonalities(', readyOffset);
    const windowOffset = main.indexOf('createWindow();', readyOffset);
    const startupBeforeWindow = main.slice(readyOffset, windowOffset);

    expect(readyOffset).toBeGreaterThanOrEqual(0);
    expect(seedOffset).toBeGreaterThan(readyOffset);
    expect(seedOffset).toBeLessThan(windowOffset);
    expect(main).toContain("path.join(getStateDir(), 'personalities')");
    expect(main).toContain('isPackaged: app.isPackaged');
    expect(main).toContain('resourcesPath: process.resourcesPath');
    expect(main).toContain('mainModuleDir: __dirname');
    expect(main).not.toContain('process.cwd()');
    expect(startupBeforeWindow).toMatch(
      /try\s*{[\s\S]*seedBuiltInPersonalities\([\s\S]*}\s*catch\s*\(/,
    );
    expect(startupBeforeWindow).toContain(
      "console.warn('[personalities] Seed reconciliation failed:'",
    );
  });
});

describe('RED: reset persistence contract', () => {
  it('composes one runtime path object for startup seeding and window handler registration', () => {
    const main = fs.readFileSync(MAIN_PATH, 'utf8');
    const readyOffset = main.indexOf('app.whenReady().then(() => {');
    const readySource = main.slice(readyOffset);

    expect(readyOffset).toBeGreaterThanOrEqual(0);
    expect(readySource).toMatch(
      /const personalityPaths(?:: PersonalityPaths)? = \{\s*libraryDir: path\.join\(getStateDir\(\), 'personalities'\),\s*seedDir: resolvePersonalitySeedDir\(\{/s,
    );
    expect(readySource).toContain('seedBuiltInPersonalities(personalityPaths)');
    expect(readySource).toContain('createWindow(personalityPaths)');
    expect(main).toMatch(/function createWindow\(personalityPaths: PersonalityPaths\)/);
    expect(main).toContain('registerAllHandlers(mainWindow, personalityPaths)');
  });

  it.each([
    {
      isPackaged: false,
      resourcesPath: path.join(path.sep, 'unused', 'resources'),
      mainModuleDir: path.join(path.sep, 'repo', 'dist-electron'),
      expectedSeedDir: path.join(path.sep, 'repo', 'seeds', 'personalities'),
    },
    {
      isPackaged: true,
      resourcesPath: path.join(path.sep, 'opt', 'Forge', 'resources'),
      mainModuleDir: path.join(path.sep, 'unused', 'dist-electron'),
      expectedSeedDir: path.join(path.sep, 'opt', 'Forge', 'resources', 'seeds', 'personalities'),
    },
  ])('resolves the shared seed path in packaged=$isPackaged mode', (runtime) => {
    expect(resolvePersonalitySeedDir(runtime)).toBe(runtime.expectedSeedDir);
  });

  it('requires registerAllHandlers to consume injected personality paths without deriving another pair', () => {
    const register = fs.readFileSync(REGISTER_PATH, 'utf8');

    expect(register).toMatch(
      /export function registerAllHandlers\(win: BrowserWindow, personalityPaths: PersonalityPaths\)/,
    );
    expect(register).not.toContain("path.join(getStateDir(), 'personalities')");
    expect(register).not.toContain('resolvePersonalitySeedDir(');
    expect(register).not.toContain('process.resourcesPath');
    expect(register).not.toContain('app.isPackaged');
  });
});
