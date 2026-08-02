import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  on,
  onCleanup,
  untrack,
  type JSX,
} from 'solid-js';
import type { PersonalityDetail, PersonalitySummary } from '../ipc/types';
import { createHighlightedMarkdown } from '../lib/marked-shiki';
import { readPersonality, refreshPersonalities, resetPersonality, store } from '../store/store';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { CloseIcon } from './icons';

const RESET_CONFIRM_MESSAGE =
  'This replaces the modified built-in with the current packaged version. Forge will try to save a backup first. You cannot undo this reset in the app.';

interface PersonalityLibraryDialogProps {
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  reloadGeneration: number;
  preferredId: string | null;
}

export interface AsyncRequestRunner {
  invalidate: () => void;
  run: <T>(
    active: () => boolean,
    request: (isCurrent: () => boolean) => Promise<T>,
    onSuccess: (value: T) => void,
    onError: (error: unknown) => void,
  ) => Promise<void>;
}

export function createAsyncRequestRunner(): AsyncRequestRunner {
  let generation = 0;

  return {
    invalidate() {
      generation += 1;
    },
    async run<T>(
      active: () => boolean,
      request: (isCurrent: () => boolean) => Promise<T>,
      onSuccess: (value: T) => void,
      onError: (error: unknown) => void,
    ): Promise<void> {
      const requestGeneration = ++generation;
      const isCurrent = () => active() && requestGeneration === generation;

      try {
        const value = await request(isCurrent);
        if (isCurrent()) onSuccess(value);
      } catch (error) {
        if (isCurrent()) onError(error);
      }
    },
  };
}

export function nextPersonalityIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowDown') return (current + 1) % count;
  if (key === 'ArrowUp') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'Enter' || key === ' ') return current;
  return null;
}

export function selectPreferredPersonality(
  personalities: PersonalitySummary[],
  preferredId: string | null,
  currentId: string | null = null,
): PersonalitySummary | null {
  return (
    personalities.find((personality) => personality.id === preferredId) ??
    personalities.find((personality) => personality.id === currentId) ??
    personalities[0] ??
    null
  );
}

export function preferredPersonalityIdForReload(
  postSave: boolean,
  preferredId: string | null,
): string | null {
  return postSave ? preferredId : null;
}

export interface PersonalityEditAction {
  id: string;
  label: 'Edit' | 'Edit a copy';
}

export function personalityEditAction(
  detail: PersonalityDetail | null,
  selectedId: string | null,
): PersonalityEditAction | null {
  if (!detail || detail.id !== selectedId) return null;
  return {
    id: detail.id,
    label: detail.builtin ? 'Edit a copy' : 'Edit',
  };
}

export interface PersonalityResetTarget {
  id: string;
  name: string;
}

export function personalityResetAction(
  detail: PersonalityDetail | null,
  selectedId: string | null,
): PersonalityResetTarget | null {
  if (!detail || detail.id !== selectedId || !detail.builtin || !detail.modifiedFromSeed) {
    return null;
  }
  return { id: detail.id, name: detail.name };
}

interface PersonalityResetSubmitterOptions {
  reset: (id: string) => Promise<PersonalityDetail>;
  onPending: (pending: boolean) => void;
  onSuccess: (detail: PersonalityDetail) => void | Promise<void>;
  onError: (target: PersonalityResetTarget) => void;
}

export function createPersonalityResetSubmitter(options: PersonalityResetSubmitterOptions) {
  let pending = false;

  return async (target: PersonalityResetTarget): Promise<boolean> => {
    if (pending) return false;
    pending = true;
    options.onPending(true);

    let result: PersonalityDetail;
    try {
      result = await options.reset(target.id);
    } catch {
      options.onError(target);
      return false;
    } finally {
      pending = false;
      options.onPending(false);
    }

    await options.onSuccess(result);
    return true;
  };
}

interface PersonalityLibraryRailProps {
  personalities: PersonalitySummary[];
  selectedId: string | null;
  detailId: string;
  onNew: () => void;
  onSelect: (personality: PersonalitySummary) => void;
  onKeyDown?: (event: KeyboardEvent, index: number) => void;
  onElement?: (element: HTMLButtonElement, index: number) => void;
}

export function PersonalityLibraryRail(props: PersonalityLibraryRailProps) {
  return (
    <aside class="personality-library-rail">
      <div class="personality-library-rail-toolbar">
        <div class="personality-library-rail-label">Personalities</div>
        <button type="button" class="personality-library-new" onClick={() => props.onNew()}>
          New Personality
        </button>
      </div>
      <div
        class="personality-library-options"
        role="listbox"
        aria-label="Personalities"
        aria-orientation="vertical"
      >
        <For each={props.personalities}>
          {(personality, index) => (
            <PersonalityOption
              personality={personality}
              selected={personality.id === props.selectedId}
              detailId={props.detailId}
              onSelect={() => props.onSelect(personality)}
              onKeyDown={(event) => props.onKeyDown?.(event, index())}
              onElement={(element) => props.onElement?.(element, index())}
            />
          )}
        </For>
      </div>
    </aside>
  );
}

interface PersonalityBadgeProps {
  personality: Pick<PersonalitySummary, 'badge' | 'color'>;
}

export function PersonalityBadge(props: PersonalityBadgeProps) {
  return (
    <span
      class="personality-library-badge"
      aria-hidden="true"
      style={{ '--personality-color': props.personality.color } as JSX.CSSProperties}
    >
      {props.personality.badge}
    </span>
  );
}

interface PersonalityOptionProps {
  personality: PersonalitySummary;
  selected: boolean;
  detailId: string;
  onSelect: () => void;
  onKeyDown?: (event: KeyboardEvent) => void;
  onElement?: (element: HTMLButtonElement) => void;
}

export function PersonalityOption(props: PersonalityOptionProps) {
  return (
    <button
      ref={(element) => props.onElement?.(element)}
      type="button"
      role="option"
      class={`personality-library-option${props.selected ? ' is-selected' : ''}`}
      aria-selected={props.selected}
      aria-controls={props.detailId}
      tabIndex={props.selected ? 0 : -1}
      onClick={() => props.onSelect()}
      onKeyDown={(event) => props.onKeyDown?.(event)}
    >
      <PersonalityBadge personality={props.personality} />
      <span class="personality-library-option-copy">
        <span class="personality-library-option-name">{props.personality.name}</span>
        <Show when={props.personality.builtin}>
          <span class="personality-library-tags">
            <span class="personality-library-tag">Built-in</span>
            <Show when={props.personality.modifiedFromSeed}>
              <span class="personality-library-tag">Modified</span>
            </Show>
          </span>
        </Show>
      </span>
    </button>
  );
}

type CatalogStateKind = 'loading' | 'empty' | 'error';

interface PersonalityCatalogStateProps {
  kind: CatalogStateKind;
  onRetry: () => void;
  postSave?: boolean;
  postReset?: boolean;
}

export function PersonalityCatalogState(props: PersonalityCatalogStateProps) {
  return (
    <div
      class="personality-library-state"
      role={props.kind === 'error' ? 'alert' : props.kind === 'empty' ? 'status' : undefined}
      aria-live={props.kind === 'empty' ? 'polite' : undefined}
    >
      <Show when={props.kind === 'loading'}>
        <div class="personality-library-status" role="status" aria-live="polite">
          <span class="inline-spinner" aria-hidden="true" />
          <span>Loading personalities…</span>
        </div>
      </Show>
      <Show when={props.kind === 'empty'}>
        <div class="personality-library-state-copy">
          <h3>No personalities available</h3>
          <p>
            Create a personality to get started. If built-ins are missing, restart Forge and reopen
            the library.
          </p>
        </div>
      </Show>
      <Show when={props.kind === 'error'}>
        <div class="personality-library-state-copy is-error">
          <p>
            {props.postReset
              ? 'Personality reset, but the library couldn’t refresh. Select Reload Library to reload it.'
              : props.postSave
                ? 'Personality saved, but the library couldn’t refresh. Select Reload Library to reload it.'
                : 'Couldn’t load the personality library. Select Reload Library to read the files again.'}
          </p>
          <button type="button" class="personality-library-action" onClick={() => props.onRetry()}>
            Reload Library
          </button>
        </div>
      </Show>
    </div>
  );
}

interface PersonalityDetailIdentityProps {
  personality: PersonalitySummary;
  titleId: string;
}

export function PersonalityDetailIdentity(props: PersonalityDetailIdentityProps) {
  return (
    <div class="personality-library-detail-identity">
      <PersonalityBadge personality={props.personality} />
      <h3 id={props.titleId}>{props.personality.name}</h3>
    </div>
  );
}

interface PersonalityDetailStateProps {
  kind: 'loading' | 'error';
  name: string;
  onRefresh: () => void;
}

export function PersonalityDetailState(props: PersonalityDetailStateProps) {
  return (
    <div
      class="personality-library-detail-state"
      role={props.kind === 'error' ? 'alert' : 'status'}
      aria-live={props.kind === 'loading' ? 'polite' : undefined}
    >
      <Show when={props.kind === 'loading'}>
        <span class="inline-spinner" aria-hidden="true" />
        <span>Loading {props.name}…</span>
      </Show>
      <Show when={props.kind === 'error'}>
        <p>Couldn’t load {props.name}. The file may have changed on disk.</p>
        <button type="button" class="personality-library-action" onClick={() => props.onRefresh()}>
          Reload Personality
        </button>
      </Show>
    </div>
  );
}

export function PersonalityLibraryDialog(props: PersonalityLibraryDialogProps) {
  const titleId = createUniqueId();
  const subtitleId = createUniqueId();
  const detailRegionId = createUniqueId();
  const detailTitleId = createUniqueId();
  const resetDescriptionId = createUniqueId();
  const listRequests = createAsyncRequestRunner();
  const detailRequests = createAsyncRequestRunner();

  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<PersonalityDetail | null>(null);
  const [listLoading, setListLoading] = createSignal(false);
  const [listError, setListError] = createSignal<'initial' | 'post-save' | 'post-reset' | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal(false);
  const [resetTarget, setResetTarget] = createSignal<PersonalityResetTarget | null>(null);
  const [resetPending, setResetPending] = createSignal(false);
  const [resetError, setResetError] = createSignal<string | null>(null);

  let shellRef: HTMLDivElement | undefined;
  let detailScrollRef: HTMLDivElement | undefined;
  let resetButtonRef: HTMLButtonElement | undefined;
  const optionRefs: HTMLButtonElement[] = [];

  const rows = () => store.personalities;
  const selectedPersonality = createMemo(
    () => rows().find((personality) => personality.id === selectedId()) ?? null,
  );
  const editAction = createMemo(() => personalityEditAction(detail(), selectedId()));
  const resetAction = createMemo(() => personalityResetAction(detail(), selectedId()));
  const markdownHtml = createHighlightedMarkdown(() => detail()?.markdown);

  const submitReset = createPersonalityResetSubmitter({
    reset: resetPersonality,
    onPending: setResetPending,
    onError: (target) => {
      setResetError(
        `Couldn’t reset ${target.name}. The original file was left unchanged. Try again or cancel.`,
      );
    },
    onSuccess: async (result) => {
      setResetTarget(null);
      setResetError(null);
      await loadLibrary('post-reset', result.id);
    },
  });

  function focusOption(index: number): void {
    queueMicrotask(() => optionRefs[index]?.focus());
  }

  function focusSelectedFromPanel(index: number): void {
    if (typeof document === 'undefined') return;
    const panel = shellRef?.closest<HTMLElement>('.dialog-panel');
    if (!panel) return;
    queueMicrotask(() => {
      if (document.activeElement === panel) optionRefs[index]?.focus();
    });
  }

  function loadDetail(personality: PersonalitySummary): Promise<void> {
    setDetail(null);
    setDetailError(false);
    setDetailLoading(true);

    return detailRequests.run(
      () => untrack(() => props.open && selectedId() === personality.id),
      () => readPersonality(personality.id),
      (result) => {
        setDetailLoading(false);
        if (!result || result.id !== personality.id) {
          setDetailError(true);
          return;
        }
        setDetail(result);
        queueMicrotask(() => {
          if (detailScrollRef) detailScrollRef.scrollTop = 0;
        });
      },
      () => {
        setDetailLoading(false);
        setDetailError(true);
      },
    );
  }

  function selectPersonality(personality: PersonalitySummary): void {
    setSelectedId(personality.id);
    void loadDetail(personality);
  }

  function loadLibrary(
    reason: 'initial' | 'post-save' | 'post-reset' = 'initial',
    resetPreferredId: string | null = null,
  ): Promise<void> {
    const postSave = reason === 'post-save';
    const currentId = selectedId();
    const preferredId =
      reason === 'post-reset'
        ? resetPreferredId
        : preferredPersonalityIdForReload(
            postSave,
            untrack(() => props.preferredId),
          );
    detailRequests.invalidate();
    setDetail(null);
    setListError(null);
    setDetailError(false);
    setDetailLoading(false);
    setListLoading(true);

    return listRequests.run(
      () => untrack(() => props.open),
      (isCurrent) => refreshPersonalities(isCurrent),
      (result) => {
        setListLoading(false);
        if (result === null) return;
        if (result.length === 0) {
          setSelectedId(null);
          return;
        }

        const selected = selectPreferredPersonality(result, preferredId, currentId);
        if (!selected) {
          setSelectedId(null);
          return;
        }
        const selectedIndex = result.indexOf(selected);
        setSelectedId(selected.id);
        void loadDetail(selected);
        if (reason !== 'initial' && selected.id === preferredId) {
          focusOption(selectedIndex);
        } else {
          focusSelectedFromPanel(selectedIndex);
        }
      },
      () => {
        setListLoading(false);
        setListError(reason);
      },
    );
  }

  function openResetConfirmation(): void {
    const target = resetAction();
    if (!target) return;
    setResetError(null);
    setResetTarget(target);
  }

  function cancelReset(): void {
    if (resetPending()) return;
    setResetTarget(null);
    setResetError(null);
    queueMicrotask(() => resetButtonRef?.focus());
  }

  function confirmReset(): void {
    const target = resetTarget();
    if (!target || resetPending()) return;
    void submitReset(target);
  }

  function close(): void {
    listRequests.invalidate();
    detailRequests.invalidate();
    props.onClose();
  }

  function handleOptionKeyDown(event: KeyboardEvent, index: number): void {
    const nextIndex = nextPersonalityIndex(event.key, index, rows().length);
    if (nextIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    const personality = rows()[nextIndex];
    if (!personality) return;
    selectPersonality(personality);
    focusOption(nextIndex);
  }

  createEffect(
    on(
      () => [props.open, props.reloadGeneration] as const,
      ([open, reloadGeneration], previous) => {
        if (open) {
          const reason =
            previous?.[0] && previous[1] !== reloadGeneration ? 'post-save' : 'initial';
          void loadLibrary(reason);
          return;
        }
        listRequests.invalidate();
        detailRequests.invalidate();
        setDetail(null);
        setListLoading(false);
        setDetailLoading(false);
        setListError(null);
        setResetTarget(null);
        setResetPending(false);
        setResetError(null);
      },
    ),
  );

  onCleanup(() => {
    listRequests.invalidate();
    detailRequests.invalidate();
  });

  return (
    <>
      <Dialog
        open={props.open}
        onClose={close}
        width="min(1000px, calc(100vw - 32px))"
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
        <div ref={shellRef} class="personality-library">
          <header class="personality-library-header">
            <div class="personality-library-heading-copy">
              <h2 id={titleId}>Personality Library</h2>
              <p id={subtitleId}>
                Create, inspect, and customize personalities available in every project.
              </p>
            </div>
            <button
              type="button"
              class="personality-library-close"
              aria-label="Close Personality Library"
              title="Close Personality Library"
              onClick={close}
            >
              <CloseIcon />
            </button>
          </header>

          <div class="personality-library-body" aria-busy={listLoading() ? 'true' : undefined}>
            <Show when={listLoading()}>
              <PersonalityCatalogState kind="loading" onRetry={() => void loadLibrary()} />
            </Show>
            <Show when={!listLoading() && listError()}>
              <PersonalityCatalogState
                kind="error"
                postSave={listError() === 'post-save'}
                postReset={listError() === 'post-reset'}
                onRetry={() => void loadLibrary(listError() ?? 'initial')}
              />
            </Show>
            <Show when={!listLoading() && !listError()}>
              <PersonalityLibraryRail
                personalities={rows()}
                selectedId={selectedId()}
                detailId={detailRegionId}
                onNew={() => props.onNew()}
                onSelect={selectPersonality}
                onKeyDown={handleOptionKeyDown}
                onElement={(element, index) => {
                  optionRefs[index] = element;
                }}
              />

              <Show when={rows().length === 0}>
                <section class="personality-library-detail">
                  <PersonalityCatalogState kind="empty" onRetry={() => void loadLibrary()} />
                </section>
              </Show>

              <Show when={selectedPersonality()} keyed>
                {(personality) => (
                  <section class="personality-library-detail">
                    <div class="personality-library-detail-header">
                      <PersonalityDetailIdentity
                        personality={personality}
                        titleId={detailTitleId}
                      />
                      <Show when={editAction()}>
                        {(action) => (
                          <div class="personality-library-detail-actions">
                            <button
                              type="button"
                              class="personality-library-action"
                              onClick={() => props.onEdit(action().id)}
                            >
                              {action().label}
                            </button>
                            <Show when={resetAction()}>
                              <button
                                ref={resetButtonRef}
                                type="button"
                                class="personality-library-action is-destructive"
                                onClick={openResetConfirmation}
                              >
                                Reset to seed
                              </button>
                            </Show>
                          </div>
                        )}
                      </Show>
                    </div>
                    <div
                      ref={detailScrollRef}
                      id={detailRegionId}
                      class="personality-library-detail-scroll"
                      role="region"
                      aria-labelledby={detailTitleId}
                      aria-busy={detailLoading() ? 'true' : undefined}
                      tabIndex={0}
                    >
                      <Show when={detailLoading()}>
                        <PersonalityDetailState
                          kind="loading"
                          name={personality.name}
                          onRefresh={() => void loadDetail(personality)}
                        />
                      </Show>
                      <Show when={!detailLoading() && detailError()}>
                        <PersonalityDetailState
                          kind="error"
                          name={personality.name}
                          onRefresh={() => void loadDetail(personality)}
                        />
                      </Show>
                      <Show when={!detailLoading() && !detailError() && detail()}>
                        <div
                          class="plan-markdown plan-markdown-dialog personality-markdown"
                          // eslint-disable-next-line solid/no-innerhtml -- helper sanitizes highlighted and fallback HTML
                          innerHTML={markdownHtml()}
                        />
                      </Show>
                    </div>
                  </section>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={resetTarget() !== null}
        title={`Reset ${resetTarget()?.name ?? ''} to seed?`}
        message={<span id={resetDescriptionId}>{RESET_CONFIRM_MESSAGE}</span>}
        confirmLabel={resetPending() ? 'Resetting…' : 'Reset to seed'}
        cancelLabel="Keep changes"
        confirmLoading={resetPending()}
        cancelDisabled={resetPending()}
        danger
        autoFocusCancel
        zIndex={1300}
        width="min(440px, calc(100vw - 32px))"
        describedBy={resetDescriptionId}
        error={resetError() ?? undefined}
        onConfirm={confirmReset}
        onCancel={cancelReset}
      />
    </>
  );
}
