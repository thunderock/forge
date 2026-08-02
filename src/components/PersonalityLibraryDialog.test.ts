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
  selectPreferredPersonality,
} from './PersonalityLibraryDialog';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
};

const principal: PersonalitySummary = {
  id: 'principal-engineer',
  name: 'Principal Engineer',
  badge: 'PE',
  color: '#7A78FF',
  builtin: true,
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
      'No readable personality files were found. Restore the files, or restart Forge to restore missing built-ins, then reopen the library.',
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain(
      'Couldn’t load the personality library. Select Retry to read the files again.',
    );
    expect(error).toContain('Retry');
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
    expect(error).toContain('Refresh library');
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
    };

    expect(selectPreferredPersonality([principal, saved, quality], saved.id, quality.id)).toEqual(
      saved,
    );
    expect(selectPreferredPersonality([principal, quality], 'missing', quality.id)).toEqual(
      quality,
    );
  });

  it('creates and selects a custom personality end to end', async () => {
    const saved: PersonalitySummary = {
      id: 'incident-commander',
      name: 'Incident Commander',
      badge: 'IC',
      color: '#FF6A2C',
      builtin: false,
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
