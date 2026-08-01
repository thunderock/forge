import type { PersonalityDetail, PersonalitySummary } from '../ipc/types';

export async function refreshPersonalities(
  _commitIf: () => boolean,
): Promise<PersonalitySummary[] | null> {
  throw new Error('Not implemented');
}

export async function readPersonality(_id: string): Promise<PersonalityDetail | null> {
  throw new Error('Not implemented');
}

export function togglePersonalityLibraryDialog(_show?: boolean): void {
  throw new Error('Not implemented');
}
