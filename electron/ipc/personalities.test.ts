import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PERSONALITY_FILE_BYTES,
  PersonalityParseError,
  computeInstalledPersonalityPayloadHash,
  createPersonality,
  isPersonalityId,
  listPersonalities,
  materializePersonalitySeed,
  parsePersonalityMarkdown,
  readPersonality,
  seedBuiltInPersonalities,
  updatePersonality,
  type ParsePersonalityMarkdownOptions,
} from './personalities.js';
import type { PersonalityWriteFields } from './shared-types.js';

const BOM = '\uFEFF';
const VALID_HASH = 'a'.repeat(64);
const REPOSITORY_ROOT = join(__dirname, '..', '..');
const PACKAGED_SEED_DIR = join(REPOSITORY_ROOT, 'seeds', 'personalities');
const OCR_LICENSE_PATH = join(REPOSITORY_ROOT, 'LICENSES', 'open-code-review-Apache-2.0.txt');
const OCR_LICENSE_SHA256 = '1037b28673801f723501d895d0b440a9738c357e83e9f2bdbdba3a7d3baa4b62';
const REQUIRED_BODY_HEADINGS = [
  '## Focus Areas',
  '## Approach',
  '## Standards',
  '## Anti-Patterns',
] as const;
const PROHIBITED_BODY_PHRASES = [
  'conducting a code review',
  'What You Look For',
  'Your Review Approach',
  'Your Output Style',
  'Agency Reminder',
  'Forge',
  'pane',
  'worktree',
  'sibling',
  'Combine',
] as const;
const PACKAGED_SEED_CONTRACTS = [
  {
    filename: 'code-quality-engineer.md',
    id: 'code-quality-engineer',
    name: 'Code Quality Engineer',
    article: 'a',
    badge: 'QE',
    color: '#2FD198',
    sourcePersona: 'quality.md',
    sha256: '811e35ddd32204614710bfd63c52b9fae2d2ea75fb1c9a543a50987257b64258',
    topics: ['readability', 'naming', 'complexity', 'consistent error handling'],
  },
  {
    filename: 'principal-engineer.md',
    id: 'principal-engineer',
    name: 'Principal Engineer',
    article: 'a',
    badge: 'PE',
    color: '#7A78FF',
    sourcePersona: 'principal.md',
    sha256: '2d75b1894c8096df090bfa7055505e7b5e67a3ceb84ac1447670724cb96451d4',
    topics: [
      'architecture',
      'maintainability',
      'scalability',
      'api design',
      'cross-cutting concerns',
    ],
  },
  {
    filename: 'ai-engineer.md',
    id: 'ai-engineer',
    name: 'AI Engineer',
    article: 'an',
    badge: 'AI',
    color: '#FF944D',
    sourcePersona: 'ai.md',
    sha256: 'be0162e663ca598b3745eb8d5884c99d8bfbb36860141690e4087a3e2abce473',
    topics: [
      'prompt design',
      'robust model integration',
      'guardrails',
      'cost',
      'latency',
      'evaluation',
      'data handling',
    ],
  },
] as const;
const SEED_METADATA = [
  'id: code-quality-engineer',
  'name: "  Code Quality Engineer  "',
  'badge: QE',
  'color: "#2FD198"',
  'builtin: true',
  'seedRevision: 1',
];
const LIBRARY_METADATA = [...SEED_METADATA, `pristineHash: "${VALID_HASH}"`];
const CUSTOM_METADATA = [
  'id: local-builder',
  'name: Local Builder',
  'badge: LB',
  "color: '#ABC'",
  'builtin: false',
];

interface DocumentOptions {
  eol?: '\n' | '\r\n';
  bom?: boolean;
  body?: string;
  openingDelimiter?: string;
  closingDelimiter?: string;
}

function markdownBody(eol: '\n' | '\r\n' = '\n'): string {
  return ['You are a code quality engineer.', '', '## Focus Areas', '', '- Maintainability'].join(
    eol,
  );
}

function personalityDocument(
  metadata: readonly string[],
  {
    eol = '\n',
    bom = false,
    body = markdownBody(eol),
    openingDelimiter = '---',
    closingDelimiter = '---',
  }: DocumentOptions = {},
): string {
  const prefix = bom ? BOM : '';
  return `${prefix}${openingDelimiter}${eol}${metadata.join(eol)}${eol}${closingDelimiter}${eol}${body}`;
}

function replaceMetadataLine(
  metadata: readonly string[],
  key: string,
  replacement: string | null,
): string[] {
  const next = [...metadata];
  const index = next.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) throw new Error(`Missing fixture key: ${key}`);
  if (replacement === null) next.splice(index, 1);
  else next[index] = replacement;
  return next;
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function readRequiredRepositoryFile(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`Missing required repository file: ${filePath}`);
  return readFileSync(filePath, 'utf8');
}

function expectParseError(raw: string, options: ParsePersonalityMarkdownOptions): void {
  expect(() => parsePersonalityMarkdown(raw, options)).toThrowError(PersonalityParseError);
}

interface SyntheticSeedOptions {
  id: string;
  revision?: number;
  name?: string;
  badge?: string;
  color?: string;
  body?: string;
}

function syntheticSeed({
  id,
  revision = 1,
  name = id,
  badge = 'TS',
  color = '#123ABC',
  body = `You are **${name}**.\n\n## Focus Areas\n\n- Safe changes`,
}: SyntheticSeedOptions): string {
  return personalityDocument(
    [
      `id: ${id}`,
      `name: ${name}`,
      `badge: ${badge}`,
      `color: '${color}'`,
      'builtin: true',
      `seedRevision: ${revision}`,
    ],
    { body },
  );
}

function customPersonality(id: string, body = 'Local custom guidance', name = id): string {
  return personalityDocument(
    [`id: ${id}`, `name: ${name}`, 'badge: LC', "color: '#ABC'", 'builtin: false'],
    { body },
  );
}

function padUtf8(raw: string, targetBytes: number): string {
  const currentBytes = Buffer.byteLength(raw, 'utf8');
  if (currentBytes > targetBytes) throw new Error('Fixture exceeds requested byte length');
  return raw + 'x'.repeat(targetBytes - currentBytes);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function expectReportedError(
  errors: ReadonlyArray<{ id?: string; message: string }>,
  id: string,
): void {
  expect(errors.some((error) => error.id === id && error.message.length > 0)).toBe(true);
}

function writeSeed(seedDir: string, id: string, raw: string): string {
  fs.mkdirSync(seedDir, { recursive: true });
  const filePath = join(seedDir, `${id}.md`);
  fs.writeFileSync(filePath, raw, 'utf8');
  return filePath;
}

function copyRepositorySeeds(seedDir: string): void {
  fs.mkdirSync(seedDir, { recursive: true });
  for (const filename of readdirSync(PACKAGED_SEED_DIR)) {
    fs.copyFileSync(join(PACKAGED_SEED_DIR, filename), join(seedDir, filename));
  }
}

function guardReadPaths(blockedPaths: readonly string[]) {
  const blocked = new Set(blockedPaths);
  const originalReadFileSync = fs.readFileSync;
  return vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    if (blocked.has(String(args[0]))) throw new Error(`Unexpected read: ${String(args[0])}`);
    return Reflect.apply(originalReadFileSync, fs, args);
  });
}

function rejectOpenPaths(blockedPaths: readonly string[]) {
  const blocked = new Set(blockedPaths);
  const originalOpenSync = fs.openSync;
  return vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (blocked.has(String(args[0]))) {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    }
    return Reflect.apply(originalOpenSync, fs, args);
  });
}

function makeFifo(filePath: string): boolean {
  return spawnSync('mkfifo', [filePath], { stdio: 'ignore' }).status === 0;
}

function writeFields(overrides: Partial<PersonalityWriteFields> = {}): PersonalityWriteFields {
  return {
    name: 'Local Builder',
    badge: 'LB',
    color: '#ABC',
    markdown: 'You are a local builder.',
    ...overrides,
  };
}

function utf8Payload(byteLength: number): string {
  const pairs = Math.floor(byteLength / 2);
  return `${'é'.repeat(pairs)}${byteLength % 2 === 0 ? '' : 'x'}`;
}

describe('D-06 seed parse mode personality document contract', () => {
  it('parses and normalizes the strict built-in seed metadata and exact markdown body', () => {
    const raw = personalityDocument(SEED_METADATA);

    expect(
      parsePersonalityMarkdown(raw, { mode: 'seed', expectedId: 'code-quality-engineer' }),
    ).toEqual({
      metadata: {
        id: 'code-quality-engineer',
        name: 'Code Quality Engineer',
        badge: 'QE',
        color: '#2FD198',
        builtin: true,
        seedRevision: 1,
      },
      markdown: markdownBody(),
    });
  });

  it('ignores forward-compatible unknown scalar metadata', () => {
    const raw = personalityDocument([
      ...SEED_METADATA,
      'futureText: enabled',
      'futureNumber: 2',
      'futureBoolean: true',
      'futureNull: null',
    ]);

    expect(parsePersonalityMarkdown(raw, { mode: 'seed' }).metadata).toEqual({
      id: 'code-quality-engineer',
      name: 'Code Quality Engineer',
      badge: 'QE',
      color: '#2FD198',
      builtin: true,
      seedRevision: 1,
    });
  });
});

describe('D-09 library parse mode and pristine payload hash contract', () => {
  it('parses a materialized built-in with a lowercase SHA-256 hash', () => {
    const parsed = parsePersonalityMarkdown(personalityDocument(LIBRARY_METADATA), {
      mode: 'library',
      expectedId: 'code-quality-engineer',
    });

    expect(parsed.metadata).toEqual({
      id: 'code-quality-engineer',
      name: 'Code Quality Engineer',
      badge: 'QE',
      color: '#2FD198',
      builtin: true,
      seedRevision: 1,
      pristineHash: VALID_HASH,
    });
    expect(parsed.markdown).toBe(markdownBody());
  });

  it('parses a custom library record without built-in seed fields', () => {
    expect(
      parsePersonalityMarkdown(personalityDocument(CUSTOM_METADATA), {
        mode: 'library',
        expectedId: 'local-builder',
      }),
    ).toEqual({
      metadata: {
        id: 'local-builder',
        name: 'Local Builder',
        badge: 'LB',
        color: '#ABC',
        builtin: false,
      },
      markdown: markdownBody(),
    });
  });

  it.each([
    { label: 'LF', eol: '\n' as const, bom: false },
    { label: 'CRLF', eol: '\r\n' as const, bom: false },
    { label: 'UTF-8 BOM', eol: '\n' as const, bom: true },
  ])('materializes and strips one exact hash line for $label bytes', ({ eol, bom }) => {
    const rawSeed = personalityDocument(SEED_METADATA, { eol, bom });
    const expectedHash = sha256(rawSeed);
    const generatedLine = `pristineHash: "${expectedHash}"${eol}`;

    const installed = materializePersonalitySeed(rawSeed);

    expect(installed.split(generatedLine)).toHaveLength(2);
    expect(installed).toContain(`seedRevision: 1${eol}${generatedLine}---${eol}`);
    expect(installed.replace(generatedLine, '')).toBe(rawSeed);
    expect(Buffer.from(installed.replace(generatedLine, ''), 'utf8')).toEqual(
      Buffer.from(rawSeed, 'utf8'),
    );
    expect(computeInstalledPersonalityPayloadHash(installed)).toBe(expectedHash);
    expect(parsePersonalityMarkdown(installed, { mode: 'library' }).metadata.pristineHash).toBe(
      expectedHash,
    );
  });
});

describe('personality identity validation', () => {
  it.each(['a', 'quality', 'code-quality-engineer', 'principal_engineer-2', `a${'b'.repeat(63)}`])(
    'accepts valid ID %s',
    (id) => {
      expect(isPersonalityId(id)).toBe(true);
    },
  );

  it.each([
    '',
    'CodeQuality',
    '-quality',
    '_quality',
    'quality.md',
    'quality/reviewer',
    'quality reviewer',
    `a${'b'.repeat(64)}`,
    null,
    42,
  ])('rejects invalid ID %s', (id) => {
    expect(isPersonalityId(id)).toBe(false);
  });
});

describe('strict frontmatter and field validation', () => {
  const invalidCases: Array<{
    name: string;
    raw: string;
    options: ParsePersonalityMarkdownOptions;
  }> = [
    {
      name: 'duplicate keys',
      raw: personalityDocument([...SEED_METADATA, 'name: Duplicate']),
      options: { mode: 'seed' },
    },
    {
      name: 'aliases and anchors',
      raw: personalityDocument([
        ...replaceMetadataLine(SEED_METADATA, 'name', 'name: &display Code Quality Engineer'),
        'futureName: *display',
      ]),
      options: { mode: 'seed' },
    },
    {
      name: 'merge keys',
      raw: personalityDocument([...SEED_METADATA, '<<: merged']),
      options: { mode: 'seed' },
    },
    {
      name: 'explicit known tags',
      raw: personalityDocument(
        replaceMetadataLine(SEED_METADATA, 'name', 'name: !!str Code Quality Engineer'),
      ),
      options: { mode: 'seed' },
    },
    {
      name: 'nested mapping metadata',
      raw: personalityDocument([...SEED_METADATA, 'future:', '  nested: true']),
      options: { mode: 'seed' },
    },
    {
      name: 'nested sequence metadata',
      raw: personalityDocument([...SEED_METADATA, 'future: [one, two]']),
      options: { mode: 'seed' },
    },
    {
      name: 'non-string metadata keys',
      raw: personalityDocument([...SEED_METADATA, '1: future']),
      options: { mode: 'seed' },
    },
    {
      name: 'non-mapping frontmatter',
      raw: personalityDocument(['- id', '- name']),
      options: { mode: 'seed' },
    },
    {
      name: 'missing opening delimiter',
      raw: personalityDocument(SEED_METADATA, { openingDelimiter: '----' }),
      options: { mode: 'seed' },
    },
    {
      name: 'invalid closing delimiter',
      raw: personalityDocument(SEED_METADATA, { closingDelimiter: '...' }),
      options: { mode: 'seed' },
    },
    {
      name: 'numeric ID',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'id', 'id: 42')),
      options: { mode: 'seed' },
    },
    {
      name: 'invalid ID characters',
      raw: personalityDocument(
        replaceMetadataLine(SEED_METADATA, 'id', 'id: ../code-quality-engineer'),
      ),
      options: { mode: 'seed' },
    },
    {
      name: 'filename stem mismatch',
      raw: personalityDocument(SEED_METADATA),
      options: { mode: 'seed', expectedId: 'principal-engineer' },
    },
    {
      name: 'empty name after trimming',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'name', 'name: "   "')),
      options: { mode: 'seed' },
    },
    {
      name: 'name longer than 80 characters',
      raw: personalityDocument(
        replaceMetadataLine(SEED_METADATA, 'name', `name: "${'n'.repeat(81)}"`),
      ),
      options: { mode: 'seed' },
    },
    {
      name: 'wrong name scalar type',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'name', 'name: true')),
      options: { mode: 'seed' },
    },
    {
      name: 'lowercase badge',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'badge', 'badge: qe')),
      options: { mode: 'seed' },
    },
    {
      name: 'badge longer than four characters',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'badge', 'badge: QUAL5')),
      options: { mode: 'seed' },
    },
    {
      name: 'wrong badge scalar type',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'badge', 'badge: 12')),
      options: { mode: 'seed' },
    },
    {
      name: 'unquoted color',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'color', 'color: #2FD198')),
      options: { mode: 'seed' },
    },
    {
      name: 'invalid quoted color',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'color', 'color: "#12GG00"')),
      options: { mode: 'seed' },
    },
    {
      name: 'wrong builtin scalar type',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'builtin', 'builtin: "true"')),
      options: { mode: 'seed' },
    },
    ...['0', '-1', '1.5', '9007199254740992', '"1"'].map((revision) => ({
      name: `invalid seed revision ${revision}`,
      raw: personalityDocument(
        replaceMetadataLine(SEED_METADATA, 'seedRevision', `seedRevision: ${revision}`),
      ),
      options: { mode: 'seed' as const },
    })),
    {
      name: 'missing seed revision',
      raw: personalityDocument(replaceMetadataLine(SEED_METADATA, 'seedRevision', null)),
      options: { mode: 'seed' },
    },
    {
      name: 'seed with pristine hash',
      raw: personalityDocument([...SEED_METADATA, `pristineHash: "${VALID_HASH}"`]),
      options: { mode: 'seed' },
    },
    {
      name: 'custom record in seed mode',
      raw: personalityDocument(CUSTOM_METADATA),
      options: { mode: 'seed' },
    },
    {
      name: 'library built-in without pristine hash',
      raw: personalityDocument(SEED_METADATA),
      options: { mode: 'library' },
    },
    {
      name: 'library built-in without seed revision',
      raw: personalityDocument(replaceMetadataLine(LIBRARY_METADATA, 'seedRevision', null)),
      options: { mode: 'library' },
    },
    {
      name: 'uppercase library hash',
      raw: personalityDocument(
        replaceMetadataLine(LIBRARY_METADATA, 'pristineHash', `pristineHash: "${'A'.repeat(64)}"`),
      ),
      options: { mode: 'library' },
    },
    {
      name: 'short library hash',
      raw: personalityDocument(
        replaceMetadataLine(LIBRARY_METADATA, 'pristineHash', 'pristineHash: "abc123"'),
      ),
      options: { mode: 'library' },
    },
    {
      name: 'unquoted library hash',
      raw: personalityDocument(
        replaceMetadataLine(LIBRARY_METADATA, 'pristineHash', `pristineHash: ${VALID_HASH}`),
      ),
      options: { mode: 'library' },
    },
    {
      name: 'custom library record with seed revision',
      raw: personalityDocument([...CUSTOM_METADATA, 'seedRevision: 1']),
      options: { mode: 'library' },
    },
    {
      name: 'custom library record with pristine hash',
      raw: personalityDocument([...CUSTOM_METADATA, `pristineHash: "${VALID_HASH}"`]),
      options: { mode: 'library' },
    },
    {
      name: 'empty markdown body',
      raw: personalityDocument(SEED_METADATA, { body: ' \n\t ' }),
      options: { mode: 'seed' },
    },
  ];

  it.each(invalidCases)('rejects $name', ({ raw, options }) => {
    expectParseError(raw, options);
  });
});

describe('D-01/D-02/D-03/D-04 packaged personality seed contract', () => {
  it('contains exactly the three canonical built-in seed filenames', () => {
    if (!existsSync(PACKAGED_SEED_DIR)) {
      throw new Error(`Missing canonical seed directory: ${PACKAGED_SEED_DIR}`);
    }

    expect(readdirSync(PACKAGED_SEED_DIR).sort()).toEqual(
      PACKAGED_SEED_CONTRACTS.map(({ filename }) => filename).sort(),
    );
  });

  it('honors D-04 with exact revision-one identity metadata and attribution comments', () => {
    for (const contract of PACKAGED_SEED_CONTRACTS) {
      const raw = readRequiredRepositoryFile(join(PACKAGED_SEED_DIR, contract.filename));
      const parsed = parsePersonalityMarkdown(raw, { mode: 'seed', expectedId: contract.id });
      const expectedNotice = [
        '---',
        `# Modified from the Open Code Review ${contract.sourcePersona} persona for code-writing use.`,
        '# Source: https://github.com/spencermarx/open-code-review',
        '# License: Apache-2.0; see LICENSES/open-code-review-Apache-2.0.txt',
      ].join('\n');

      expect(raw.startsWith(`${expectedNotice}\n`)).toBe(true);
      expect(raw).not.toMatch(/\/opt\/homebrew|@open-code-review\//);
      expect(parsed.metadata).toEqual({
        id: contract.id,
        name: contract.name,
        badge: contract.badge,
        color: contract.color,
        builtin: true,
        seedRevision: 1,
      });
      expect(parsed.metadata).not.toHaveProperty('pristineHash');
      expect(parsed.markdown).not.toContain('Open Code Review');
      expect(parsed.markdown).not.toContain('Apache-2.0');
    }
  });

  it('honors D-01 and D-02 with coding identities, retained topics, and normalized bodies', () => {
    for (const contract of PACKAGED_SEED_CONTRACTS) {
      const raw = readRequiredRepositoryFile(join(PACKAGED_SEED_DIR, contract.filename));
      const { markdown } = parsePersonalityMarkdown(raw, {
        mode: 'seed',
        expectedId: contract.id,
      });
      const focusHeadingOffset = markdown.indexOf('\n\n## Focus Areas\n');
      const roleParagraph = markdown.slice(0, focusHeadingOffset).trim();

      expect(focusHeadingOffset).toBeGreaterThan(0);
      expect(roleParagraph).toContain(`You are ${contract.article} **${contract.name}**`);
      expect(roleParagraph).not.toContain('\n\n');
      expect(markdown.match(/^#{1,6} .+$/gm)).toEqual(REQUIRED_BODY_HEADINGS);
      expect(markdown).not.toMatch(/^# /m);

      const normalizedBody = markdown.toLowerCase();
      for (const topic of contract.topics) expect(normalizedBody).toContain(topic);
    }
  });

  it('honors D-03 by excluding review-pipeline and application-workflow authority', () => {
    for (const contract of PACKAGED_SEED_CONTRACTS) {
      const raw = readRequiredRepositoryFile(join(PACKAGED_SEED_DIR, contract.filename));
      const { markdown } = parsePersonalityMarkdown(raw, {
        mode: 'seed',
        expectedId: contract.id,
      });
      const normalizedBody = markdown.toLowerCase();

      for (const phrase of PROHIBITED_BODY_PHRASES) {
        expect(normalizedBody).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it('pins the complete repository Apache-2.0 license to the canonical OCR bytes', () => {
    const license = readRequiredRepositoryFile(OCR_LICENSE_PATH);
    const requiredSections = [
      '1. Definitions.',
      '2. Grant of Copyright License.',
      '3. Grant of Patent License.',
      '4. Redistribution.',
      '5. Submission of Contributions.',
      '6. Trademarks.',
      '7. Disclaimer of Warranty.',
      '8. Limitation of Liability.',
      '9. Accepting Warranty or Additional Liability.',
    ];

    expect(sha256(license)).toBe(OCR_LICENSE_SHA256);
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    for (const section of requiredSections) expect(license).toContain(section);
    expect(license).toContain('END OF TERMS AND CONDITIONS');
    expect(license).toContain('Copyright 2026 Open Code Review Contributors');
  });
});

describe('RED: binding storage contract', () => {
  let temporaryRoot: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-binding-'));
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeBindingDocument(metadata: readonly string[]): string {
    const filePath = join(libraryDir, 'local-builder.md');
    fs.writeFileSync(filePath, personalityDocument([...CUSTOM_METADATA, ...metadata]), 'utf8');
    return filePath;
  }

  it('omits every binding key when a custom write has no binding', () => {
    const detail = createPersonality(libraryDir, writeFields());
    const raw = readFileSync(join(libraryDir, `${detail.id}.md`), 'utf8');

    expect(detail).toEqual({
      id: 'local-builder',
      name: 'Local Builder',
      badge: 'LB',
      color: '#ABC',
      builtin: false,
      modifiedFromSeed: false,
      markdown: 'You are a local builder.',
    });
    expect(raw).not.toMatch(/defaultAgent|defaultModel|defaultReasoningEffort/);
  });

  it.each(['claude-code', 'codex', 'opencode'] as const)(
    'round-trips exact agent %s while omitting host-default model and effort keys',
    (defaultAgent) => {
      const detail = createPersonality(libraryDir, writeFields({ defaultAgent }));
      const raw = readFileSync(join(libraryDir, `${detail.id}.md`), 'utf8');

      expect(detail).toMatchObject({ defaultAgent });
      expect(detail).not.toHaveProperty('defaultModel');
      expect(detail).not.toHaveProperty('defaultReasoningEffort');
      expect(raw).toContain(`defaultAgent: ${defaultAgent}`);
      expect(raw).not.toMatch(/defaultModel|defaultReasoningEffort/);
    },
  );

  it('trims and round-trips free-form model and reasoning effort scalars', () => {
    const detail = createPersonality(
      libraryDir,
      writeFields({
        defaultAgent: 'opencode',
        defaultModel: '  anthropic/claude:opus#beta  ',
        defaultReasoningEffort: '  max  ',
      }),
    );
    const raw = readFileSync(join(libraryDir, `${detail.id}.md`), 'utf8');

    expect(detail).toMatchObject({
      defaultAgent: 'opencode',
      defaultModel: 'anthropic/claude:opus#beta',
      defaultReasoningEffort: 'max',
    });
    expect(raw).toContain('defaultModel: anthropic/claude:opus#beta');
    expect(raw).toContain('defaultReasoningEffort: max');
  });

  it.each([
    { label: 'unknown agent', fields: { defaultAgent: 'custom-agent' } },
    { label: 'empty agent', fields: { defaultAgent: '' } },
    { label: 'wrong-type agent', fields: { defaultAgent: 42 } },
    { label: 'orphan model', fields: { defaultModel: 'gpt-5.6-sol' } },
    { label: 'orphan effort', fields: { defaultReasoningEffort: 'high' } },
    {
      label: 'orphan model and effort',
      fields: { defaultModel: 'gpt-5.6-sol', defaultReasoningEffort: 'high' },
    },
    { label: 'empty model', fields: { defaultAgent: 'codex', defaultModel: '   ' } },
    { label: 'wrong-type model', fields: { defaultAgent: 'codex', defaultModel: false } },
    {
      label: 'empty effort',
      fields: { defaultAgent: 'claude-code', defaultReasoningEffort: '   ' },
    },
    {
      label: 'wrong-type effort',
      fields: { defaultAgent: 'claude-code', defaultReasoningEffort: 1 },
    },
  ])('rejects a custom write with $label', ({ fields }) => {
    expect(() =>
      createPersonality(
        libraryDir,
        writeFields(fields as unknown as Partial<PersonalityWriteFields>),
      ),
    ).toThrow();
  });

  it('keeps valid bindings on detail reads without exposing them on summaries', () => {
    writeBindingDocument([
      'defaultAgent: codex',
      "defaultModel: 'openai/gpt-5.6:sol#preview'",
      'defaultReasoningEffort: xhigh',
    ]);
    const warnings: string[] = [];

    const detail = readPersonality(libraryDir, 'local-builder', (message) =>
      warnings.push(message),
    );
    const summaries = listPersonalities(libraryDir, (message) => warnings.push(message));

    expect(detail).toEqual({
      id: 'local-builder',
      name: 'Local Builder',
      badge: 'LB',
      color: '#ABC',
      builtin: false,
      modifiedFromSeed: false,
      markdown: markdownBody(),
      defaultAgent: 'codex',
      defaultModel: 'openai/gpt-5.6:sol#preview',
      defaultReasoningEffort: 'xhigh',
    });
    expect(Object.keys(detail ?? {})).toEqual([
      'id',
      'name',
      'badge',
      'color',
      'builtin',
      'modifiedFromSeed',
      'markdown',
      'defaultAgent',
      'defaultModel',
      'defaultReasoningEffort',
    ]);
    expect(summaries).toEqual([
      {
        id: 'local-builder',
        name: 'Local Builder',
        badge: 'LB',
        color: '#ABC',
        builtin: false,
        modifiedFromSeed: false,
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it.each([
    {
      label: 'unknown agent and its entire binding',
      metadata: [
        'defaultAgent: custom-agent',
        'defaultModel: gpt-5.6-sol',
        'defaultReasoningEffort: high',
      ],
      kept: {},
      dropped: ['defaultAgent', 'defaultModel', 'defaultReasoningEffort'],
    },
    {
      label: 'empty agent and its entire binding',
      metadata: ["defaultAgent: ''", 'defaultModel: gpt-5.6-sol', 'defaultReasoningEffort: high'],
      kept: {},
      dropped: ['defaultAgent', 'defaultModel', 'defaultReasoningEffort'],
    },
    {
      label: 'wrong-type agent and its entire binding',
      metadata: ['defaultAgent: 42', 'defaultModel: gpt-5.6-sol', 'defaultReasoningEffort: high'],
      kept: {},
      dropped: ['defaultAgent', 'defaultModel', 'defaultReasoningEffort'],
    },
    {
      label: 'invalid model independently',
      metadata: ['defaultAgent: codex', 'defaultModel: false', 'defaultReasoningEffort: high'],
      kept: { defaultAgent: 'codex', defaultReasoningEffort: 'high' },
      dropped: ['defaultModel'],
    },
    {
      label: 'empty model independently',
      metadata: ['defaultAgent: codex', "defaultModel: '   '", 'defaultReasoningEffort: high'],
      kept: { defaultAgent: 'codex', defaultReasoningEffort: 'high' },
      dropped: ['defaultModel'],
    },
    {
      label: 'invalid effort independently',
      metadata: [
        'defaultAgent: claude-code',
        'defaultModel: fable',
        'defaultReasoningEffort: false',
      ],
      kept: { defaultAgent: 'claude-code', defaultModel: 'fable' },
      dropped: ['defaultReasoningEffort'],
    },
    {
      label: 'empty effort independently',
      metadata: [
        'defaultAgent: claude-code',
        'defaultModel: fable',
        "defaultReasoningEffort: '   '",
      ],
      kept: { defaultAgent: 'claude-code', defaultModel: 'fable' },
      dropped: ['defaultReasoningEffort'],
    },
    {
      label: 'orphan model and effort',
      metadata: ['defaultModel: gpt-5.6-sol', 'defaultReasoningEffort: high'],
      kept: {},
      dropped: ['defaultAgent', 'defaultModel', 'defaultReasoningEffort'],
    },
  ])('drops $label, keeps the core detail, and warns once', ({ metadata, kept, dropped }) => {
    writeBindingDocument(metadata);
    const warnings: string[] = [];

    const detail = readPersonality(libraryDir, 'local-builder', (message) =>
      warnings.push(message),
    );

    expect(detail).toMatchObject({
      id: 'local-builder',
      name: 'Local Builder',
      markdown: markdownBody(),
      ...kept,
    });
    for (const key of dropped) expect(detail).not.toHaveProperty(key);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('local-builder');
    expect(warnings[0].length).toBeLessThanOrEqual(500);
  });

  it('lists a record with invalid bindings and emits only one bounded warning', () => {
    writeBindingDocument([
      'defaultAgent: codex',
      'defaultModel: false',
      'defaultReasoningEffort: 42',
    ]);
    const warnings: string[] = [];

    const summaries = listPersonalities(libraryDir, (message) => warnings.push(message));

    expect(summaries.map(({ id }) => id)).toEqual(['local-builder']);
    expect(Object.keys(summaries[0])).toEqual([
      'id',
      'name',
      'badge',
      'color',
      'builtin',
      'modifiedFromSeed',
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].length).toBeLessThanOrEqual(500);
  });

  it('keeps all packaged seeds byte-identical and binding-free', () => {
    for (const contract of PACKAGED_SEED_CONTRACTS) {
      const raw = readRequiredRepositoryFile(join(PACKAGED_SEED_DIR, contract.filename));
      expect(sha256(raw)).toBe(contract.sha256);
      expect(raw).not.toMatch(/defaultAgent|defaultModel|defaultReasoningEffort/);
    }
  });
});

describe('RED: modified state contract', () => {
  const id = 'exact-byte-built-in';
  const name = 'Exact Byte Built-In';
  const rawSeed = syntheticSeed({ id, name, body: 'Original guidance' });
  const materialized = materializePersonalitySeed(rawSeed);
  const pristineHash = sha256(rawSeed);
  let temporaryRoot: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-modified-state-'));
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeInstalled(raw: string, installedId = id): string {
    const filePath = join(libraryDir, `${installedId}.md`);
    fs.writeFileSync(filePath, raw, 'utf8');
    return filePath;
  }

  it('reports exact materialized packaged bytes as pristine on summary and detail DTOs', () => {
    const installedPath = writeInstalled(materialized);

    expect(readFileSync(installedPath, 'utf8')).toBe(materialized);
    expect(computeInstalledPersonalityPayloadHash(materialized)).toBe(pristineHash);
    expect(listPersonalities(libraryDir)).toEqual([
      {
        id,
        name,
        badge: 'TS',
        color: '#123ABC',
        builtin: true,
        modifiedFromSeed: false,
      },
    ]);
    const detail = readPersonality(libraryDir, id);
    expect(detail).toEqual({
      id,
      name,
      badge: 'TS',
      color: '#123ABC',
      builtin: true,
      modifiedFromSeed: false,
      markdown: 'Original guidance',
    });
    expect(Object.keys(detail ?? {})).toEqual([
      'id',
      'name',
      'badge',
      'color',
      'builtin',
      'modifiedFromSeed',
      'markdown',
    ]);
  });

  it.each([
    {
      label: 'body bytes',
      mutate: (raw: string) => raw.replace('Original guidance', 'Edited guidance'),
    },
    {
      label: 'metadata bytes',
      mutate: (raw: string) => raw.replace(`name: ${name}`, 'name: Renamed Built-In'),
    },
    {
      label: 'line ending bytes',
      mutate: (raw: string) => raw.replace(/\n/g, '\r\n'),
    },
    {
      label: 'whitespace bytes',
      mutate: (raw: string) => raw.replace('badge: TS\n', 'badge: TS \n'),
    },
    {
      label: 'key order bytes',
      mutate: (raw: string) =>
        raw.replace(`name: ${name}\nbadge: TS\n`, `badge: TS\nname: ${name}\n`),
    },
    {
      label: 'comment bytes',
      mutate: (raw: string) => raw.replace('builtin: true\n', '# hand edit\nbuiltin: true\n'),
    },
  ])('reports $label changes as modified without exposing the payload hash', ({ mutate }) => {
    const edited = mutate(materialized);
    const installedPath = writeInstalled(edited);

    expect(edited).not.toBe(materialized);
    expect(readFileSync(installedPath, 'utf8')).toBe(edited);
    expect(computeInstalledPersonalityPayloadHash(edited)).not.toBe(pristineHash);
    const summary = listPersonalities(libraryDir)[0];
    const detail = readPersonality(libraryDir, id);
    expect(summary?.modifiedFromSeed).toBe(true);
    expect(detail?.modifiedFromSeed).toBe(true);
    expect(summary).not.toHaveProperty('pristineHash');
    expect(summary).not.toHaveProperty('seedRevision');
    expect(detail).not.toHaveProperty('pristineHash');
    expect(detail).not.toHaveProperty('seedRevision');
  });

  it('always reports custom records as unmodified regardless of their body bytes', () => {
    const customId = 'custom-byte-state';
    const raw = customPersonality(customId, 'Custom body with  \r\nintentional bytes');
    writeInstalled(raw, customId);

    expect(readFileSync(join(libraryDir, `${customId}.md`), 'utf8')).toBe(raw);
    expect(listPersonalities(libraryDir)).toEqual([
      {
        id: customId,
        name: customId,
        badge: 'LC',
        color: '#ABC',
        builtin: false,
        modifiedFromSeed: false,
      },
    ]);
    expect(readPersonality(libraryDir, customId)?.modifiedFromSeed).toBe(false);
  });

  it('omits malformed built-ins instead of fabricating a resettable summary', () => {
    writeInstalled('---\nid: [broken\n---\nBroken', 'broken-built-in');
    writeInstalled(customPersonality('valid-custom'), 'valid-custom');
    const warnings: string[] = [];

    const summaries = listPersonalities(libraryDir, (message) => warnings.push(message));

    expect(summaries.map(({ id: summaryId }) => summaryId)).toEqual(['valid-custom']);
    expect(summaries[0]?.modifiedFromSeed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('broken-built-in.md');
  });
});

describe('D-05/D-09/D-10/D-11/D-12 startup personality seed reconciliation', () => {
  let temporaryRoot: string;
  let seedDir: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-seed-'));
    seedDir = join(temporaryRoot, 'packaged');
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(seedDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.chmodSync(libraryDir, 0o700);
    } catch {
      // The fixture may not have created a library directory.
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('materializes the exact canonical set, is idempotent, and restores a deleted built-in', () => {
    copyRepositorySeeds(seedDir);
    const ids = PACKAGED_SEED_CONTRACTS.map(({ id }) => id).sort();

    const first = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(sorted(first.seeded)).toEqual(ids);
    expect(first.upgraded).toEqual([]);
    expect(first.preserved).toEqual([]);
    expect(first.unchanged).toEqual([]);
    expect(first.errors).toEqual([]);
    for (const contract of PACKAGED_SEED_CONTRACTS) {
      const rawSeed = readFileSync(join(seedDir, contract.filename), 'utf8');
      const installed = readFileSync(join(libraryDir, contract.filename), 'utf8');
      expect(installed).toBe(materializePersonalitySeed(rawSeed));
      expect(computeInstalledPersonalityPayloadHash(installed)).toBe(sha256(rawSeed));
    }

    const second = seedBuiltInPersonalities({ seedDir, libraryDir });
    expect(sorted(second.unchanged)).toEqual(ids);
    expect(second.seeded).toEqual([]);
    expect(second.upgraded).toEqual([]);
    expect(second.preserved).toEqual([]);
    expect(second.errors).toEqual([]);

    const deletedId = 'principal-engineer';
    fs.unlinkSync(join(libraryDir, `${deletedId}.md`));
    const restored = seedBuiltInPersonalities({ seedDir, libraryDir });
    expect(restored.seeded).toEqual([deletedId]);
    expect(sorted(restored.unchanged)).toEqual(ids.filter((id) => id !== deletedId));
    expect(readFileSync(join(libraryDir, `${deletedId}.md`), 'utf8')).toBe(
      materializePersonalitySeed(readFileSync(join(seedDir, `${deletedId}.md`), 'utf8')),
    );
  });

  it('backs up and atomically upgrades only a pristine strictly older built-in', () => {
    const id = 'upgrade-target';
    const oldSeed = syntheticSeed({ id, revision: 1, body: 'Old pristine guidance' });
    const newSeed = syntheticSeed({ id, revision: 2, body: 'New pristine guidance' });
    writeSeed(seedDir, id, oldSeed);
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const installedPath = join(libraryDir, `${id}.md`);
    const oldInstalled = readFileSync(installedPath, 'utf8');
    writeSeed(seedDir, id, newSeed);

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.upgraded).toEqual([id]);
    expect(report.seeded).toEqual([]);
    expect(report.preserved).toEqual([]);
    expect(report.unchanged).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(readFileSync(`${installedPath}.bak`, 'utf8')).toBe(oldInstalled);
    expect(readFileSync(installedPath, 'utf8')).toBe(materializePersonalitySeed(newSeed));
    expect(computeInstalledPersonalityPayloadHash(readFileSync(installedPath, 'utf8'))).toBe(
      sha256(newSeed),
    );
  });

  it('leaves same and lower packaged revisions byte-identical even when seed bytes differ', () => {
    const sameId = 'same-revision';
    const lowerId = 'lower-revision';
    writeSeed(seedDir, sameId, syntheticSeed({ id: sameId, revision: 2, body: 'Same original' }));
    writeSeed(
      seedDir,
      lowerId,
      syntheticSeed({ id: lowerId, revision: 2, body: 'Lower original' }),
    );
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const samePath = join(libraryDir, `${sameId}.md`);
    const lowerPath = join(libraryDir, `${lowerId}.md`);
    const sameBefore = readFileSync(samePath, 'utf8');
    const lowerEdited = readFileSync(lowerPath, 'utf8').replace(
      'Lower original',
      'Locally edited newer revision',
    );
    fs.writeFileSync(lowerPath, lowerEdited, 'utf8');

    writeSeed(
      seedDir,
      sameId,
      syntheticSeed({ id: sameId, revision: 2, body: 'Same changed without bump' }),
    );
    writeSeed(
      seedDir,
      lowerId,
      syntheticSeed({ id: lowerId, revision: 1, body: 'Attempted downgrade' }),
    );
    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(sorted(report.unchanged)).toEqual([lowerId, sameId].sort());
    expect(report.upgraded).toEqual([]);
    expect(report.preserved).toEqual([]);
    expect(report.errors).toEqual([]);
    expect(readFileSync(samePath, 'utf8')).toBe(sameBefore);
    expect(readFileSync(lowerPath, 'utf8')).toBe(lowerEdited);
  });

  it.each([
    {
      label: 'body edit',
      mutate: (raw: string) => raw.replace('Original guidance', 'Hand-edited guidance'),
    },
    {
      label: 'metadata edit',
      mutate: (raw: string) => raw.replace('name: edited-target', 'name: Locally Renamed'),
    },
    {
      label: 'hash-line edit',
      mutate: (raw: string) =>
        raw.replace(/pristineHash: "[a-f0-9]{64}"/, `pristineHash: "${'f'.repeat(64)}"`),
    },
    {
      label: 'malformed YAML',
      mutate: () => '---\nid: [broken\n---\nLocal work',
    },
    {
      label: 'wrong installed ID',
      mutate: (raw: string) => raw.replace('id: edited-target', 'id: other-built-in'),
    },
  ])('preserves a $label when a newer packaged revision exists', ({ mutate }) => {
    const id = 'edited-target';
    writeSeed(seedDir, id, syntheticSeed({ id, revision: 1, body: 'Original guidance' }));
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const installedPath = join(libraryDir, `${id}.md`);
    const edited = mutate(readFileSync(installedPath, 'utf8'));
    fs.writeFileSync(installedPath, edited, 'utf8');
    writeSeed(seedDir, id, syntheticSeed({ id, revision: 2, body: 'Upstream revision two' }));

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.preserved).toEqual([id]);
    expect(report.upgraded).toEqual([]);
    expect(readFileSync(installedPath, 'utf8')).toBe(edited);
    expectReportedError(report.errors, id);
  });

  it('preserves an unreadable installed candidate and continues with a valid sibling', () => {
    const blockedId = 'unreadable-built-in';
    const siblingId = 'valid-sibling';
    const originalSeed = syntheticSeed({ id: blockedId, revision: 1 });
    writeSeed(seedDir, blockedId, originalSeed);
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const blockedPath = join(libraryDir, `${blockedId}.md`);
    const before = readFileSync(blockedPath, 'utf8');
    writeSeed(seedDir, blockedId, syntheticSeed({ id: blockedId, revision: 2 }));
    writeSeed(seedDir, siblingId, syntheticSeed({ id: siblingId }));
    const openSpy = rejectOpenPaths([blockedPath]);

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.preserved).toContain(blockedId);
    expect(report.seeded).toContain(siblingId);
    expectReportedError(report.errors, blockedId);
    expect(openSpy.mock.calls.some(([filePath]) => String(filePath) === blockedPath)).toBe(true);
    vi.restoreAllMocks();
    expect(readFileSync(blockedPath, 'utf8')).toBe(before);
  });

  it.each(['symlink', 'directory', 'oversized', 'fifo'] as const)(
    'rejects an installed $type before read, preserves it, and isolates a valid sibling',
    (type) => {
      const blockedId = `installed-${type}`;
      const siblingId = `sibling-${type}`;
      writeSeed(seedDir, blockedId, syntheticSeed({ id: blockedId }));
      writeSeed(seedDir, siblingId, syntheticSeed({ id: siblingId }));
      fs.mkdirSync(libraryDir, { recursive: true });
      const blockedPath = join(libraryDir, `${blockedId}.md`);

      if (type === 'symlink') {
        const target = join(temporaryRoot, 'symlink-target.md');
        fs.writeFileSync(
          target,
          materializePersonalitySeed(syntheticSeed({ id: blockedId })),
          'utf8',
        );
        fs.symlinkSync(target, blockedPath);
      } else if (type === 'directory') {
        fs.mkdirSync(blockedPath);
      } else if (type === 'oversized') {
        fs.writeFileSync(blockedPath, 'x'.repeat(MAX_PERSONALITY_FILE_BYTES + 1));
      } else if (!makeFifo(blockedPath)) {
        return;
      }

      const readSpy = guardReadPaths([blockedPath]);
      const report = seedBuiltInPersonalities({ seedDir, libraryDir });

      expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === blockedPath)).toBe(false);
      expect(report.preserved).toContain(blockedId);
      expect(report.seeded).toContain(siblingId);
      expectReportedError(report.errors, blockedId);
    },
  );

  it.each(['symlink', 'directory', 'oversized', 'fifo'] as const)(
    'rejects a packaged $type before read and continues with a valid sibling',
    (type) => {
      const blockedId = `packaged-${type}`;
      const siblingId = `packaged-sibling-${type}`;
      const blockedPath = join(seedDir, `${blockedId}.md`);
      writeSeed(seedDir, siblingId, syntheticSeed({ id: siblingId }));

      if (type === 'symlink') {
        const target = join(temporaryRoot, 'packaged-symlink-target.md');
        fs.writeFileSync(target, syntheticSeed({ id: blockedId }), 'utf8');
        fs.symlinkSync(target, blockedPath);
      } else if (type === 'directory') {
        fs.mkdirSync(blockedPath);
      } else if (type === 'oversized') {
        fs.writeFileSync(blockedPath, 'x'.repeat(MAX_PERSONALITY_FILE_BYTES + 1));
      } else if (!makeFifo(blockedPath)) {
        return;
      }

      const readSpy = guardReadPaths([blockedPath]);
      const report = seedBuiltInPersonalities({ seedDir, libraryDir });

      expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === blockedPath)).toBe(false);
      expect(report.seeded).toContain(siblingId);
      expect(fs.existsSync(join(libraryDir, `${blockedId}.md`))).toBe(false);
      expectReportedError(report.errors, blockedId);
    },
  );

  it('allows an exactly 2 MiB packaged seed and never reads a 2 MiB plus one sibling', () => {
    const allowedId = 'packaged-boundary';
    const blockedId = 'packaged-too-large';
    const allowedPath = writeSeed(
      seedDir,
      allowedId,
      padUtf8(syntheticSeed({ id: allowedId }), MAX_PERSONALITY_FILE_BYTES),
    );
    const blockedPath = writeSeed(
      seedDir,
      blockedId,
      padUtf8(syntheticSeed({ id: blockedId }), MAX_PERSONALITY_FILE_BYTES + 1),
    );
    const openSpy = vi.spyOn(fs, 'openSync');
    const readSpy = guardReadPaths([blockedPath]);

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(fs.statSync(allowedPath).size).toBe(MAX_PERSONALITY_FILE_BYTES);
    expect(report.seeded).toContain(allowedId);
    expect(openSpy.mock.calls.some(([filePath]) => String(filePath) === allowedPath)).toBe(true);
    expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === blockedPath)).toBe(false);
    expectReportedError(report.errors, blockedId);
  });

  it('allows an exactly 2 MiB installed candidate to participate in a pristine upgrade', () => {
    const id = 'installed-boundary';
    const generatedHashLineBytes = Buffer.byteLength(`pristineHash: "${'0'.repeat(64)}"\n`, 'utf8');
    const oldSeed = padUtf8(
      syntheticSeed({ id, revision: 1 }),
      MAX_PERSONALITY_FILE_BYTES - generatedHashLineBytes,
    );
    writeSeed(seedDir, id, oldSeed);
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const installedPath = join(libraryDir, `${id}.md`);
    expect(fs.statSync(installedPath).size).toBe(MAX_PERSONALITY_FILE_BYTES);
    writeSeed(seedDir, id, syntheticSeed({ id, revision: 2, body: 'Boundary upgraded' }));

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.upgraded).toEqual([id]);
    expect(readFileSync(installedPath, 'utf8')).toBe(
      materializePersonalitySeed(syntheticSeed({ id, revision: 2, body: 'Boundary upgraded' })),
    );
  });

  it('isolates malformed and unreadable packaged candidates from a valid sibling', () => {
    const malformedId = 'malformed-packaged';
    const unreadableId = 'unreadable-packaged';
    const siblingId = 'valid-packaged-sibling';
    writeSeed(seedDir, malformedId, '---\nid: [broken\n---\nBroken');
    const unreadablePath = writeSeed(seedDir, unreadableId, syntheticSeed({ id: unreadableId }));
    writeSeed(seedDir, siblingId, syntheticSeed({ id: siblingId }));
    rejectOpenPaths([unreadablePath]);

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.seeded).toEqual([siblingId]);
    expectReportedError(report.errors, malformedId);
    expectReportedError(report.errors, unreadableId);
  });

  it('never touches custom, copied, backup, temp, or unrelated library entries', () => {
    writeSeed(seedDir, 'canonical-built-in', syntheticSeed({ id: 'canonical-built-in' }));
    fs.mkdirSync(libraryDir, { recursive: true });
    const untouched = new Map<string, string>([
      ['local-builder.md', customPersonality('local-builder')],
      ['built-in-copy.md', materializePersonalitySeed(syntheticSeed({ id: 'built-in-copy' }))],
      ['canonical-built-in.md.bak', 'backup bytes'],
      ['canonical-built-in.md.tmp', 'temp bytes'],
      ['notes.txt', 'unrelated bytes'],
    ]);
    for (const [filename, raw] of untouched) {
      fs.writeFileSync(join(libraryDir, filename), raw, 'utf8');
    }

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    expect(report.seeded).toEqual(['canonical-built-in']);
    for (const [filename, raw] of untouched) {
      expect(readFileSync(join(libraryDir, filename), 'utf8')).toBe(raw);
    }
  });

  it('keeps the previous file and removes atomic temp files when an upgrade write fails', () => {
    if (process.getuid?.() === 0) return;
    const id = 'failed-upgrade';
    writeSeed(seedDir, id, syntheticSeed({ id, revision: 1, body: 'Stable old body' }));
    seedBuiltInPersonalities({ seedDir, libraryDir });
    const installedPath = join(libraryDir, `${id}.md`);
    const before = readFileSync(installedPath, 'utf8');
    writeSeed(seedDir, id, syntheticSeed({ id, revision: 2, body: 'Blocked new body' }));
    fs.chmodSync(libraryDir, 0o500);

    const report = seedBuiltInPersonalities({ seedDir, libraryDir });

    fs.chmodSync(libraryDir, 0o700);
    expect(readFileSync(installedPath, 'utf8')).toBe(before);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
    expect(report.upgraded).toEqual([]);
    expect(report.preserved).toContain(id);
    expectReportedError(report.errors, id);
  });
});

describe('D-07/D-15/D-16 bounded personality catalog reads', () => {
  let temporaryRoot: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-catalog-'));
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeLibraryFile(id: string, raw: string): string {
    const filePath = join(libraryDir, `${id}.md`);
    fs.writeFileSync(filePath, raw, 'utf8');
    return filePath;
  }

  it('lists the real seeds by name and projects exact summary DTO keys', () => {
    const seedDir = join(temporaryRoot, 'packaged');
    copyRepositorySeeds(seedDir);
    expect(seedBuiltInPersonalities({ seedDir, libraryDir }).errors).toEqual([]);

    const summaries = listPersonalities(libraryDir);

    expect(summaries.map(({ name }) => name)).toEqual([
      'AI Engineer',
      'Code Quality Engineer',
      'Principal Engineer',
    ]);
    expect(summaries.map(({ id }) => id)).toEqual([
      'ai-engineer',
      'code-quality-engineer',
      'principal-engineer',
    ]);
    for (const summary of summaries) {
      expect(Object.keys(summary)).toEqual([
        'id',
        'name',
        'badge',
        'color',
        'builtin',
        'modifiedFromSeed',
      ]);
    }
  });

  it('sorts equal display names by stable ID and re-reads hand edits on every list call', () => {
    const zuluPath = writeLibraryFile(
      'zulu-personality',
      customPersonality('zulu-personality', 'Zulu body', 'Zulu'),
    );
    writeLibraryFile('same-zulu', customPersonality('same-zulu', 'Same zulu body', 'Same Name'));
    writeLibraryFile('same-alpha', customPersonality('same-alpha', 'Same alpha body', 'Same Name'));

    expect(listPersonalities(libraryDir).map(({ id }) => id)).toEqual([
      'same-alpha',
      'same-zulu',
      'zulu-personality',
    ]);

    fs.writeFileSync(
      zuluPath,
      customPersonality('zulu-personality', 'Edited body', 'Aaron'),
      'utf8',
    );
    expect(listPersonalities(libraryDir).map(({ id }) => id)).toEqual([
      'zulu-personality',
      'same-alpha',
      'same-zulu',
    ]);
  });

  it('isolates malformed, mismatched, invalid-name, and oversized entries from a valid sibling', () => {
    writeLibraryFile(
      'valid-sibling',
      customPersonality('valid-sibling', 'Valid sibling body', 'Valid Sibling'),
    );
    writeLibraryFile('malformed', '---\nid: [broken\n---\nBroken');
    writeLibraryFile('mismatched', customPersonality('different-id'));
    fs.writeFileSync(join(libraryDir, 'invalid name.md'), customPersonality('invalid-name'));
    const oversizedPath = writeLibraryFile(
      'oversized',
      padUtf8(customPersonality('oversized'), MAX_PERSONALITY_FILE_BYTES + 1),
    );
    fs.writeFileSync(join(libraryDir, 'notes.txt'), 'not a personality');
    const readSpy = guardReadPaths([oversizedPath]);
    const warnings: string[] = [];

    const summaries = listPersonalities(libraryDir, (message) => warnings.push(message));

    expect(summaries.map(({ id }) => id)).toEqual(['valid-sibling']);
    expect(warnings.length).toBeGreaterThanOrEqual(4);
    expect(warnings.every((message) => message.length > 0 && message.length <= 500)).toBe(true);
    expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === oversizedPath)).toBe(false);
  });

  it.each(['symlink', 'directory', 'fifo'] as const)(
    'rejects a list %s before read while preserving a valid sibling',
    (type) => {
      const blockedId = `catalog-${type}`;
      const blockedPath = join(libraryDir, `${blockedId}.md`);
      writeLibraryFile(
        'valid-sibling',
        customPersonality('valid-sibling', 'Valid body', 'Valid Sibling'),
      );

      if (type === 'symlink') {
        const target = join(temporaryRoot, 'outside.md');
        fs.writeFileSync(target, customPersonality(blockedId), 'utf8');
        fs.symlinkSync(target, blockedPath);
      } else if (type === 'directory') {
        fs.mkdirSync(blockedPath);
      } else if (!makeFifo(blockedPath)) {
        return;
      }

      const readSpy = guardReadPaths([blockedPath]);
      const warnings: string[] = [];
      const summaries = listPersonalities(libraryDir, (message) => warnings.push(message));

      expect(summaries.map(({ id }) => id)).toEqual(['valid-sibling']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0].length).toBeLessThanOrEqual(500);
      expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === blockedPath)).toBe(false);
    },
  );

  it('allows exactly 2 MiB and rejects 2 MiB plus one before reading it', () => {
    const boundaryPath = writeLibraryFile(
      'boundary',
      padUtf8(customPersonality('boundary'), MAX_PERSONALITY_FILE_BYTES),
    );
    const oversizedPath = writeLibraryFile(
      'too-large',
      padUtf8(customPersonality('too-large'), MAX_PERSONALITY_FILE_BYTES + 1),
    );
    const openSpy = vi.spyOn(fs, 'openSync');
    const readSpy = guardReadPaths([oversizedPath]);

    expect(listPersonalities(libraryDir).map(({ id }) => id)).toEqual(['boundary']);
    expect(fs.statSync(boundaryPath).size).toBe(MAX_PERSONALITY_FILE_BYTES);
    expect(openSpy.mock.calls.some(([filePath]) => String(filePath) === boundaryPath)).toBe(true);
    expect(readSpy.mock.calls.some(([filePath]) => String(filePath) === oversizedPath)).toBe(false);
  });

  it('reads an exact detail DTO and observes metadata and Markdown edits on the next call', () => {
    const filePath = writeLibraryFile(
      'local-builder',
      customPersonality('local-builder', 'Original guidance', 'Local Builder'),
    );

    const first = readPersonality(libraryDir, 'local-builder');
    expect(first).toEqual({
      id: 'local-builder',
      name: 'Local Builder',
      badge: 'LC',
      color: '#ABC',
      builtin: false,
      modifiedFromSeed: false,
      markdown: 'Original guidance',
    });
    expect(Object.keys(first ?? {})).toEqual([
      'id',
      'name',
      'badge',
      'color',
      'builtin',
      'modifiedFromSeed',
      'markdown',
    ]);

    fs.writeFileSync(
      filePath,
      customPersonality('local-builder', 'Hand-edited guidance', 'Renamed Builder'),
      'utf8',
    );
    expect(readPersonality(libraryDir, 'local-builder')).toMatchObject({
      name: 'Renamed Builder',
      markdown: 'Hand-edited guidance',
    });
  });

  it.each(['../state.json', 'nested/personality', 'nested\\personality', `a${'b'.repeat(64)}`])(
    'rejects invalid read ID %s before filesystem access',
    (id) => {
      const openSpy = vi.spyOn(fs, 'openSync');

      expect(() => readPersonality(libraryDir, id)).toThrow(/invalid personality id/i);
      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it('returns null when a detail is absent or disappears before descriptor open', () => {
    expect(readPersonality(libraryDir, 'missing-personality')).toBeNull();

    const disappearingPath = writeLibraryFile('disappearing', customPersonality('disappearing'));
    const originalOpenSync = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (String(args[0]) === disappearingPath) fs.unlinkSync(disappearingPath);
      return Reflect.apply(originalOpenSync, fs, args);
    });

    expect(readPersonality(libraryDir, 'disappearing')).toBeNull();
  });

  it('keeps filesystem paths out of public read errors while retaining a bounded warning', () => {
    const id = 'unreadable-detail';
    const filePath = writeLibraryFile(id, customPersonality(id));
    const originalOpenSync = fs.openSync;
    const warnings: string[] = [];
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (String(args[0]) === filePath) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${filePath}'`), {
          code: 'EACCES',
        });
      }
      return Reflect.apply(originalOpenSync, fs, args);
    });

    expect(() => readPersonality(libraryDir, id, (message) => warnings.push(message))).toThrowError(
      `Invalid personality "${id}"`,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('open failed');
    expect(warnings[0].length).toBeLessThanOrEqual(500);
  });

  it.each(['symlink', 'directory', 'fifo', 'oversized', 'malformed'] as const)(
    'rejects an invalid detail %s with a bounded error and never reads unsafe file types',
    (type) => {
      const id = `detail-${type}`;
      const filePath = join(libraryDir, `${id}.md`);
      let mustRejectBeforeRead = false;

      if (type === 'symlink') {
        const target = join(temporaryRoot, 'detail-outside.md');
        fs.writeFileSync(target, customPersonality(id), 'utf8');
        fs.symlinkSync(target, filePath);
        mustRejectBeforeRead = true;
      } else if (type === 'directory') {
        fs.mkdirSync(filePath);
        mustRejectBeforeRead = true;
      } else if (type === 'fifo') {
        if (!makeFifo(filePath)) return;
        mustRejectBeforeRead = true;
      } else if (type === 'oversized') {
        fs.writeFileSync(filePath, padUtf8(customPersonality(id), MAX_PERSONALITY_FILE_BYTES + 1));
        mustRejectBeforeRead = true;
      } else {
        fs.writeFileSync(filePath, '---\nid: [broken\n---\nBroken');
      }

      const readSpy = mustRejectBeforeRead ? guardReadPaths([filePath]) : null;
      let thrown: unknown;
      try {
        readPersonality(libraryDir, id);
      } catch (error: unknown) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(`Invalid personality "${id}"`);
      expect((thrown as Error).message.length).toBeLessThanOrEqual(500);
      if (readSpy) {
        expect(readSpy.mock.calls.some(([readPath]) => String(readPath) === filePath)).toBe(false);
      }
    },
  );
});

describe('RED: create persistence contract', () => {
  let temporaryRoot: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-create-'));
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.chmodSync(libraryDir, 0o700);
    } catch {
      // The fixture may intentionally replace or remove the library directory.
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('normalizes the name and suffixes around occupied files without overwriting them', () => {
    const basePath = join(libraryDir, 'principal-platform-1.md');
    const secondPath = join(libraryDir, 'principal-platform-1-2.md');
    fs.writeFileSync(basePath, 'occupied base', 'utf8');
    fs.writeFileSync(secondPath, 'occupied suffix', 'utf8');

    const detail = createPersonality(
      libraryDir,
      writeFields({ name: 'Principal: Platform #1', badge: 'pp', color: '#a1b2c3' }),
    );

    expect(detail).toMatchObject({
      id: 'principal-platform-1-3',
      name: 'Principal: Platform #1',
      badge: 'PP',
      color: '#A1B2C3',
      builtin: false,
      modifiedFromSeed: false,
    });
    expect(readFileSync(basePath, 'utf8')).toBe('occupied base');
    expect(readFileSync(secondPath, 'utf8')).toBe('occupied suffix');
  });

  it('falls back for punctuation and Unicode names and truncates before collision suffixes', () => {
    expect(createPersonality(libraryDir, writeFields({ name: '!!!' })).id).toBe('personality');
    expect(createPersonality(libraryDir, writeFields({ name: '你好' })).id).toBe('personality-2');

    const longestBase = 'a'.repeat(64);
    expect(createPersonality(libraryDir, writeFields({ name: longestBase })).id).toBe(longestBase);
    const suffixed = createPersonality(libraryDir, writeFields({ name: longestBase })).id;
    expect(suffixed).toBe(`${'a'.repeat(62)}-2`);
    expect(suffixed).toHaveLength(64);
  });

  it('treats every existing candidate type as occupied without reading it', () => {
    const malformedPath = join(libraryDir, 'malformed.md');
    const symlinkPath = join(libraryDir, 'linked.md');
    const directoryPath = join(libraryDir, 'folder.md');
    const fifoPath = join(libraryDir, 'pipe.md');
    const symlinkTarget = join(temporaryRoot, 'outside.md');
    fs.writeFileSync(malformedPath, '---\nid: [broken', 'utf8');
    fs.writeFileSync(symlinkTarget, 'outside bytes', 'utf8');
    fs.symlinkSync(symlinkTarget, symlinkPath);
    fs.mkdirSync(directoryPath);
    if (!makeFifo(fifoPath)) return;
    const readSpy = guardReadPaths([malformedPath, symlinkPath, directoryPath, fifoPath]);

    expect(createPersonality(libraryDir, writeFields({ name: 'Malformed' })).id).toBe(
      'malformed-2',
    );
    expect(createPersonality(libraryDir, writeFields({ name: 'Linked' })).id).toBe('linked-2');
    expect(createPersonality(libraryDir, writeFields({ name: 'Folder' })).id).toBe('folder-2');
    expect(createPersonality(libraryDir, writeFields({ name: 'Pipe' })).id).toBe('pipe-2');
    expect(
      readSpy.mock.calls.some(([candidatePath]) =>
        [malformedPath, symlinkPath, directoryPath, fifoPath].includes(String(candidatePath)),
      ),
    ).toBe(false);
  });

  it('writes strict canonical custom metadata with a double-quoted color and exact Markdown', () => {
    const markdown = 'You are **careful**.\n\n## Approach\n\n- Preserve bytes';
    const detail = createPersonality(
      libraryDir,
      writeFields({ name: '  Careful Builder  ', badge: ' cb ', color: ' #aBc ', markdown }),
    );
    const raw = readFileSync(join(libraryDir, `${detail.id}.md`), 'utf8');
    const parsed = parsePersonalityMarkdown(raw, {
      mode: 'library',
      expectedId: 'careful-builder',
    });

    expect(detail).toEqual({
      id: 'careful-builder',
      name: 'Careful Builder',
      badge: 'CB',
      color: '#ABC',
      builtin: false,
      modifiedFromSeed: false,
      markdown,
    });
    expect(parsed).toEqual({ metadata: detailWithoutMarkdown(detail), markdown });
    expect(raw).toContain('color: "#ABC"');
    expect(raw).toContain('builtin: false');
    expect(raw).not.toMatch(/seedRevision|pristineHash/);
  });

  it('keeps YAML-looking names as one scalar instead of injecting metadata', () => {
    const name = 'Builder: #1\nbuiltin: true\nid: hijacked';
    const detail = createPersonality(libraryDir, writeFields({ name }));
    const raw = readFileSync(join(libraryDir, `${detail.id}.md`), 'utf8');
    const parsed = parsePersonalityMarkdown(raw, {
      mode: 'library',
      expectedId: detail.id,
    });

    expect(parsed.metadata.name).toBe(name);
    expect(parsed.metadata.builtin).toBe(false);
    expect(parsed.metadata.id).toBe(detail.id);
    expect(raw).not.toContain('\nbuiltin: true\n');
    expect(raw).not.toContain('\nid: hijacked\n');
  });

  it('enforces the complete UTF-8 document boundary before writing', () => {
    const fields = writeFields({ name: 'Byte Boundary', markdown: 'x' });
    const probe = createPersonality(libraryDir, fields);
    const targetPath = join(libraryDir, `${probe.id}.md`);
    const overhead = Buffer.byteLength(readFileSync(targetPath, 'utf8'), 'utf8') - 1;
    fs.unlinkSync(targetPath);

    const boundaryMarkdown = utf8Payload(MAX_PERSONALITY_FILE_BYTES - overhead);
    const boundary = createPersonality(libraryDir, { ...fields, markdown: boundaryMarkdown });
    expect(fs.statSync(join(libraryDir, `${boundary.id}.md`)).size).toBe(
      MAX_PERSONALITY_FILE_BYTES,
    );
    expect(boundary.markdown).toBe(boundaryMarkdown);
    fs.unlinkSync(join(libraryDir, `${boundary.id}.md`));

    expect(() =>
      createPersonality(libraryDir, { ...fields, markdown: `${boundaryMarkdown}x` }),
    ).toThrow(/2 MiB|2097152|too large|exceeds/i);
    expect(fs.existsSync(targetPath)).toBe(false);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
  });

  it('preserves occupied state and removes temporary files when the atomic write fails', () => {
    if (process.getuid?.() === 0) return;
    const occupiedPath = join(libraryDir, 'stable-target.md');
    const attemptedPath = join(libraryDir, 'stable-target-2.md');
    fs.writeFileSync(occupiedPath, 'stable bytes', 'utf8');
    fs.chmodSync(libraryDir, 0o500);

    let thrown: unknown;
    try {
      createPersonality(libraryDir, writeFields({ name: 'Stable Target' }));
    } catch (error: unknown) {
      thrown = error;
    }

    fs.chmodSync(libraryDir, 0o700);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/not implemented/i);
    expect(readFileSync(occupiedPath, 'utf8')).toBe('stable bytes');
    expect(fs.existsSync(attemptedPath)).toBe(false);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
  });
});

describe('built-in copy byte identity regression', () => {
  it('creates from narrow built-in fields without changing installed or packaged bytes', () => {
    const temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-copy-bytes-'));
    const seedDir = join(temporaryRoot, 'packaged');
    const libraryDir = join(temporaryRoot, 'library');
    const id = 'copy-source';
    const rawSeed = syntheticSeed({ id, name: 'Copy Source', body: 'Original built-in guidance' });

    try {
      const seedPath = writeSeed(seedDir, id, rawSeed);
      expect(seedBuiltInPersonalities({ seedDir, libraryDir }).errors).toEqual([]);
      const installedPath = join(libraryDir, `${id}.md`);
      const installedBefore = readFileSync(installedPath, 'utf8');
      const packagedBefore = readFileSync(seedPath, 'utf8');
      const source = readPersonality(libraryDir, id);
      if (source === null) throw new Error('Expected built-in copy source');

      const copy = createPersonality(libraryDir, {
        name: `${source.name} Copy`,
        badge: source.badge,
        color: source.color,
        markdown: source.markdown,
        ...(source.defaultAgent === undefined ? {} : { defaultAgent: source.defaultAgent }),
        ...(source.defaultModel === undefined ? {} : { defaultModel: source.defaultModel }),
        ...(source.defaultReasoningEffort === undefined
          ? {}
          : { defaultReasoningEffort: source.defaultReasoningEffort }),
      });

      expect(copy).toMatchObject({
        id: 'copy-source-copy',
        name: 'Copy Source Copy',
        builtin: false,
        markdown: 'Original built-in guidance',
      });
      expect(readFileSync(installedPath, 'utf8')).toBe(installedBefore);
      expect(readFileSync(seedPath, 'utf8')).toBe(packagedBefore);
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});

describe('RED: stable update contract', () => {
  let temporaryRoot: string;
  let libraryDir: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(join(os.tmpdir(), 'personality-update-'));
    libraryDir = join(temporaryRoot, 'library');
    fs.mkdirSync(libraryDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.chmodSync(libraryDir, 0o700);
    } catch {
      // The fixture may intentionally leave no writable library directory.
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function writeCustom(id: string, raw = customPersonality(id)): string {
    const filePath = join(libraryDir, `${id}.md`);
    fs.writeFileSync(filePath, raw, 'utf8');
    return filePath;
  }

  function rejectedUpdate(id: string, fields = writeFields()): Error {
    let thrown: unknown;
    try {
      updatePersonality(libraryDir, id, fields);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error;
    expect(error.message).not.toMatch(/not implemented/i);
    expect(error.message).not.toContain(temporaryRoot);
    expect(error.message.length).toBeLessThanOrEqual(500);
    return error;
  }

  it('keeps the stable ID and filename while persisting every editable field and unknown scalar', () => {
    const id = 'stable-builder';
    const filePath = writeCustom(
      id,
      personalityDocument(
        [
          `id: ${id}`,
          'name: Stable Builder',
          'badge: SB',
          "color: '#ABC'",
          'builtin: false',
          'defaultAgent: claude-code',
          'defaultModel: fable',
          'futureText: enabled',
          'futureNumber: 2',
          'futureBoolean: true',
          'futureNull: null',
        ],
        { body: 'Original custom guidance' },
      ),
    );

    const detail = updatePersonality(
      libraryDir,
      id,
      writeFields({
        name: '  Renamed Platform Builder  ',
        badge: 'rp',
        color: '#a1b2c3',
        markdown: 'Updated custom guidance',
        defaultAgent: 'opencode',
        defaultModel: '  anthropic/claude:opus#beta  ',
        defaultReasoningEffort: '  max  ',
      }),
    );
    const raw = readFileSync(filePath, 'utf8');

    expect(detail).toEqual({
      id,
      name: 'Renamed Platform Builder',
      badge: 'RP',
      color: '#A1B2C3',
      builtin: false,
      modifiedFromSeed: false,
      markdown: 'Updated custom guidance',
      defaultAgent: 'opencode',
      defaultModel: 'anthropic/claude:opus#beta',
      defaultReasoningEffort: 'max',
    });
    expect(parsePersonalityMarkdown(raw, { mode: 'library', expectedId: id }).metadata.id).toBe(id);
    expect(raw).toContain('futureText: enabled');
    expect(raw).toContain('futureNumber: 2');
    expect(raw).toContain('futureBoolean: true');
    expect(raw).toContain('futureNull: null');
    expect(fs.existsSync(join(libraryDir, 'renamed-platform-builder.md'))).toBe(false);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
  });

  it('removes known optional bindings when the updated fields omit them', () => {
    const id = 'clear-bindings';
    const filePath = writeCustom(
      id,
      personalityDocument(
        [
          `id: ${id}`,
          'name: Clear Bindings',
          'badge: CB',
          "color: '#ABC'",
          'builtin: false',
          'defaultAgent: codex',
          'defaultModel: gpt-5.6-sol',
          'defaultReasoningEffort: max',
          'futureFlag: retained',
        ],
        { body: 'Bound guidance' },
      ),
    );

    const detail = updatePersonality(
      libraryDir,
      id,
      writeFields({ name: 'Clear Bindings', markdown: 'Unbound guidance' }),
    );
    const raw = readFileSync(filePath, 'utf8');

    expect(detail).not.toHaveProperty('defaultAgent');
    expect(detail).not.toHaveProperty('defaultModel');
    expect(detail).not.toHaveProperty('defaultReasoningEffort');
    expect(raw).not.toMatch(/defaultAgent|defaultModel|defaultReasoningEffort/);
    expect(raw).toContain('futureFlag: retained');
  });

  it('rejects built-ins without changing their exact bytes or creating a backup', () => {
    const id = 'immutable-built-in';
    const installed = materializePersonalitySeed(
      syntheticSeed({ id, name: 'Immutable Built-In', body: 'Packaged guidance' }),
    );
    const filePath = writeCustom(id, installed);

    rejectedUpdate(id, writeFields({ name: 'Attempted Rename' }));

    expect(readFileSync(filePath, 'utf8')).toBe(installed);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
  });

  it.each([
    'symlink',
    'directory',
    'fifo',
    'oversized',
    'malformed',
    'mismatched',
    'missing',
  ] as const)('rejects an unsafe %s target without replacing it', (type) => {
    const id = `unsafe-${type}`;
    const filePath = join(libraryDir, `${id}.md`);
    let expectedBytes: string | undefined;
    let symlinkTarget: string | undefined;

    if (type === 'symlink') {
      symlinkTarget = join(temporaryRoot, 'outside.md');
      expectedBytes = customPersonality(id, 'Outside bytes');
      fs.writeFileSync(symlinkTarget, expectedBytes, 'utf8');
      fs.symlinkSync(symlinkTarget, filePath);
    } else if (type === 'directory') {
      fs.mkdirSync(filePath);
    } else if (type === 'fifo') {
      if (!makeFifo(filePath)) return;
    } else if (type === 'oversized') {
      expectedBytes = padUtf8(customPersonality(id), MAX_PERSONALITY_FILE_BYTES + 1);
      fs.writeFileSync(filePath, expectedBytes, 'utf8');
    } else if (type === 'malformed') {
      expectedBytes = '---\nid: [broken\n---\nBroken';
      fs.writeFileSync(filePath, expectedBytes, 'utf8');
    } else if (type === 'mismatched') {
      expectedBytes = customPersonality('different-id');
      fs.writeFileSync(filePath, expectedBytes, 'utf8');
    }

    rejectedUpdate(id);

    if (type === 'missing') {
      expect(fs.existsSync(filePath)).toBe(false);
    } else if (type === 'symlink') {
      if (symlinkTarget === undefined) throw new Error('Missing symlink target fixture');
      expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
      expect(readFileSync(symlinkTarget, 'utf8')).toBe(expectedBytes);
    } else if (type === 'directory') {
      expect(fs.lstatSync(filePath).isDirectory()).toBe(true);
    } else if (type === 'fifo') {
      expect(fs.lstatSync(filePath).isFIFO()).toBe(true);
    } else {
      expect(readFileSync(filePath, 'utf8')).toBe(expectedBytes);
    }
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
  });

  it.each(['../state.json', 'nested/personality', 'nested\\personality', `a${'b'.repeat(64)}`])(
    'rejects invalid update ID %s before opening the filesystem',
    (id) => {
      const openSpy = vi.spyOn(fs, 'openSync');

      rejectedUpdate(id);

      expect(openSpy).not.toHaveBeenCalled();
    },
  );

  it('opens, validates, and reads one descriptor and always closes it', () => {
    const id = 'descriptor-contract';
    const filePath = writeCustom(id);
    const originalOpenSync = fs.openSync;
    let descriptor = -1;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const fd = Reflect.apply(originalOpenSync, fs, args);
      if (String(args[0]) === filePath) descriptor = fd;
      return fd;
    });
    const fstatSpy = vi.spyOn(fs, 'fstatSync');
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(readPersonality(libraryDir, id)?.id).toBe(id);

    expect(openSpy).toHaveBeenCalledWith(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    );
    expect(descriptor).toBeGreaterThanOrEqual(0);
    expect(fstatSpy).toHaveBeenCalledWith(descriptor);
    expect(readSpy).toHaveBeenCalledWith(descriptor, 'utf8');
    expect(closeSpy).toHaveBeenCalledWith(descriptor);
  });

  it('closes the descriptor when a descriptor-bound read fails', () => {
    const id = 'descriptor-read-failure';
    const filePath = writeCustom(id);
    const originalOpenSync = fs.openSync;
    const originalReadFileSync = fs.readFileSync;
    let descriptor = -1;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      const fd = Reflect.apply(originalOpenSync, fs, args);
      if (String(args[0]) === filePath) descriptor = fd;
      return fd;
    });
    vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
      if (args[0] === descriptor)
        throw Object.assign(new Error('descriptor read failed'), { code: 'EIO' });
      return Reflect.apply(originalReadFileSync, fs, args);
    });
    const closeSpy = vi.spyOn(fs, 'closeSync');

    expect(() => readPersonality(libraryDir, id)).toThrow(`Invalid personality "${id}"`);
    expect(descriptor).toBeGreaterThanOrEqual(0);
    expect(closeSpy).toHaveBeenCalledWith(descriptor);
  });

  it('rejects a target swapped to a symlink at descriptor open', () => {
    const id = 'descriptor-swap';
    const filePath = writeCustom(id, customPersonality(id, 'Original target bytes'));
    const parkedPath = join(temporaryRoot, 'parked-original.md');
    const outsidePath = join(temporaryRoot, 'outside-target.md');
    const outsideBytes = customPersonality(id, 'Outside target bytes');
    fs.writeFileSync(outsidePath, outsideBytes, 'utf8');
    const originalOpenSync = fs.openSync;
    let swapped = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args) => {
      if (!swapped && String(args[0]) === filePath) {
        fs.renameSync(filePath, parkedPath);
        fs.symlinkSync(outsidePath, filePath);
        swapped = true;
      }
      return Reflect.apply(originalOpenSync, fs, args);
    });

    rejectedUpdate(id, writeFields({ markdown: 'Attempted replacement' }));

    expect(swapped).toBe(true);
    expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(outsidePath, 'utf8')).toBe(outsideBytes);
    expect(readFileSync(parkedPath, 'utf8')).toBe(customPersonality(id, 'Original target bytes'));
  });

  it('enforces the complete UTF-8 update boundary before replacement', () => {
    const id = 'update-byte-boundary';
    const filePath = writeCustom(
      id,
      customPersonality(id, 'Original bytes', 'Update Byte Boundary'),
    );
    const fields = writeFields({ name: 'Update Byte Boundary', markdown: 'x' });
    updatePersonality(libraryDir, id, fields);
    const overhead = Buffer.byteLength(readFileSync(filePath, 'utf8'), 'utf8') - 1;
    const boundaryMarkdown = utf8Payload(MAX_PERSONALITY_FILE_BYTES - overhead);

    const boundary = updatePersonality(libraryDir, id, {
      ...fields,
      markdown: boundaryMarkdown,
    });
    const boundaryBytes = readFileSync(filePath, 'utf8');
    expect(Buffer.byteLength(boundaryBytes, 'utf8')).toBe(MAX_PERSONALITY_FILE_BYTES);
    expect(boundary.markdown).toBe(boundaryMarkdown);

    rejectedUpdate(id, { ...fields, markdown: `${boundaryMarkdown}x` });
    expect(readFileSync(filePath, 'utf8')).toBe(boundaryBytes);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
  });

  it('preserves original bytes and creates no backup when the atomic replacement fails', () => {
    if (process.getuid?.() === 0) return;
    const id = 'failed-update';
    const filePath = writeCustom(id, customPersonality(id, 'Stable original bytes'));
    const before = readFileSync(filePath, 'utf8');
    fs.chmodSync(libraryDir, 0o500);

    rejectedUpdate(id, writeFields({ markdown: 'Blocked replacement bytes' }));

    fs.chmodSync(libraryDir, 0o700);
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(fs.existsSync(`${filePath}.bak`)).toBe(false);
    expect(readdirSync(libraryDir).some((name) => name.startsWith('.forge-atomic-'))).toBe(false);
  });
});

function detailWithoutMarkdown({
  markdown: _markdown,
  modifiedFromSeed: _modifiedFromSeed,
  ...summary
}: ReturnType<typeof createPersonality>) {
  return summary;
}
