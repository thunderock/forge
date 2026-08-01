import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from './ipc/channels.js';

const REGISTER_PATH = join(__dirname, 'ipc', 'register.ts');
const PERSONALITIES_PATH = join(__dirname, 'ipc', 'personalities.ts');
const SHARED_TYPES_PATH = join(__dirname, 'ipc', 'shared-types.ts');
const RENDERER_TYPES_PATH = join(__dirname, '..', 'src', 'ipc', 'types.ts');
const FORBIDDEN_CONTRACT_FIELDS = [
  'path',
  'filePath',
  'filename',
  'projectId',
  'seedRevision',
  'pristineHash',
] as const;

function interfaceDeclaration(source: string, name: string): string {
  const match = new RegExp(
    `export interface ${name}(?: extends [^{]+)? \\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  return match?.[0] ?? '';
}

function declaredKeys(declaration: string): string[] {
  return [...declaration.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)(?:\?)?:/gm)].map(
    (match) => match[1],
  );
}

function handlerSource(source: string, channel: string): string {
  const start = source.indexOf(`ipcMain.handle(IPC.${channel}`);
  if (start === -1) return '';
  const next = source.indexOf('ipcMain.handle(IPC.', start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('personality IPC contract', () => {
  it('defines exact stable request-response channel values', () => {
    const channels = IPC as Readonly<Record<string, string>>;

    expect(channels.ListPersonalities).toBe('list_personalities');
    expect(channels.ReadPersonality).toBe('read_personality');
  });

  it('exposes only the narrow summary and detail DTO fields through type-only renderer exports', () => {
    const sharedTypes = readFileSync(SHARED_TYPES_PATH, 'utf8');
    const rendererTypes = readFileSync(RENDERER_TYPES_PATH, 'utf8');
    const summary = interfaceDeclaration(sharedTypes, 'PersonalitySummary');
    const detail = interfaceDeclaration(sharedTypes, 'PersonalityDetail');

    expect(declaredKeys(summary)).toEqual(['id', 'name', 'badge', 'color', 'builtin']);
    expect(detail).toMatch(/^export interface PersonalityDetail extends PersonalitySummary \{/);
    expect(declaredKeys(detail)).toEqual(['markdown']);
    for (const field of FORBIDDEN_CONTRACT_FIELDS) {
      expect(summary).not.toMatch(new RegExp(`\\b${field}\\b`));
      expect(detail).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(rendererTypes).toMatch(/export type \{[\s\S]*PersonalityDetail/);
    expect(rendererTypes).toMatch(/export type \{[\s\S]*PersonalitySummary/);
    expect(rendererTypes).not.toMatch(/import\s+\{[^}]*Personality(?:Summary|Detail)/);
  });

  it('keeps filesystem ownership in an Electron-free path-injected domain module', () => {
    const personalities = readFileSync(PERSONALITIES_PATH, 'utf8');

    expect(personalities).not.toMatch(/from ['"]electron['"]/);
    expect(personalities).toMatch(
      /export function listPersonalities\(\s*_?libraryDir: string,[\s\S]*\): PersonalitySummary\[\]/,
    );
    expect(personalities).toMatch(
      /export function readPersonality\(\s*_?libraryDir: string,\s*_?id: string,[\s\S]*\): PersonalityDetail \| null/,
    );
  });

  it('derives the global library in main and registers an argument-free list handler', () => {
    const register = readFileSync(REGISTER_PATH, 'utf8');
    const listHandler = handlerSource(register, 'ListPersonalities');

    expect(register.includes("path.join(getStateDir(), 'personalities')")).toBe(true);
    expect(
      /import \{[^}]*getStateDir[^}]*\} from ['"]\.\/persistence\.js['"]/s.test(register),
    ).toBe(true);
    expect(
      /import \{[^}]*listPersonalities[^}]*readPersonality[^}]*\} from ['"]\.\/personalities\.js['"]/s.test(
        register,
      ),
    ).toBe(true);
    expect(listHandler).toMatch(
      /ipcMain\.handle\(IPC\.ListPersonalities,\s*\(\)\s*=>\s*listPersonalities\(/,
    );
    for (const field of FORBIDDEN_CONTRACT_FIELDS) {
      expect(listHandler).not.toMatch(new RegExp(`args\\?*\\.${field}\\b`));
    }
  });

  it('accepts only args.id for detail reads and validates it before delegation', () => {
    const register = readFileSync(REGISTER_PATH, 'utf8');
    const readHandler = handlerSource(register, 'ReadPersonality');

    expect(readHandler).toContain("assertString(args?.id, 'id')");
    expect(readHandler).toMatch(/Object\.keys\(args\)\.some\(\(key\) => key !== 'id'\)/);
    expect(readHandler).toMatch(/if \(!isPersonalityId\(args\.id\)\)/);
    expect(readHandler).toMatch(/readPersonality\([^,]+, args\.id/);
    for (const field of FORBIDDEN_CONTRACT_FIELDS) {
      if (field === 'path') continue;
      expect(readHandler).not.toMatch(new RegExp(`args\\?*\\.${field}\\b`));
    }
  });
});
