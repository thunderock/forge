import { createUniqueId } from 'solid-js';
import type { PersonalityDetail, PersonalityWriteFields } from '../ipc/types';
import { Dialog } from './Dialog';
import { CloseIcon } from './icons';

export const MAX_PERSONALITY_MARKDOWN_BYTES = 2 * 1024 * 1024;

export type PersonalityDraft = PersonalityWriteFields;

export interface PersonalityDraftErrors {
  name?: string;
  badge?: string;
  color?: string;
  markdown?: string;
}

export interface PersonalityColorOption {
  name: string;
  value: string;
}

export const PERSONALITY_COLOR_OPTIONS: readonly PersonalityColorOption[] = [];

export interface PersonalityPreviewIdentity {
  badge: string;
  color: string;
}

export function personalityMarkdownBytes(_markdown: string): number {
  return 0;
}

export function validatePersonalityDraft(_draft: PersonalityDraft): PersonalityDraftErrors {
  return {};
}

export function normalizePersonalityColor(color: string): string | null {
  return color;
}

export function retainLastValidIdentity(
  previous: PersonalityPreviewIdentity,
  _badge: string,
  _color: string,
): PersonalityPreviewIdentity {
  return previous;
}

export function nextPersonalityColorIndex(
  _key: string,
  current: number,
  _count: number,
): number | null {
  return current;
}

interface PersonalitySubmitterOptions {
  create: (fields: PersonalityWriteFields) => Promise<PersonalityDetail>;
  onSaved: (id: string) => void;
  onPending: (pending: boolean) => void;
  onError: () => void;
}

export function createPersonalitySubmitter(options: PersonalitySubmitterOptions) {
  return async (_fields: PersonalityWriteFields): Promise<boolean> => {
    options.onError();
    return false;
  };
}

interface PersonalityEditorDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}

export function PersonalityEditorDialog(props: PersonalityEditorDialogProps) {
  const titleId = createUniqueId();
  const subtitleId = createUniqueId();

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      width="min(840px, calc(100vw - 32px))"
      zIndex={1200}
      labelledBy={titleId}
      describedBy={subtitleId}
    >
      <header>
        <div>
          <h2 id={titleId}>New Personality</h2>
          <p id={subtitleId}>Create a reusable personality available in every project.</p>
        </div>
        <button type="button" aria-label="Close Personality Editor" onClick={() => props.onClose()}>
          <CloseIcon />
        </button>
      </header>
      <button type="button" disabled>
        Create Personality
      </button>
    </Dialog>
  );
}
