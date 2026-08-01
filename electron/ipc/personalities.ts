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

export class PersonalityParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonalityParseError';
  }
}

function unavailable(): never {
  throw new PersonalityParseError('Personality document parsing is not implemented');
}

export function parsePersonalityMarkdown(
  raw: string,
  options: ParsePersonalityMarkdownOptions,
): ParsedPersonalityMarkdown {
  void raw;
  void options;
  return unavailable();
}

export function materializePersonalitySeed(rawSeed: string): string {
  void rawSeed;
  return unavailable();
}

export function computeInstalledPersonalityPayloadHash(installedRaw: string): string {
  void installedRaw;
  return unavailable();
}

export function isPersonalityId(id: unknown): id is string {
  void id;
  return false;
}
