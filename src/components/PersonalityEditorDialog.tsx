import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  type JSX,
} from 'solid-js';
import type { PersonalityDetail, PersonalityWriteFields } from '../ipc/types';
import { createPersonality } from '../store/store';
import { Dialog } from './Dialog';
import { CheckIcon, CloseIcon } from './icons';
import { PersonalityBadge } from './PersonalityLibraryDialog';

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

export const PERSONALITY_COLOR_OPTIONS: readonly PersonalityColorOption[] = [
  { name: 'Mint', value: '#2FD198' },
  { name: 'Violet', value: '#7A78FF' },
  { name: 'Orange', value: '#FF944D' },
  { name: 'Forge orange', value: '#FF6A2C' },
  { name: 'Blue', value: '#4DA3FF' },
  { name: 'Pink', value: '#E85D9E' },
  { name: 'Gold', value: '#F5C451' },
  { name: 'Red', value: '#F05D5E' },
];

const BADGE_PATTERN = /^[A-Z0-9]{1,4}$/;
const COLOR_PATTERN = /^#(?:[0-9A-F]{3}|[0-9A-F]{6})$/i;

export interface PersonalityPreviewIdentity {
  badge: string;
  color: string;
}

export function personalityMarkdownBytes(markdown: string): number {
  return new TextEncoder().encode(markdown).byteLength;
}

export function validatePersonalityDraft(draft: PersonalityDraft): PersonalityDraftErrors {
  const errors: PersonalityDraftErrors = {};
  if (!draft.name.trim()) errors.name = 'Enter a name.';
  if (!BADGE_PATTERN.test(draft.badge.trim().toUpperCase())) {
    errors.badge = 'Use 1–4 letters or numbers.';
  }
  if (!normalizePersonalityColor(draft.color)) {
    errors.color = 'Enter a hex color such as #7A78FF.';
  }
  if (!draft.markdown.trim()) {
    errors.markdown = 'Add Markdown instructions.';
  } else if (personalityMarkdownBytes(draft.markdown) > MAX_PERSONALITY_MARKDOWN_BYTES) {
    errors.markdown = 'Instructions must be smaller than 2 MB.';
  }
  return errors;
}

export function normalizePersonalityColor(color: string): string | null {
  const normalized = color.trim().toUpperCase();
  return COLOR_PATTERN.test(normalized) ? normalized : null;
}

export function retainLastValidIdentity(
  previous: PersonalityPreviewIdentity,
  badge: string,
  color: string,
): PersonalityPreviewIdentity {
  const normalizedBadge = badge.trim().toUpperCase();
  const normalizedColor = normalizePersonalityColor(color);
  return {
    badge: BADGE_PATTERN.test(normalizedBadge) ? normalizedBadge : previous.badge,
    color: normalizedColor ?? previous.color,
  };
}

export function nextPersonalityColorIndex(
  key: string,
  current: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

interface PersonalitySubmitterOptions {
  create: (fields: PersonalityWriteFields) => Promise<PersonalityDetail>;
  onSaved: (id: string) => void;
  onPending: (pending: boolean) => void;
  onError: () => void;
}

export function createPersonalitySubmitter(options: PersonalitySubmitterOptions) {
  let pending = false;
  return async (fields: PersonalityWriteFields): Promise<boolean> => {
    if (pending) return false;
    pending = true;
    options.onPending(true);
    let saved: PersonalityDetail;
    try {
      saved = await options.create(fields);
    } catch {
      options.onError();
      pending = false;
      options.onPending(false);
      return false;
    }
    pending = false;
    options.onPending(false);
    options.onSaved(saved.id);
    return true;
  };
}

interface PersonalityEditorDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}

type PersonalityDraftField = keyof PersonalityDraft;
type TouchedFields = Record<PersonalityDraftField, boolean>;

const EMPTY_TOUCHED: TouchedFields = {
  name: false,
  badge: false,
  color: false,
  markdown: false,
};

function formatMarkdownBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function PersonalityEditorDialog(props: PersonalityEditorDialogProps) {
  const titleId = createUniqueId();
  const subtitleId = createUniqueId();
  const nameHelpId = createUniqueId();
  const nameErrorId = createUniqueId();
  const badgeHelpId = createUniqueId();
  const badgeErrorId = createUniqueId();
  const colorErrorId = createUniqueId();
  const markdownCounterId = createUniqueId();
  const markdownErrorId = createUniqueId();

  const [name, setName] = createSignal('');
  const [badge, setBadge] = createSignal('');
  const [color, setColor] = createSignal('#FF6A2C');
  const [markdown, setMarkdown] = createSignal('');
  const [previewIdentity, setPreviewIdentity] = createSignal<PersonalityPreviewIdentity>({
    badge: '',
    color: '#FF6A2C',
  });
  const [touched, setTouched] = createSignal<TouchedFields>({ ...EMPTY_TOUCHED });
  const [submitted, setSubmitted] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  let nameRef: HTMLInputElement | undefined;
  const swatchRefs: HTMLButtonElement[] = [];

  const draft = createMemo<PersonalityDraft>(() => ({
    name: name(),
    badge: badge(),
    color: color(),
    markdown: markdown(),
  }));
  const errors = createMemo(() => validatePersonalityDraft(draft()));
  const markdownBytes = createMemo(() => personalityMarkdownBytes(markdown()));
  const isValid = createMemo(() => Object.keys(errors()).length === 0);
  const activeSwatchColor = createMemo(
    () => normalizePersonalityColor(color()) ?? previewIdentity().color,
  );
  const selectedSwatchIndex = createMemo(() => {
    const index = PERSONALITY_COLOR_OPTIONS.findIndex(
      (option) => option.value === activeSwatchColor(),
    );
    return index >= 0 ? index : 0;
  });
  const badgePreview = createMemo(() => ({
    badge: previewIdentity().badge || '—',
    color: previewIdentity().color,
  }));

  function visibleError(field: PersonalityDraftField): string | undefined {
    const error = errors()[field];
    if (!error) return undefined;
    if (field === 'markdown' && markdownBytes() > MAX_PERSONALITY_MARKDOWN_BYTES) return error;
    return touched()[field] || submitted() ? error : undefined;
  }

  const nameError = createMemo(() => visibleError('name'));
  const badgeError = createMemo(() => visibleError('badge'));
  const colorError = createMemo(() => visibleError('color'));
  const markdownError = createMemo(() => visibleError('markdown'));

  function describedBy(helperId: string, errorId: string, error?: string): string {
    return error ? `${helperId} ${errorId}` : helperId;
  }

  function markTouched(field: PersonalityDraftField): void {
    setTouched((current) => ({ ...current, [field]: true }));
  }

  function clearMutationError(): void {
    setSaveError(null);
  }

  function updatePreview(nextBadge: string, nextColor: string): void {
    setPreviewIdentity((previous) => retainLastValidIdentity(previous, nextBadge, nextColor));
  }

  function updateBadge(value: string): void {
    const uppercase = value.toUpperCase();
    setBadge(uppercase);
    updatePreview(uppercase, color());
    clearMutationError();
  }

  function updateColor(value: string): void {
    setColor(value);
    updatePreview(badge(), value);
    clearMutationError();
  }

  function selectColor(value: string): void {
    setColor(value);
    updatePreview(badge(), value);
    markTouched('color');
    clearMutationError();
  }

  function close(): void {
    if (!saving()) props.onClose();
  }

  const submit = createPersonalitySubmitter({
    create: createPersonality,
    onSaved: (id) => props.onSaved(id),
    onPending: setSaving,
    onError: () =>
      setSaveError('Couldn’t create this personality. Review the fields and try again.'),
  });

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving()) return;
    setSubmitted(true);
    setSaveError(null);
    if (!isValid()) return;
    const normalizedColor = normalizePersonalityColor(color());
    if (!normalizedColor) return;
    const fields: PersonalityWriteFields = {
      name: name().trim(),
      badge: badge().trim().toUpperCase(),
      color: normalizedColor,
      markdown: markdown(),
    };
    setColor(normalizedColor);
    await submit(fields);
  }

  function handleSwatchKeyDown(event: KeyboardEvent, current: number): void {
    const next = nextPersonalityColorIndex(event.key, current, PERSONALITY_COLOR_OPTIONS.length);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    const option = PERSONALITY_COLOR_OPTIONS[next];
    if (!option) return;
    selectColor(option.value);
    queueMicrotask(() => swatchRefs[next]?.focus());
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setName('');
        setBadge('');
        setColor('#FF6A2C');
        setMarkdown('');
        setPreviewIdentity({ badge: '', color: '#FF6A2C' });
        setTouched({ ...EMPTY_TOUCHED });
        setSubmitted(false);
        setSaving(false);
        setSaveError(null);
        queueMicrotask(() => nameRef?.focus());
      },
    ),
  );

  return (
    <Dialog
      open={props.open}
      onClose={close}
      width="min(840px, calc(100vw - 32px))"
      zIndex={1200}
      labelledBy={titleId}
      describedBy={subtitleId}
      panelStyle={{
        height: 'min(720px, calc(100vh - 64px))',
        'max-height': 'calc(100vh - 64px)',
        overflow: 'hidden',
        padding: '0',
        gap: '0',
      }}
    >
      <form
        class="personality-editor"
        aria-busy={saving() ? 'true' : undefined}
        onSubmit={handleSubmit}
      >
        <header class="personality-editor-header">
          <div class="personality-editor-heading-copy">
            <h2 id={titleId}>New Personality</h2>
            <p id={subtitleId}>Create a reusable personality available in every project.</p>
          </div>
          <button
            type="button"
            class="personality-editor-close"
            aria-label="Close Personality Editor"
            title="Close Personality Editor"
            disabled={saving()}
            onClick={close}
          >
            <CloseIcon />
          </button>
        </header>

        <div class="personality-editor-body">
          <div class="personality-editor-form">
            <section class="personality-editor-section" aria-labelledby={`${titleId}-identity`}>
              <h3 id={`${titleId}-identity`}>Identity</h3>
              <fieldset class="personality-editor-fieldset" disabled={saving()}>
                <div class="personality-editor-identity-grid">
                  <div class="personality-editor-field">
                    <label for={`${titleId}-name`}>Name</label>
                    <input
                      ref={nameRef}
                      id={`${titleId}-name`}
                      type="text"
                      value={name()}
                      maxlength={80}
                      aria-describedby={describedBy(nameHelpId, nameErrorId, nameError())}
                      aria-invalid={nameError() ? 'true' : undefined}
                      onInput={(event) => {
                        setName(event.currentTarget.value);
                        clearMutationError();
                      }}
                      onBlur={() => markTouched('name')}
                    />
                    <p id={nameHelpId} class="personality-editor-help">
                      Shown in the library and future task panes.
                    </p>
                    <Show when={nameError()}>
                      {(error) => (
                        <p id={nameErrorId} class="personality-editor-error">
                          {error()}
                        </p>
                      )}
                    </Show>
                  </div>

                  <div class="personality-editor-field">
                    <label for={`${titleId}-badge`}>Badge</label>
                    <input
                      id={`${titleId}-badge`}
                      type="text"
                      value={badge()}
                      maxlength={4}
                      autocapitalize="characters"
                      aria-describedby={describedBy(badgeHelpId, badgeErrorId, badgeError())}
                      aria-invalid={badgeError() ? 'true' : undefined}
                      onInput={(event) => updateBadge(event.currentTarget.value)}
                      onBlur={() => markTouched('badge')}
                    />
                    <p id={badgeHelpId} class="personality-editor-help">
                      1–4 letters or numbers.
                    </p>
                    <Show when={badgeError()}>
                      {(error) => (
                        <p id={badgeErrorId} class="personality-editor-error">
                          {error()}
                        </p>
                      )}
                    </Show>
                  </div>
                </div>

                <div class="personality-editor-color-field">
                  <span class="personality-editor-label" id={`${titleId}-color-label`}>
                    Color
                  </span>
                  <div
                    class="personality-editor-color-controls"
                    role="group"
                    aria-labelledby={`${titleId}-color-label`}
                  >
                    <div class="personality-editor-swatches">
                      <For each={PERSONALITY_COLOR_OPTIONS}>
                        {(option, index) => {
                          const selected = () => activeSwatchColor() === option.value;
                          return (
                            <button
                              ref={(element) => {
                                swatchRefs[index()] = element;
                              }}
                              type="button"
                              class="personality-editor-swatch"
                              style={{ '--swatch-color': option.value } as JSX.CSSProperties}
                              aria-label={`${option.name} ${option.value}`}
                              aria-pressed={selected()}
                              tabIndex={index() === selectedSwatchIndex() ? 0 : -1}
                              onClick={() => selectColor(option.value)}
                              onKeyDown={(event) => handleSwatchKeyDown(event, index())}
                            >
                              <Show when={selected()}>
                                <CheckIcon size={14} />
                              </Show>
                            </button>
                          );
                        }}
                      </For>
                    </div>
                    <input
                      class="personality-editor-color-input"
                      type="text"
                      value={color()}
                      placeholder="#FF6A2C"
                      aria-label="Hex color"
                      aria-describedby={colorError() ? colorErrorId : undefined}
                      aria-invalid={colorError() ? 'true' : undefined}
                      onInput={(event) => updateColor(event.currentTarget.value)}
                      onBlur={() => {
                        markTouched('color');
                        const normalized = normalizePersonalityColor(color());
                        if (normalized) setColor(normalized);
                      }}
                    />
                    <div class="personality-editor-badge-preview">
                      <PersonalityBadge personality={badgePreview()} />
                      <span>Badge preview</span>
                    </div>
                  </div>
                  <Show when={colorError()}>
                    {(error) => (
                      <p id={colorErrorId} class="personality-editor-error">
                        {error()}
                      </p>
                    )}
                  </Show>
                </div>
              </fieldset>
            </section>

            <section class="personality-editor-section" aria-labelledby={`${titleId}-instructions`}>
              <h3 id={`${titleId}-instructions`}>Instructions</h3>
              <fieldset class="personality-editor-fieldset" disabled={saving()}>
                <div class="personality-editor-field">
                  <label class="visually-hidden" for={`${titleId}-markdown`}>
                    Markdown instructions
                  </label>
                  <textarea
                    id={`${titleId}-markdown`}
                    class="personality-editor-markdown"
                    value={markdown()}
                    placeholder="Describe the role, focus, approach, and anti-patterns in Markdown…"
                    spellcheck={false}
                    aria-describedby={
                      markdownError()
                        ? `${markdownCounterId} ${markdownErrorId}`
                        : markdownCounterId
                    }
                    aria-invalid={markdownError() ? 'true' : undefined}
                    onInput={(event) => {
                      setMarkdown(event.currentTarget.value);
                      clearMutationError();
                    }}
                    onBlur={() => markTouched('markdown')}
                  />
                  <Show when={markdownError()}>
                    {(error) => (
                      <p id={markdownErrorId} class="personality-editor-error">
                        {error()}
                      </p>
                    )}
                  </Show>
                  <p
                    id={markdownCounterId}
                    class={`personality-editor-byte-count${markdownBytes() > MAX_PERSONALITY_MARKDOWN_BYTES ? ' is-error' : ''}`}
                  >
                    Markdown size: {formatMarkdownBytes(markdownBytes())} / 2 MB
                  </p>
                </div>
              </fieldset>
            </section>
          </div>
        </div>

        <footer class="personality-editor-footer">
          <Show when={saveError()}>
            {(error) => (
              <p class="personality-editor-save-error" role="alert">
                {error()}
              </p>
            )}
          </Show>
          <div class="personality-editor-actions">
            <button
              type="button"
              class="personality-editor-secondary"
              disabled={saving()}
              onClick={close}
            >
              Discard Changes
            </button>
            <button
              type="submit"
              class="personality-editor-primary"
              disabled={!isValid() || saving()}
            >
              <Show when={saving()} fallback="Create Personality">
                <span class="inline-spinner" aria-hidden="true" />
                <span>Creating…</span>
              </Show>
            </button>
          </div>
        </footer>
      </form>
    </Dialog>
  );
}
