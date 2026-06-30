#!/usr/bin/env node
/* global console, process */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probe = spawnSync('semgrep', ['--version'], { stdio: 'ignore' });
if (probe.error?.code === 'ENOENT' || probe.status !== 0) {
  console.error(
    'semgrep not installed — install with `brew install semgrep` or `pip install semgrep`',
  );
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'forge-semgrep-'));

try {
  const mcpDir = join(tmp, 'electron', 'mcp');
  const ipcDir = join(tmp, 'electron', 'ipc');
  mkdirSync(mcpDir, { recursive: true });
  mkdirSync(ipcDir, { recursive: true });

  writeFileSync(
    join(mcpDir, 'unsafe.ts'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/out', 'data');\n",
  );
  writeFileSync(
    join(ipcDir, 'register.ts'),
    "import fs from 'node:fs';\nfs.writeFileSync('/tmp/out', 'data');\n",
  );
  writeFileSync(
    join(mcpDir, 'atomic.ts'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('/tmp/out', 'data');\n",
  );
  writeFileSync(
    join(mcpDir, 'unsafe.test.ts'),
    "import fs from 'node:fs';\nfs.writeFileSync('/tmp/out', 'data');\n",
  );
  writeFileSync(
    join(mcpDir, 'safe.ts'),
    "import { atomicWriteFileSync } from './atomic';\natomicWriteFileSync('/tmp/out', 'data');\n",
  );

  const stdout = execFileSync(
    'semgrep',
    ['scan', '--config', '.semgrep/filesystem-safety.yml', '--json', tmp],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const results = JSON.parse(stdout).results ?? [];
  const directWriteMatches = results
    .filter((result) => result.check_id.endsWith('direct-writefile-in-mcp-coordinator'))
    .map((result) => result.path.replaceAll('\\', '/'))
    .sort();

  const expectedSuffixes = ['/electron/ipc/register.ts', '/electron/mcp/unsafe.ts'];
  const missing = expectedSuffixes.filter(
    (suffix) => !directWriteMatches.some((path) => path.endsWith(suffix)),
  );
  const unexpected = directWriteMatches.filter(
    (path) => !expectedSuffixes.some((suffix) => path.endsWith(suffix)),
  );

  if (missing.length || unexpected.length) {
    console.error('Unexpected Semgrep filesystem-safety results');
    console.error({ directWriteMatches, missing, unexpected });
    process.exit(1);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
