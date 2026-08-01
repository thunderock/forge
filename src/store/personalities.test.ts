import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersonalityDetail, PersonalitySummary } from '../ipc/types';

const { mockInvoke, mockSetStore, mockStore } = vi.hoisted(() => {
  const mockStore = {
    personalities: [] as unknown[],
    showPersonalityLibraryDialog: false,
  };
  const mockSetStore = vi.fn(
    (key: 'personalities' | 'showPersonalityLibraryDialog', value: unknown) => {
      if (key === 'personalities' && Array.isArray(value)) {
        mockStore.personalities = value;
      }
      if (key === 'showPersonalityLibraryDialog' && typeof value === 'boolean') {
        mockStore.showPersonalityLibraryDialog = value;
      }
    },
  );
  return { mockInvoke: vi.fn(), mockSetStore, mockStore };
});

vi.mock('../lib/ipc', () => ({
  invoke: mockInvoke,
}));

vi.mock('./core', () => ({
  setStore: mockSetStore,
  store: mockStore,
}));

import { IPC } from '../../electron/ipc/channels';
import {
  readPersonality,
  refreshPersonalities,
  togglePersonalityLibraryDialog,
} from './personalities';

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

beforeEach(() => {
  vi.clearAllMocks();
  mockStore.personalities = [];
  mockStore.showPersonalityLibraryDialog = false;
});

describe('refreshPersonalities', () => {
  it('re-reads on demand without mutating the cache while pending (D-07/D-16)', async () => {
    const request = deferred<unknown>();
    mockStore.personalities = [principal];
    mockInvoke.mockReturnValueOnce(request.promise);

    const refresh = refreshPersonalities(() => true);

    expect(mockInvoke).toHaveBeenCalledWith(IPC.ListPersonalities);
    expect(mockStore.personalities).toEqual([principal]);
    expect(mockSetStore).not.toHaveBeenCalled();

    request.resolve([quality]);

    await expect(refresh).resolves.toEqual([quality]);
    expect(mockStore.personalities).toEqual([quality]);
  });

  it('returns null without mutating when the caller guard is no longer current', async () => {
    mockStore.personalities = [principal];
    mockInvoke.mockResolvedValueOnce([quality]);

    await expect(refreshPersonalities(() => false)).resolves.toBeNull();

    expect(mockStore.personalities).toEqual([principal]);
    expect(mockSetStore).not.toHaveBeenCalled();
  });

  it('lets a newer open commit before an older response without being overwritten', async () => {
    const older = deferred<unknown>();
    const newer = deferred<unknown>();
    mockInvoke.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let generation = 1;

    const olderRefresh = refreshPersonalities(() => generation === 1);
    generation = 2;
    const newerRefresh = refreshPersonalities(() => generation === 2);

    newer.resolve([principal]);
    await expect(newerRefresh).resolves.toEqual([principal]);
    older.resolve([quality]);
    await expect(olderRefresh).resolves.toBeNull();

    expect(mockStore.personalities).toEqual([principal]);
    expect(mockSetStore).toHaveBeenCalledTimes(1);
  });

  it('does not commit a response that resolves after close', async () => {
    const request = deferred<unknown>();
    mockStore.personalities = [principal];
    mockInvoke.mockReturnValueOnce(request.promise);
    let open = true;

    const refresh = refreshPersonalities(() => open);
    open = false;
    request.resolve([quality]);

    await expect(refresh).resolves.toBeNull();
    expect(mockStore.personalities).toEqual([principal]);
    expect(mockSetStore).not.toHaveBeenCalled();
  });

  it('propagates an IPC failure and preserves the previous cache', async () => {
    const failure = new Error('disk unavailable');
    mockStore.personalities = [principal];
    mockInvoke.mockRejectedValueOnce(failure);

    await expect(refreshPersonalities(() => true)).rejects.toBe(failure);

    expect(mockStore.personalities).toEqual([principal]);
    expect(mockSetStore).not.toHaveBeenCalled();
  });

  it('rejects a malformed list response with a bounded error', async () => {
    mockInvoke.mockResolvedValueOnce({ path: '/private/catalog' });

    await expect(refreshPersonalities(() => true)).rejects.toThrow(
      'Invalid personality catalog response',
    );
    expect(mockSetStore).not.toHaveBeenCalled();
  });
});

describe('readPersonality', () => {
  it('sends exactly the selected ID and returns the detail DTO', async () => {
    const detail: PersonalityDetail = { ...quality, markdown: '## Focus Areas' };
    mockInvoke.mockResolvedValueOnce(detail);

    await expect(readPersonality(quality.id)).resolves.toEqual(detail);

    expect(mockInvoke).toHaveBeenCalledWith(IPC.ReadPersonality, { id: quality.id });
  });

  it('returns null when the personality no longer exists', async () => {
    mockInvoke.mockResolvedValueOnce(null);

    await expect(readPersonality(quality.id)).resolves.toBeNull();
  });
});

describe('togglePersonalityLibraryDialog', () => {
  it('supports explicit visibility and toggles from the current value', () => {
    togglePersonalityLibraryDialog(true);
    expect(mockStore.showPersonalityLibraryDialog).toBe(true);

    togglePersonalityLibraryDialog(false);
    expect(mockStore.showPersonalityLibraryDialog).toBe(false);

    togglePersonalityLibraryDialog();
    expect(mockStore.showPersonalityLibraryDialog).toBe(true);
  });
});

describe('persistence boundary', () => {
  it('keeps personality summaries and bodies out of state.json', () => {
    const persistenceSource = readFileSync(new URL('./persistence.ts', import.meta.url), 'utf8');

    expect(persistenceSource).not.toMatch(/personalit(?:y|ies)/i);
  });
});
