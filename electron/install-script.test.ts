import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('install.sh', () => {
  it('uses the full release artifact build sequence for macOS packaging', () => {
    const script = readFileSync(join(__dirname, '..', 'install.sh'), 'utf8');

    expect(script).toContain(
      'npm run build:frontend && npm run build:remote && npm run compile && npm run build:mcp && npx electron-builder --config.mac.identity=null',
    );
  });
});
