import { IPC } from '../../electron/ipc/channels';
import { invoke } from '../lib/ipc';
import type { PersonalityDetail, PersonalitySummary, PersonalityWriteFields } from '../ipc/types';
import { setStore, store } from './core';

export async function refreshPersonalities(
  commitIf: () => boolean,
): Promise<PersonalitySummary[] | null> {
  const response = await invoke<unknown>(IPC.ListPersonalities);
  if (!Array.isArray(response)) {
    throw new Error('Invalid personality catalog response');
  }

  const personalities = response as PersonalitySummary[];
  if (!commitIf()) return null;
  setStore('personalities', personalities);
  return personalities;
}

export async function readPersonality(id: string): Promise<PersonalityDetail | null> {
  return invoke<PersonalityDetail | null>(IPC.ReadPersonality, { id });
}

export async function createPersonality(
  _fields: PersonalityWriteFields,
): Promise<PersonalityDetail> {
  throw new Error('Personality creation is not implemented');
}

export function togglePersonalityLibraryDialog(show?: boolean): void {
  setStore('showPersonalityLibraryDialog', show ?? !store.showPersonalityLibraryDialog);
}
