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
  fields: PersonalityWriteFields,
): Promise<PersonalityDetail> {
  return invoke<PersonalityDetail>(IPC.CreatePersonality, {
    ...normalizePersonalityWriteFields(fields),
  });
}

export async function updatePersonality(
  id: string,
  fields: PersonalityWriteFields,
): Promise<PersonalityDetail> {
  return invoke<PersonalityDetail>(IPC.UpdatePersonality, {
    id,
    ...normalizePersonalityWriteFields(fields),
  });
}

export function normalizePersonalityWriteFields(
  fields: PersonalityWriteFields,
): PersonalityWriteFields {
  const { defaultAgent, defaultModel, defaultReasoningEffort, ...identity } = fields;
  if (!defaultAgent) return identity;

  const model = defaultModel?.trim();
  const reasoningEffort = defaultReasoningEffort?.trim();
  return {
    ...identity,
    defaultAgent,
    ...(model ? { defaultModel: model } : {}),
    ...(reasoningEffort ? { defaultReasoningEffort: reasoningEffort } : {}),
  };
}

export function togglePersonalityLibraryDialog(show?: boolean): void {
  setStore('showPersonalityLibraryDialog', show ?? !store.showPersonalityLibraryDialog);
}
