import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  entry: [
    'electron/main.ts',
    'electron/preload.cjs',
    'electron/mcp/server.ts', // added in coordinator-2-mcp-backend; listed here so knip tracks it from the start
    // Frontend entries (src/index.tsx, src/remote/index.tsx) are auto-detected from index.html.
  ],
  project: ['electron/**/*.ts', 'src/**/*.{ts,tsx}'],
  ignoreBinaries: [
    // Optional security tooling invoked from npm scripts; installed on demand
    'semgrep',
    'gitleaks',
  ],
  // Test files are allowed to have unused exports (test helpers, fixtures)
  ignoreExportsUsedInFile: true,
};

export default config;
