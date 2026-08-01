import { createHash } from 'node:crypto';
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
