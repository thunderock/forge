import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isMap, isScalar, parseDocument } from 'yaml';
import { atomicWriteFileSync } from '../mcp/atomic.js';
import type { PersonalityDetail, PersonalitySummary } from './shared-types.js';

export type PersonalityParseMode = 'seed' | 'library';

export interface PersonalityMetadata {
  id: string;
  name: string;
  badge: string;
  color: string;
  builtin: boolean;
  seedRevision?: number;
  pristineHash?: string;
}

export interface ParsedPersonalityMarkdown {
  metadata: PersonalityMetadata;
  markdown: string;
}

export interface ParsePersonalityMarkdownOptions {
  mode: PersonalityParseMode;
  expectedId?: string;
}

export interface ResolvePersonalitySeedDirOptions {
  isPackaged: boolean;
  resourcesPath: string;
  mainModuleDir: string;
}

export interface SeedBuiltInPersonalitiesOptions {
  seedDir: string;
  libraryDir: string;
}

export interface PersonalitySeedError {
  id?: string;
  message: string;
}

export interface PersonalitySeedReport {
  seeded: string[];
  upgraded: string[];
  preserved: string[];
  unchanged: string[];
  errors: PersonalitySeedError[];
}

export class PersonalityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonalityParseError';
  }
}

interface FrontmatterEnvelope {
  frontmatter: string;
  frontmatterStart: number;
  closingDelimiterStart: number;
  markdown: string;
  newline: '\n' | '\r\n';
}

interface MetadataEntry {
  quoted: boolean;
  lineStart: number;
  lineEnd: number;
}

interface ParsedMetadata {
  entries: Map<string, MetadataEntry>;
  values: Map<string, unknown>;
}

interface InternalParseResult {
  envelope: FrontmatterEnvelope;
  metadataEntries: Map<string, MetadataEntry>;
  personality: ParsedPersonalityMarkdown;
}

const BOM = '\uFEFF';
const METADATA_KEY = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PERSONALITY_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PERSONALITY_BADGE = /^[A-Z0-9]{1,4}$/;
const PERSONALITY_COLOR = /^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export const MAX_PERSONALITY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEED_ERROR_MESSAGE_CHARS = 500;

type CandidateReadResult =
  | { status: 'ok'; raw: string }
  | { status: 'missing' }
  | { status: 'invalid'; message: string };

function fail(message: string): never {
  throw new PersonalityParseError(message);
}

function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (error instanceof PersonalityParseError) throw error;
    const detail = error instanceof Error ? error.message : 'Unknown parse failure';
    throw new PersonalityParseError(detail);
  }
}

function splitOpeningFrontmatter(raw: string): FrontmatterEnvelope {
  const openingStart = raw.startsWith(BOM) ? BOM.length : 0;
  let newline: '\n' | '\r\n';
  let frontmatterStart: number;

  if (raw.startsWith('---\r\n', openingStart)) {
    newline = '\r\n';
    frontmatterStart = openingStart + 5;
  } else if (raw.startsWith('---\n', openingStart)) {
    newline = '\n';
    frontmatterStart = openingStart + 4;
  } else {
    return fail('Personality document must start with an opening --- delimiter');
  }

  let lineStart = frontmatterStart;
  while (lineStart < raw.length) {
    const lineFeed = raw.indexOf('\n', lineStart);
    if (lineFeed === -1) break;
    const lineEnd = lineFeed > lineStart && raw[lineFeed - 1] === '\r' ? lineFeed - 1 : lineFeed;

    if (raw.slice(lineStart, lineEnd) === '---') {
      const markdown = raw.slice(lineFeed + 1);
      if (markdown.trim().length === 0) return fail('Personality markdown body must not be empty');
      return {
        frontmatter: raw.slice(frontmatterStart, lineStart),
        frontmatterStart,
        closingDelimiterStart: lineStart,
        markdown,
        newline,
      };
    }

    lineStart = lineFeed + 1;
  }

  return fail('Personality document must contain a closing --- delimiter');
}

function metadataLineRange(
  frontmatter: string,
  keyStart: number,
): Pick<MetadataEntry, 'lineStart' | 'lineEnd'> {
  const lineStart = frontmatter.lastIndexOf('\n', keyStart - 1) + 1;
  const lineFeed = frontmatter.indexOf('\n', keyStart);
  if (lineFeed === -1) return fail('Metadata entry must end before the closing delimiter');
  return { lineStart, lineEnd: lineFeed + 1 };
}

function parseMetadata(frontmatter: string): ParsedMetadata {
  const document = parseDocument(frontmatter, {
    version: '1.2',
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    merge: false,
    resolveKnownTags: false,
  });

  if (document.errors.length > 0) return fail(document.errors[0].message);
  if (!isMap(document.contents) || document.contents.flow) {
    return fail('Personality frontmatter must be a block mapping');
  }

  const entries = new Map<string, MetadataEntry>();
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== 'string') {
      return fail('Personality metadata keys must be strings');
    }
    if (!METADATA_KEY.test(pair.key.value)) {
      return fail('Personality metadata keys must start with a letter');
    }
    if (pair.key.tag || pair.key.anchor)
      return fail('Tagged or anchored metadata keys are forbidden');
    if (pair.key.value === '<<') return fail('YAML merge keys are forbidden');
    if (!isScalar(pair.value)) return fail('Personality metadata values must be scalars');
    if (pair.value.tag || pair.value.anchor) {
      return fail('Tagged or anchored metadata values are forbidden');
    }
    if (entries.has(pair.key.value)) return fail(`Duplicate metadata key: ${pair.key.value}`);
    if (!pair.key.range) return fail(`Missing source range for metadata key: ${pair.key.value}`);

    entries.set(pair.key.value, {
      quoted: pair.value.type === 'QUOTE_DOUBLE' || pair.value.type === 'QUOTE_SINGLE',
      ...metadataLineRange(frontmatter, pair.key.range[0]),
    });
  }

  const converted: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  if (!(converted instanceof Map)) return fail('Personality frontmatter must resolve to a mapping');

  const values = new Map<string, unknown>();
  for (const [key, value] of converted) {
    if (typeof key !== 'string') return fail('Personality metadata keys must resolve to strings');
    values.set(key, value);
  }
  if (values.size !== entries.size) return fail('Personality metadata did not resolve one-to-one');

  return { entries, values };
}

function requiredValue(values: Map<string, unknown>, key: string): unknown {
  if (!values.has(key)) return fail(`Missing required personality field: ${key}`);
  return values.get(key);
}

function requiredString(values: Map<string, unknown>, key: string): string {
  const value = requiredValue(values, key);
  if (typeof value !== 'string') return fail(`Personality field ${key} must be a string`);
  return value;
}

function requireQuoted(entries: Map<string, MetadataEntry>, key: string): void {
  if (!entries.get(key)?.quoted) return fail(`Personality field ${key} must be quoted`);
}

function positiveSeedRevision(values: Map<string, unknown>): number {
  const value = requiredValue(values, 'seedRevision');
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return fail('Personality field seedRevision must be a positive safe integer');
  }
  return value;
}

function pristineHash(values: Map<string, unknown>, entries: Map<string, MetadataEntry>): string {
  const value = requiredString(values, 'pristineHash');
  requireQuoted(entries, 'pristineHash');
  if (!SHA256_HEX.test(value)) {
    return fail('Personality field pristineHash must be a lowercase SHA-256 digest');
  }
  return value;
}

function validateMetadata(
  parsed: ParsedMetadata,
  options: ParsePersonalityMarkdownOptions,
): PersonalityMetadata {
  const { entries, values } = parsed;
  const id = requiredString(values, 'id');
  if (!isPersonalityId(id)) return fail('Personality field id is invalid');
  if (options.expectedId !== undefined) {
    if (!isPersonalityId(options.expectedId)) return fail('Expected personality ID is invalid');
    if (id !== options.expectedId) return fail('Personality ID does not match its filename stem');
  }

  const name = requiredString(values, 'name').trim();
  if (name.length === 0 || name.length > 80) {
    return fail('Personality field name must contain 1 to 80 trimmed characters');
  }

  const badge = requiredString(values, 'badge');
  if (!PERSONALITY_BADGE.test(badge)) {
    return fail('Personality field badge must contain 1 to 4 uppercase letters or digits');
  }

  const color = requiredString(values, 'color');
  requireQuoted(entries, 'color');
  if (!PERSONALITY_COLOR.test(color)) {
    return fail('Personality field color must be a quoted #RGB or #RRGGBB value');
  }

  const builtin = requiredValue(values, 'builtin');
  if (typeof builtin !== 'boolean') return fail('Personality field builtin must be a boolean');

  if (options.mode === 'seed') {
    if (!builtin) return fail('Packaged personality seeds must be built in');
    if (values.has('pristineHash'))
      return fail('Packaged personality seeds must omit pristineHash');
    return { id, name, badge, color, builtin, seedRevision: positiveSeedRevision(values) };
  }
  if (options.mode !== 'library') return fail('Unknown personality parse mode');

  if (builtin) {
    return {
      id,
      name,
      badge,
      color,
      builtin,
      seedRevision: positiveSeedRevision(values),
      pristineHash: pristineHash(values, entries),
    };
  }

  if (values.has('seedRevision') || values.has('pristineHash')) {
    return fail('Custom personalities must omit built-in seed fields');
  }
  return { id, name, badge, color, builtin };
}

function parseInternal(raw: string, options: ParsePersonalityMarkdownOptions): InternalParseResult {
  const envelope = splitOpeningFrontmatter(raw);
  const parsedMetadata = parseMetadata(envelope.frontmatter);
  return {
    envelope,
    metadataEntries: parsedMetadata.entries,
    personality: {
      metadata: validateMetadata(parsedMetadata, options),
      markdown: envelope.markdown,
    },
  };
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, MAX_SEED_ERROR_MESSAGE_CHARS);
}

function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function readRegularCandidate(filePath: string): CandidateReadResult {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error: unknown) {
    if (isFileNotFound(error)) return { status: 'missing' };
    return { status: 'invalid', message: `lstat failed: ${errorDetail(error)}` };
  }

  if (stats.isSymbolicLink()) {
    return { status: 'invalid', message: 'candidate is a symbolic link' };
  }
  if (!stats.isFile()) {
    return { status: 'invalid', message: 'candidate is not a regular file' };
  }
  if (stats.size > MAX_PERSONALITY_FILE_BYTES) {
    return {
      status: 'invalid',
      message: `candidate exceeds ${MAX_PERSONALITY_FILE_BYTES} bytes`,
    };
  }

  try {
    return { status: 'ok', raw: fs.readFileSync(filePath, 'utf8') };
  } catch (error: unknown) {
    return { status: 'invalid', message: `read failed: ${errorDetail(error)}` };
  }
}

function addSeedError(
  report: PersonalitySeedReport,
  id: string | undefined,
  message: string,
): void {
  const boundedMessage = message.slice(0, MAX_SEED_ERROR_MESSAGE_CHARS);
  report.errors.push(
    id === undefined ? { message: boundedMessage } : { id, message: boundedMessage },
  );
}

function preserveWithError(report: PersonalitySeedReport, id: string, message: string): void {
  report.preserved.push(id);
  addSeedError(report, id, message);
}

function backupInstalledPersonalityBestEffort(installedPath: string): void {
  try {
    const stats = fs.lstatSync(installedPath);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_PERSONALITY_FILE_BYTES) {
      return;
    }
    fs.copyFileSync(installedPath, `${installedPath}.bak`);
  } catch {
    // A backup failure must not block an otherwise safe atomic upgrade.
  }
}

export function parsePersonalityMarkdown(
  raw: string,
  options: ParsePersonalityMarkdownOptions,
): ParsedPersonalityMarkdown {
  return guarded(() => parseInternal(raw, options).personality);
}

export function materializePersonalitySeed(rawSeed: string): string {
  return guarded(() => {
    const { envelope } = parseInternal(rawSeed, { mode: 'seed' });
    const generatedLine = `pristineHash: "${sha256(rawSeed)}"${envelope.newline}`;
    return (
      rawSeed.slice(0, envelope.closingDelimiterStart) +
      generatedLine +
      rawSeed.slice(envelope.closingDelimiterStart)
    );
  });
}

export function computeInstalledPersonalityPayloadHash(installedRaw: string): string {
  return guarded(() => {
    const parsed = parseInternal(installedRaw, { mode: 'library' });
    if (!parsed.personality.metadata.builtin) {
      return fail('Only built-in personalities have an installed payload hash');
    }
    const hashEntry = parsed.metadataEntries.get('pristineHash');
    if (!hashEntry) return fail('Installed built-in is missing its pristineHash line');
    const lineStart = parsed.envelope.frontmatterStart + hashEntry.lineStart;
    const lineEnd = parsed.envelope.frontmatterStart + hashEntry.lineEnd;
    return sha256(installedRaw.slice(0, lineStart) + installedRaw.slice(lineEnd));
  });
}

export function isPersonalityId(id: unknown): id is string {
  return typeof id === 'string' && PERSONALITY_ID.test(id);
}

export function listPersonalities(
  _libraryDir: string,
  _warn?: (message: string) => void,
): PersonalitySummary[] {
  throw new Error('Personality catalog listing is not implemented');
}

export function readPersonality(
  _libraryDir: string,
  _id: string,
  _warn?: (message: string) => void,
): PersonalityDetail | null {
  throw new Error('Personality catalog reads are not implemented');
}

export function resolvePersonalitySeedDir(options: ResolvePersonalitySeedDirOptions): string {
  if (options.isPackaged) {
    return path.join(options.resourcesPath, 'seeds', 'personalities');
  }
  return path.join(options.mainModuleDir, '..', 'seeds', 'personalities');
}

export function seedBuiltInPersonalities(
  options: SeedBuiltInPersonalitiesOptions,
): PersonalitySeedReport {
  const report: PersonalitySeedReport = {
    seeded: [],
    upgraded: [],
    preserved: [],
    unchanged: [],
    errors: [],
  };

  let seedFilenames: string[];
  try {
    seedFilenames = fs
      .readdirSync(options.seedDir)
      .filter((filename) => filename.endsWith('.md'))
      .sort();
  } catch (error: unknown) {
    addSeedError(report, undefined, `Unable to enumerate personality seeds: ${errorDetail(error)}`);
    return report;
  }

  for (const filename of seedFilenames) {
    const id = filename.slice(0, -3);
    if (!isPersonalityId(id)) {
      addSeedError(report, undefined, `Invalid packaged personality filename: ${filename}`);
      continue;
    }

    const seedPath = path.join(options.seedDir, filename);
    const seedRead = readRegularCandidate(seedPath);
    if (seedRead.status !== 'ok') {
      const message =
        seedRead.status === 'missing'
          ? 'Packaged personality disappeared before it could be read'
          : `Invalid packaged personality: ${seedRead.message}`;
      addSeedError(report, id, message);
      continue;
    }

    let parsedSeed: ParsedPersonalityMarkdown;
    let materializedSeed: string;
    try {
      parsedSeed = parsePersonalityMarkdown(seedRead.raw, { mode: 'seed', expectedId: id });
      materializedSeed = materializePersonalitySeed(seedRead.raw);
    } catch (error: unknown) {
      addSeedError(report, id, `Invalid packaged personality: ${errorDetail(error)}`);
      continue;
    }

    const packagedRevision = parsedSeed.metadata.seedRevision;
    if (packagedRevision === undefined) {
      addSeedError(report, id, 'Packaged personality is missing seedRevision');
      continue;
    }

    const installedPath = path.join(options.libraryDir, filename);
    const installedRead = readRegularCandidate(installedPath);
    if (installedRead.status === 'missing') {
      try {
        fs.mkdirSync(options.libraryDir, { recursive: true });
        atomicWriteFileSync(installedPath, materializedSeed);
        report.seeded.push(id);
      } catch (error: unknown) {
        addSeedError(report, id, `Unable to seed personality: ${errorDetail(error)}`);
      }
      continue;
    }
    if (installedRead.status === 'invalid') {
      preserveWithError(
        report,
        id,
        `Installed personality was preserved: ${installedRead.message}`,
      );
      continue;
    }

    let parsedInstalled: ParsedPersonalityMarkdown;
    try {
      parsedInstalled = parsePersonalityMarkdown(installedRead.raw, {
        mode: 'library',
        expectedId: id,
      });
    } catch (error: unknown) {
      preserveWithError(
        report,
        id,
        `Installed personality was preserved because it is invalid: ${errorDetail(error)}`,
      );
      continue;
    }

    const installedMetadata = parsedInstalled.metadata;
    if (
      !installedMetadata.builtin ||
      installedMetadata.seedRevision === undefined ||
      installedMetadata.pristineHash === undefined
    ) {
      preserveWithError(
        report,
        id,
        'Installed personality was preserved because it is not a versioned built-in',
      );
      continue;
    }

    if (packagedRevision <= installedMetadata.seedRevision) {
      report.unchanged.push(id);
      continue;
    }

    let installedPayloadHash: string;
    try {
      installedPayloadHash = computeInstalledPersonalityPayloadHash(installedRead.raw);
    } catch (error: unknown) {
      preserveWithError(
        report,
        id,
        `Installed personality was preserved because its payload could not be hashed: ${errorDetail(error)}`,
      );
      continue;
    }

    if (installedPayloadHash !== installedMetadata.pristineHash) {
      preserveWithError(
        report,
        id,
        'Installed personality was preserved because its content has been edited',
      );
      continue;
    }

    backupInstalledPersonalityBestEffort(installedPath);
    try {
      atomicWriteFileSync(installedPath, materializedSeed);
      report.upgraded.push(id);
    } catch (error: unknown) {
      preserveWithError(report, id, `Personality upgrade failed: ${errorDetail(error)}`);
    }
  }

  return report;
}
