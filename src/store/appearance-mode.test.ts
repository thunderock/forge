/**
 * Tests for applyAppearanceMode routing logic and deleteCustomTheme slot cleanup.
 * These cover the two bugs found in code review (slot desync and dangling refs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceMode } from '../lib/look';
import type { LookPreset } from '../lib/look';
import type { CustomTheme } from '../lib/custom-theme';
import { expectDefined, type MockStoreHarness } from './test-helpers';

type MockStore = {
  appearanceMode: AppearanceMode;
  lightThemePreset: LookPreset;
  lightThemeCustomId: string | null;
  darkThemePreset: LookPreset;
  darkThemeCustomId: string | null;
  themePreset: LookPreset;
  activeCustomThemeId: string | null;
  customThemes: Record<string, CustomTheme>;
};

let mockStore: MockStore;
const core = vi.hoisted(() => ({
  harness: undefined as MockStoreHarness<MockStore> | undefined,
}));
let mockOsIsDark: boolean;

vi.mock('solid-js', () => ({
  batch: (fn: () => void) => fn(),
}));

vi.mock('solid-js/store', async () => {
  const { mockSolidStoreProduce } = await import('./test-helpers');
  return mockSolidStoreProduce();
});

vi.mock('./core', async () => {
  const { createMockStoreHarness } = await import('./test-helpers');
  core.harness = createMockStoreHarness<MockStore>({} as MockStore);
  return core.harness.moduleMock();
});

vi.mock('./navigation', () => ({ setActiveTask: vi.fn() }));
vi.mock('./focus', () => ({ setTaskFocusedPanel: vi.fn() }));

vi.mock('../lib/ipc', () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../electron/ipc/channels', () => ({ IPC: {} }));

vi.mock('../lib/os-appearance', () => ({
  get osIsDark() {
    return () => mockOsIsDark;
  },
}));

import {
  applyAppearanceMode,
  markCustomThemesReady,
  _resetCustomThemesReadyForTest,
  setAppearanceMode,
  setDarkTheme,
  setLightTheme,
  deleteCustomTheme,
} from './ui';

function makeTheme(id: string): CustomTheme {
  return { id, name: id, description: '', terminalBackground: '#000000', vars: {} };
}

beforeEach(() => {
  mockOsIsDark = true;
  const harness = expectDefined(core.harness, 'mock store harness');
  mockStore = harness.reset({
    appearanceMode: 'dark',
    lightThemePreset: 'islands-light',
    lightThemeCustomId: null,
    darkThemePreset: 'islands-dark',
    darkThemeCustomId: null,
    themePreset: 'islands-dark',
    activeCustomThemeId: null,
    customThemes: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
  _resetCustomThemesReadyForTest();
});

describe('applyAppearanceMode', () => {
  it('dark mode uses darkThemePreset and clears activeCustomThemeId', () => {
    mockStore.appearanceMode = 'dark';
    mockStore.darkThemePreset = 'graphite';
    applyAppearanceMode();
    expect(mockStore.themePreset).toBe('graphite');
    expect(mockStore.activeCustomThemeId).toBeNull();
  });

  it('light mode uses lightThemePreset', () => {
    mockStore.appearanceMode = 'light';
    mockStore.lightThemePreset = 'islands-light';
    applyAppearanceMode();
    expect(mockStore.themePreset).toBe('islands-light');
    expect(mockStore.activeCustomThemeId).toBeNull();
  });

  it('system mode picks dark slot when OS is dark', () => {
    mockOsIsDark = true;
    mockStore.appearanceMode = 'system';
    mockStore.darkThemePreset = 'midnight';
    mockStore.lightThemePreset = 'islands-light';
    applyAppearanceMode();
    expect(mockStore.themePreset).toBe('midnight');
  });

  it('system mode picks light slot when OS is light', () => {
    mockOsIsDark = false;
    mockStore.appearanceMode = 'system';
    mockStore.darkThemePreset = 'midnight';
    mockStore.lightThemePreset = 'islands-light';
    applyAppearanceMode();
    expect(mockStore.themePreset).toBe('islands-light');
  });

  it('dark mode with custom theme sets activeCustomThemeId', () => {
    mockStore.appearanceMode = 'dark';
    mockStore.darkThemePreset = 'islands-dark';
    mockStore.darkThemeCustomId = 'my-custom-id';
    mockStore.customThemes = { 'my-custom-id': makeTheme('my-custom-id') };
    applyAppearanceMode();
    expect(mockStore.activeCustomThemeId).toBe('my-custom-id');
  });

  it('before themes are loaded, stale custom IDs are preserved (startup race guard)', () => {
    mockStore.appearanceMode = 'dark';
    mockStore.darkThemeCustomId = 'restored-from-disk';
    mockStore.customThemes = {}; // themes not yet loaded
    applyAppearanceMode(); // fires reactively before markCustomThemesReady()
    expect(mockStore.darkThemeCustomId).toBe('restored-from-disk');
  });

  it('missing custom theme ID clears the slot and activeCustomThemeId', () => {
    mockStore.appearanceMode = 'dark';
    mockStore.darkThemeCustomId = 'deleted-theme';
    mockStore.customThemes = {};
    markCustomThemesReady(); // simulates post-load sanitization pass
    expect(mockStore.activeCustomThemeId).toBeNull();
    expect(mockStore.darkThemeCustomId).toBeNull();
  });

  it('system mode sanitizes inactive slot even when OS picks the other slot', () => {
    mockOsIsDark = true; // OS is dark → active slot is dark
    mockStore.appearanceMode = 'system';
    mockStore.darkThemeCustomId = null;
    mockStore.lightThemeCustomId = 'deleted-light-theme'; // stale ID in inactive slot
    mockStore.customThemes = {};
    markCustomThemesReady(); // simulates post-load sanitization pass
    expect(mockStore.lightThemeCustomId).toBeNull(); // inactive slot also cleared
    expect(mockStore.activeCustomThemeId).toBeNull(); // active slot unaffected
  });

  it('system+OS-dark picks dark custom theme', () => {
    mockOsIsDark = true;
    mockStore.appearanceMode = 'system';
    mockStore.darkThemeCustomId = 'dark-custom';
    mockStore.lightThemeCustomId = 'light-custom';
    mockStore.customThemes = {
      'dark-custom': makeTheme('dark-custom'),
      'light-custom': makeTheme('light-custom'),
    };
    applyAppearanceMode();
    expect(mockStore.activeCustomThemeId).toBe('dark-custom');
  });

  it('system+OS-light picks light custom theme', () => {
    mockOsIsDark = false;
    mockStore.appearanceMode = 'system';
    mockStore.darkThemeCustomId = 'dark-custom';
    mockStore.lightThemeCustomId = 'light-custom';
    mockStore.customThemes = {
      'dark-custom': makeTheme('dark-custom'),
      'light-custom': makeTheme('light-custom'),
    };
    applyAppearanceMode();
    expect(mockStore.activeCustomThemeId).toBe('light-custom');
  });
});

describe('setAppearanceMode', () => {
  it('updates appearanceMode and re-applies', () => {
    mockStore.darkThemePreset = 'ember';
    setAppearanceMode('dark');
    expect(mockStore.appearanceMode).toBe('dark');
    expect(mockStore.themePreset).toBe('ember');
  });
});

describe('setDarkTheme / setLightTheme', () => {
  it('setDarkTheme updates slot and applies', () => {
    mockStore.appearanceMode = 'dark';
    setDarkTheme('graphite', null);
    expect(mockStore.darkThemePreset).toBe('graphite');
    expect(mockStore.darkThemeCustomId).toBeNull();
    expect(mockStore.themePreset).toBe('graphite');
  });

  it('setLightTheme updates slot and applies', () => {
    mockStore.appearanceMode = 'light';
    mockStore.customThemes = { 'some-custom': makeTheme('some-custom') };
    setLightTheme('islands-light', 'some-custom');
    expect(mockStore.lightThemePreset).toBe('islands-light');
    expect(mockStore.lightThemeCustomId).toBe('some-custom');
    expect(mockStore.activeCustomThemeId).toBe('some-custom');
  });
});

describe('deleteCustomTheme slot cleanup', () => {
  it('clears darkThemeCustomId when the deleted theme is in the dark slot', async () => {
    mockStore.customThemes = { 'theme-a': makeTheme('theme-a') };
    mockStore.darkThemeCustomId = 'theme-a';
    mockStore.activeCustomThemeId = 'theme-a';

    await deleteCustomTheme('theme-a');

    expect(mockStore.darkThemeCustomId).toBeNull();
    expect(mockStore.activeCustomThemeId).toBeNull();
    expect(mockStore.customThemes['theme-a']).toBeUndefined();
  });

  it('clears lightThemeCustomId when the deleted theme is in the light slot', async () => {
    mockStore.customThemes = { 'theme-b': makeTheme('theme-b') };
    mockStore.lightThemeCustomId = 'theme-b';

    await deleteCustomTheme('theme-b');

    expect(mockStore.lightThemeCustomId).toBeNull();
  });

  it('clears both slots if the same theme is in both', async () => {
    mockStore.customThemes = { 'theme-c': makeTheme('theme-c') };
    mockStore.darkThemeCustomId = 'theme-c';
    mockStore.lightThemeCustomId = 'theme-c';

    await deleteCustomTheme('theme-c');

    expect(mockStore.darkThemeCustomId).toBeNull();
    expect(mockStore.lightThemeCustomId).toBeNull();
  });

  it('does not affect other themes in slots', async () => {
    mockStore.customThemes = {
      gone: makeTheme('gone'),
      kept: makeTheme('kept'),
    };
    mockStore.darkThemeCustomId = 'kept';
    mockStore.lightThemeCustomId = 'kept';

    await deleteCustomTheme('gone');

    expect(mockStore.darkThemeCustomId).toBe('kept');
    expect(mockStore.lightThemeCustomId).toBe('kept');
  });
});
