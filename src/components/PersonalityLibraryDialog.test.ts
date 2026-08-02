import { readFileSync } from 'node:fs';
import { renderToString } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalityDetail, PersonalitySummary } from '../ipc/types';
import {
  PersonalityCatalogState,
  PersonalityDetailIdentity,
  PersonalityDetailState,
  PersonalityLibraryRail,
  PersonalityOption,
  createAsyncRequestRunner,
  nextPersonalityIndex,
  preferredPersonalityIdForReload,
  selectPreferredPersonality,
} from './PersonalityLibraryDialog';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function visibleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '');
}

const quality: PersonalitySummary = {
  id: 'code-quality-engineer',
  name: 'Code Quality Engineer',
  badge: 'QE',
  color: '#2FD198',
  builtin: true,
  modifiedFromSeed: false,
};

const principal: PersonalitySummary = {
  id: 'principal-engineer',
  name: 'Principal Engineer',
  badge: 'PE',
  color: '#7A78FF',
  builtin: true,
  modifiedFromSeed: false,
};

describe('personality catalog presentation', () => {
  it('renders selected option semantics, identity badge, name, and Built-in tag', () => {
    const html = renderToString(() =>
      PersonalityOption({
        personality: quality,
        selected: true,
        detailId: 'personality-detail',
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-controls="personality-detail"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('personality-library-option is-selected');
    expect(html).toContain('--personality-color:#2FD198');
    expect(html).toContain('QE');
    expect(html).toContain('Code Quality Engineer');
    expect(html).toContain('Built-in');
  });

  it('keeps identifiers and storage metadata out of visible row markup', () => {
    const personality = {
      ...quality,
      path: '/Users/example/personalities/code-quality-engineer.md',
      seedRevision: 8_675_309,
      pristineHash: 'secret-hash',
    };
    const html = renderToString(() =>
      PersonalityOption({
        personality,
        selected: false,
        detailId: 'personality-detail',
        onSelect: vi.fn(),
      }),
    );

    expect(html).not.toContain(quality.id);
    expect(html).not.toContain(personality.path);
    expect(html).not.toContain(String(personality.seedRevision));
    expect(html).not.toContain(personality.pristineHash);
  });

  it('renders the detail identity without repeating the Built-in tag', () => {
    const html = renderToString(() =>
      PersonalityDetailIdentity({ personality: principal, titleId: 'detail-title' }),
    );

    expect(html).toContain('id="detail-title"');
    expect(html).toContain('PE');
    expect(html).toContain('Principal Engineer');
    expect(html).not.toContain('Built-in');
  });

  it('renders exact loading, empty, and list-error copy with recovery', () => {
    const loading = renderToString(() =>
      PersonalityCatalogState({ kind: 'loading', onRetry: vi.fn() }),
    );
    const empty = renderToString(() =>
      PersonalityCatalogState({ kind: 'empty', onRetry: vi.fn() }),
    );
    const error = renderToString(() =>
      PersonalityCatalogState({ kind: 'error', onRetry: vi.fn() }),
    );

    expect(loading).toContain('role="status"');
    expect(loading).toContain('Loading personalities…');
    expect(empty).toContain('No personalities available');
    expect(empty).toContain(
      'Create a personality to get started. If built-ins are missing, restart Forge and reopen the library.',
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain(
      'Couldn’t load the personality library. Select Reload Library to read the files again.',
    );
    expect(error).toContain('Reload Library');
  });

  it('renders exact detail loading and error recovery copy', () => {
    const loading = renderToString(() =>
      PersonalityDetailState({
        kind: 'loading',
        name: quality.name,
        onRefresh: vi.fn(),
      }),
    );
    const error = renderToString(() =>
      PersonalityDetailState({ kind: 'error', name: quality.name, onRefresh: vi.fn() }),
    );

    expect(visibleText(loading)).toContain(`Loading ${quality.name}…`);
    expect(visibleText(error)).toContain(
      `Couldn’t load ${quality.name}. The file may have changed on disk.`,
    );
    expect(error).toContain('Reload Personality');
  });
});

describe('personality keyboard navigation', () => {
  it('wraps arrows and supports Home, End, Enter, and Space', () => {
    expect(nextPersonalityIndex('ArrowDown', 2, 3)).toBe(0);
    expect(nextPersonalityIndex('ArrowUp', 0, 3)).toBe(2);
    expect(nextPersonalityIndex('Home', 2, 3)).toBe(0);
    expect(nextPersonalityIndex('End', 0, 3)).toBe(2);
    expect(nextPersonalityIndex('Enter', 1, 3)).toBe(1);
    expect(nextPersonalityIndex(' ', 1, 3)).toBe(1);
    expect(nextPersonalityIndex('PageDown', 1, 3)).toBeNull();
    expect(nextPersonalityIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('guarded catalog requests', () => {
  it('presents and caches only the newer open when it resolves first', async () => {
    const runner = createAsyncRequestRunner();
    const older = deferred<PersonalitySummary[]>();
    const newer = deferred<PersonalitySummary[]>();
    let open = true;
    let cache: PersonalitySummary[] = [];
    let presented: PersonalitySummary[] = [];

    const load = (request: Deferred<PersonalitySummary[]>) =>
      runner.run(
        () => open,
        async (isCurrent) => {
          const result = await request.promise;
          if (!isCurrent()) return null;
          cache = result;
          return result;
        },
        (result) => {
          if (result) presented = result;
        },
        vi.fn(),
      );

    const olderLoad = load(older);
    const newerLoad = load(newer);
    newer.resolve([principal]);
    await newerLoad;
    older.resolve([quality]);
    await olderLoad;

    expect(cache).toEqual([principal]);
    expect(presented).toEqual([principal]);
    open = false;
  });

  it('changes neither cache nor presented rows after close', async () => {
    const runner = createAsyncRequestRunner();
    const request = deferred<PersonalitySummary[]>();
    let open = true;
    let cache = [principal];
    let presented = [principal];

    const load = runner.run(
      () => open,
      async (isCurrent) => {
        const result = await request.promise;
        if (!isCurrent()) return null;
        cache = result;
        return result;
      },
      (result) => {
        if (result) presented = result;
      },
      vi.fn(),
    );

    open = false;
    runner.invalidate();
    request.resolve([quality]);
    await load;

    expect(cache).toEqual([principal]);
    expect(presented).toEqual([principal]);
  });

  it('suppresses a stale detail response after a newer selection', async () => {
    const runner = createAsyncRequestRunner();
    const qualityRequest = deferred<PersonalityDetail>();
    const principalRequest = deferred<PersonalityDetail>();
    let selectedId = quality.id;
    let body = '';

    const qualityLoad = runner.run(
      () => selectedId === quality.id,
      () => qualityRequest.promise,
      (detail) => {
        body = detail.markdown;
      },
      vi.fn(),
    );
    selectedId = principal.id;
    const principalLoad = runner.run(
      () => selectedId === principal.id,
      () => principalRequest.promise,
      (detail) => {
        body = detail.markdown;
      },
      vi.fn(),
    );

    principalRequest.resolve({ ...principal, markdown: 'Principal body' });
    await principalLoad;
    qualityRequest.resolve({ ...quality, markdown: 'Quality body' });
    await qualityLoad;

    expect(body).toBe('Principal body');
  });
});

describe('markdown safety contract', () => {
  it('uses the sanitized highlighted-markdown accessor as its sole HTML sink', () => {
    const source = readFileSync(new URL('./PersonalityLibraryDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('createHighlightedMarkdown');
    expect(source).toMatch(/innerHTML=\{markdownHtml\(\)\}/);
    expect(source.match(/\binnerHTML=/g)).toHaveLength(1);
    expect(source).not.toMatch(
      /\bMarked\b|DOMPurify|mermaid\.render|ReviewProvider|openFileInEditor/,
    );
  });
});

describe('RED: create editor contract', () => {
  it('keeps the rail and New Personality action after a successful empty load', () => {
    const html = renderToString(() =>
      PersonalityLibraryRail({
        personalities: [],
        selectedId: null,
        detailId: 'personality-detail',
        onNew: vi.fn(),
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain('Personalities');
    expect(html).toContain('New Personality');
    expect(html).toContain('role="listbox"');
  });

  it('selects a preferred saved ID after the refreshed list is reordered', () => {
    const saved: PersonalitySummary = {
      id: 'incident-commander',
      name: 'Incident Commander',
      badge: 'IC',
      color: '#FF6A2C',
      builtin: false,
      modifiedFromSeed: false,
    };

    expect(selectPreferredPersonality([principal, saved, quality], saved.id, quality.id)).toEqual(
      saved,
    );
    expect(selectPreferredPersonality([principal, quality], 'missing', quality.id)).toEqual(
      quality,
    );
    expect(preferredPersonalityIdForReload(true, saved.id)).toBe(saved.id);
    expect(preferredPersonalityIdForReload(false, saved.id)).toBeNull();
  });

  it('creates and selects a custom personality end to end', async () => {
    const saved: PersonalitySummary = {
      id: 'incident-commander',
      name: 'Incident Commander',
      badge: 'IC',
      color: '#FF6A2C',
      builtin: false,
      modifiedFromSeed: false,
    };
    const create = vi.fn().mockResolvedValue(saved);
    const refresh = vi
      .fn<() => Promise<PersonalitySummary[]>>()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce([principal, saved, quality]);

    const created = await create();
    await expect(refresh()).rejects.toThrow('refresh failed');
    const selected = selectPreferredPersonality(await refresh(), created.id);

    expect(create).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(selected?.id).toBe(saved.id);
  });

  it('uses the store cache as the only row source and separates reload from creation', () => {
    const librarySource = readFileSync(
      new URL('./PersonalityLibraryDialog.tsx', import.meta.url),
      'utf8',
    );
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    expect(librarySource).toContain('store.personalities');
    expect(librarySource).not.toContain('createSignal<PersonalitySummary[]>([])');
    expect(librarySource).toContain('reloadGeneration');
    expect(librarySource).toContain('preferredId');
    expect(librarySource).toContain(
      'Personality saved, but the library couldn’t refresh. Select Reload Library to reload it.',
    );
    expect(librarySource).toContain('Reload Library');
    expect(librarySource).not.toContain('IPC.CreatePersonality');
    expect(appSource).toContain('<PersonalityEditorDialog');
    expect(appSource.match(/<PersonalityEditorDialog/g)).toHaveLength(1);
    expect(appSource).toContain('preferredPersonalityId');
    expect(appSource).toContain('personalityReloadGeneration');
  });
});

describe('RED: edit and copy editor contract', () => {
  it('derives the exact action only from the current freshly loaded detail', async () => {
    const libraryModule = (await import('./PersonalityLibraryDialog')) as unknown as {
      personalityEditAction?: (
        detail: PersonalityDetail | null,
        selectedId: string | null,
      ) => { id: string; label: 'Edit' | 'Edit a copy' } | null;
    };

    expect(libraryModule.personalityEditAction).toBeTypeOf('function');
    if (!libraryModule.personalityEditAction) return;

    const custom: PersonalityDetail = {
      id: 'incident-commander',
      name: 'Incident Commander',
      badge: 'IC',
      color: '#FF6A2C',
      builtin: false,
      modifiedFromSeed: false,
      markdown: '## Role\n\nCoordinate the response.',
    };
    const builtIn: PersonalityDetail = {
      ...quality,
      markdown: '## Role\n\nProtect quality.',
    };

    expect(libraryModule.personalityEditAction(custom, custom.id)).toEqual({
      id: custom.id,
      label: 'Edit',
    });
    expect(libraryModule.personalityEditAction(builtIn, builtIn.id)).toEqual({
      id: builtIn.id,
      label: 'Edit a copy',
    });
    expect(libraryModule.personalityEditAction(custom, builtIn.id)).toBeNull();
    expect(libraryModule.personalityEditAction(null, custom.id)).toBeNull();
  });

  it('shows Edit or Edit a copy only after fresh detail and never exposes Delete', () => {
    const librarySource = readFileSync(
      new URL('./PersonalityLibraryDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(librarySource).toContain('onEdit: (id: string) => void');
    expect(librarySource).toContain('personalityEditAction');
    expect(librarySource).toContain('Edit a copy');
    expect(librarySource).toContain('props.onEdit(action().id)');
    expect(librarySource).not.toContain('Delete');
  });

  it('owns a transient edit target and closes the child before the parent', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const closeStart = appSource.indexOf('function closePersonalityLibrary');
    const closeEnd = appSource.indexOf('\n  }', closeStart);
    const closeBody = appSource.slice(closeStart, closeEnd);

    expect(appSource).toContain('personalityEditId');
    expect(appSource).toContain('editId={personalityEditId()}');
    expect(appSource).toContain('onEdit=');
    expect(closeBody).toContain('setPersonalityEditorOpen(false)');
    expect(closeBody).toContain('setPersonalityEditId(null)');
    expect(closeBody.indexOf('setPersonalityEditorOpen(false)')).toBeLessThan(
      closeBody.indexOf('togglePersonalityLibraryDialog(false)'),
    );
  });

  it('routes one successful save through returned-ID refresh selection without replaying mutation', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    expect(appSource).toContain('setPreferredPersonalityId(id)');
    expect(appSource).toContain('setPersonalityReloadGeneration((current) => current + 1)');
    expect(
      appSource.match(/setPersonalityReloadGeneration\(\(current\) => current \+ 1\)/g),
    ).toHaveLength(1);
    expect(appSource).not.toContain('createPersonality(');
    expect(appSource).not.toContain('updatePersonality(');
  });
});

describe('RED: markdown preview contract', () => {
  it('keeps the catalog compatibility accessor and gives the editor one separate safe sink', () => {
    const librarySource = readFileSync(
      new URL('./PersonalityLibraryDialog.tsx', import.meta.url),
      'utf8',
    );
    const editorSource = readFileSync(
      new URL('./PersonalityEditorDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(librarySource).toContain('createHighlightedMarkdown');
    expect(librarySource).not.toContain('createHighlightedMarkdownState');
    expect(librarySource.match(/\binnerHTML=/g)).toHaveLength(1);
    expect(editorSource).toContain('createHighlightedMarkdownState');
    expect(editorSource.match(/\binnerHTML=/g)).toHaveLength(1);
    expect(`${librarySource}\n${editorSource}`).not.toMatch(
      /mermaid\.render|new Marked|DOMPurify\.sanitize/,
    );
  });
});

interface PersonalityResetTarget {
  id: string;
  name: string;
}

interface ResetCatalogContractModule {
  personalityResetAction?: (
    detail: PersonalityDetail | null,
    selectedId: string | null,
  ) => PersonalityResetTarget | null;
  createPersonalityResetSubmitter?: (options: {
    reset: (id: string) => Promise<PersonalityDetail>;
    onPending: (pending: boolean) => void;
    onSuccess: (detail: PersonalityDetail) => void;
    onError: (target: PersonalityResetTarget) => void;
  }) => (target: PersonalityResetTarget) => Promise<boolean>;
}

async function resetCatalogContract(): Promise<ResetCatalogContractModule> {
  return (await import('./PersonalityLibraryDialog')) as unknown as ResetCatalogContractModule;
}

describe('RED: reset catalog contract', () => {
  const modifiedSummary: PersonalitySummary = {
    ...quality,
    modifiedFromSeed: true,
  };
  const modifiedDetail: PersonalityDetail = {
    ...modifiedSummary,
    markdown: '## Focus Areas\n\nLocally modified.',
  };
  const pristineDetail: PersonalityDetail = {
    ...quality,
    markdown: '## Focus Areas\n\nPackaged seed.',
  };
  const customDetail: PersonalityDetail = {
    id: 'incident-commander',
    name: 'Incident Commander',
    badge: 'IC',
    color: '#FF6A2C',
    builtin: false,
    modifiedFromSeed: true,
    markdown: '## Role\n\nCoordinate the response.',
  };

  it('shows Modified beside Built-in only for modified built-in rows', () => {
    const modified = renderToString(() =>
      PersonalityOption({
        personality: modifiedSummary,
        selected: true,
        detailId: 'personality-detail',
        onSelect: vi.fn(),
      }),
    );
    const pristine = renderToString(() =>
      PersonalityOption({
        personality: quality,
        selected: false,
        detailId: 'personality-detail',
        onSelect: vi.fn(),
      }),
    );
    const custom = renderToString(() =>
      PersonalityOption({
        personality: customDetail,
        selected: false,
        detailId: 'personality-detail',
        onSelect: vi.fn(),
      }),
    );

    expect(visibleText(modified)).toContain('Built-inModified');
    expect(visibleText(pristine)).not.toContain('Modified');
    expect(visibleText(custom)).not.toContain('Modified');
  });

  it('derives reset eligibility only from the current fresh modified built-in detail', async () => {
    const { personalityResetAction } = await resetCatalogContract();

    expect(personalityResetAction).toBeTypeOf('function');
    if (!personalityResetAction) return;

    expect(personalityResetAction(modifiedDetail, modifiedDetail.id)).toEqual({
      id: modifiedDetail.id,
      name: modifiedDetail.name,
    });
    expect(personalityResetAction(pristineDetail, pristineDetail.id)).toBeNull();
    expect(personalityResetAction(customDetail, customDetail.id)).toBeNull();
    expect(personalityResetAction(modifiedDetail, principal.id)).toBeNull();
    expect(personalityResetAction(null, modifiedDetail.id)).toBeNull();
  });

  it('renders the exact guarded danger confirmation and authoritative reload hooks', () => {
    const source = readFileSync(new URL('./PersonalityLibraryDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain("import { ConfirmDialog } from './ConfirmDialog'");
    expect(source).toContain('Reset to seed');
    expect(source).toContain('Resetting…');
    expect(source).toContain('Keep changes');
    expect(source).toContain(
      'This replaces the modified built-in with the current packaged version.',
    );
    expect(source).toContain('Forge will try to save a backup first.');
    expect(source).toContain('You cannot undo this reset in the app.');
    expect(source).toContain('The original file was left unchanged. Try again or cancel.');
    expect(source).toContain('danger');
    expect(source).toContain('zIndex={1300}');
    expect(source).toContain('width="min(440px, calc(100vw - 32px))"');
    expect(source).toContain('confirmLoading={resetPending()}');
    expect(source).toContain("loadLibrary('post-reset', result.id)");
    expect(source).not.toContain('IPC.ResetPersonality');
  });

  it('locks duplicate resets and keeps a failed confirmation recoverable without refresh', async () => {
    const { createPersonalityResetSubmitter } = await resetCatalogContract();

    expect(createPersonalityResetSubmitter).toBeTypeOf('function');
    if (!createPersonalityResetSubmitter) return;

    const firstRequest = deferred<PersonalityDetail>();
    const reset = vi
      .fn<(_id: string) => Promise<PersonalityDetail>>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce(pristineDetail);
    const onPending = vi.fn();
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const submit = createPersonalityResetSubmitter({ reset, onPending, onSuccess, onError });
    const target = { id: modifiedDetail.id, name: modifiedDetail.name };

    const first = submit(target);
    await expect(submit(target)).resolves.toBe(false);
    firstRequest.reject(new Error('/private/path stays hidden'));
    await expect(first).resolves.toBe(false);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(modifiedDetail.id);
    expect(onPending.mock.calls).toEqual([[true], [false]]);
    expect(onError).toHaveBeenCalledWith(target);
    expect(onSuccess).not.toHaveBeenCalled();

    await expect(submit(target)).resolves.toBe(true);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(onSuccess).toHaveBeenCalledWith(pristineDetail);
  });

  it('resets a modified built-in end to end', async () => {
    const { createPersonalityResetSubmitter } = await resetCatalogContract();

    expect(createPersonalityResetSubmitter).toBeTypeOf('function');
    if (!createPersonalityResetSubmitter) return;

    const reset = vi.fn().mockResolvedValue(pristineDetail);
    const refresh = vi.fn().mockResolvedValue([principal, quality]);
    const read = vi.fn().mockResolvedValue(pristineDetail);
    const focus = vi.fn();
    let confirmationOpen = true;
    let selected: PersonalitySummary | null = modifiedSummary;
    let presentedDetail: PersonalityDetail | null = modifiedDetail;
    let detailScrollTop = 64;
    let reload = Promise.resolve();
    const submit = createPersonalityResetSubmitter({
      reset,
      onPending: vi.fn(),
      onError: vi.fn(),
      onSuccess: (result) => {
        confirmationOpen = false;
        reload = (async () => {
          const rows = await refresh();
          selected = selectPreferredPersonality(rows, result.id, modifiedDetail.id);
          presentedDetail = await read(result.id);
          detailScrollTop = 0;
          focus(selected?.id);
        })();
      },
    });

    await expect(submit({ id: modifiedDetail.id, name: modifiedDetail.name })).resolves.toBe(true);
    await reload;

    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(confirmationOpen).toBe(false);
    expect(selected).toEqual(quality);
    expect(presentedDetail).toEqual(pristineDetail);
    expect(detailScrollTop).toBe(0);
    expect(focus).toHaveBeenCalledWith(quality.id);
  });

  it('keeps reset success authoritative when presentation recovery fails', async () => {
    const { createPersonalityResetSubmitter } = await resetCatalogContract();

    expect(createPersonalityResetSubmitter).toBeTypeOf('function');
    if (!createPersonalityResetSubmitter) return;

    const reset = vi.fn().mockResolvedValue(pristineDetail);
    const refresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const onResetError = vi.fn();
    const onRefreshError = vi.fn();
    let reload = Promise.resolve();
    const submit = createPersonalityResetSubmitter({
      reset,
      onPending: vi.fn(),
      onError: onResetError,
      onSuccess: () => {
        reload = refresh().catch(onRefreshError);
      },
    });

    await expect(submit({ id: modifiedDetail.id, name: modifiedDetail.name })).resolves.toBe(true);
    await reload;

    expect(reset).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onResetError).not.toHaveBeenCalled();
    expect(onRefreshError).toHaveBeenCalledTimes(1);
  });

  it('routes dialog-safe shortcuts through the reset confirmation before the catalog', () => {
    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    const librarySource = readFileSync(
      new URL('./PersonalityLibraryDialog.tsx', import.meta.url),
      'utf8',
    );

    expect(appSource).toContain('personalityResetOpen');
    expect(appSource).toContain('personalityResetDismissGeneration');
    expect(appSource.match(/if \(personalityResetOpen\(\)\)/g)).toHaveLength(3);
    expect(appSource).toContain('onResetOpenChange={setPersonalityResetOpen}');
    expect(appSource).toContain('resetDismissGeneration={personalityResetDismissGeneration()}');
    expect(librarySource).toContain('if (resetPending()) return;');
    expect(librarySource).toContain('props.onResetOpenChange(resetTarget() !== null)');
    expect(librarySource).toContain('props.resetDismissGeneration');
  });
});
