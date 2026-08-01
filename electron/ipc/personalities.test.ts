import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PersonalityParseError,
  computeInstalledPersonalityPayloadHash,
  isPersonalityId,
  materializePersonalitySeed,
  parsePersonalityMarkdown,
  type ParsePersonalityMarkdownOptions,
} from './personalities.js';

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
    badge: 'QE',
    color: '#2FD198',
    sourcePersona: 'quality.md',
    topics: ['readability', 'naming', 'complexity', 'consistent error handling'],
  },
  {
    filename: 'principal-engineer.md',
    id: 'principal-engineer',
    name: 'Principal Engineer',
    badge: 'PE',
    color: '#7A78FF',
    sourcePersona: 'principal.md',
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
    badge: 'AI',
    color: '#FF944D',
    sourcePersona: 'ai.md',
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
      expect(roleParagraph).toContain(`You are a **${contract.name}**`);
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
