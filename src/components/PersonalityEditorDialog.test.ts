import { readFileSync } from 'node:fs';
import { renderToString } from 'solid-js/web';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDef, PersonalityDetail, PersonalityWriteFields } from '../ipc/types';
import type { ModelSelection } from '../store/types';
import { AgentSelector } from './AgentSelector';
import { ModelSelector } from './ModelSelector';
import {
  MAX_PERSONALITY_MARKDOWN_BYTES,
  PERSONALITY_COLOR_OPTIONS,
  createPersonalityModeSubmitter,
  createPersonalitySubmitter,
  nextPersonalityColorIndex,
  normalizePersonalityColor,
  personalityMarkdownBytes,
  retainLastValidIdentity,
  validatePersonalityDraft,
} from './PersonalityEditorDialog';

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

const validFields: PersonalityWriteFields = {
  name: 'Incident Commander',
  badge: 'IC',
  color: '#FF6A2C',
  markdown: '## Role\n\nCoordinate the response.',
};

const savedDetail: PersonalityDetail = {
  id: 'incident-commander',
  builtin: false,
  modifiedFromSeed: false,
  ...validFields,
};

function agentDef(id: string, name: string, command: string, available = true): AgentDef {
  return {
    id,
    name,
    command,
    args: [],
    resume_args: [],
    skip_permissions_args: [],
    description: '',
    available,
  };
}

type PersonalityEditorSaveTarget = { mode: 'create' | 'copy' } | { mode: 'edit'; id: string };

interface LoadedPersonalityDraft {
  mode: 'edit' | 'copy';
  sourceId: string;
  fields: PersonalityWriteFields;
}

interface PersonalityDraftLoader {
  load: (id: string) => Promise<void>;
  invalidate: () => void;
}

interface EditAndCopyContractModule {
  personalityDraftFromDetail?: (detail: PersonalityDetail) => LoadedPersonalityDraft;
  createPersonalityDraftLoader?: (options: {
    read: (id: string) => Promise<PersonalityDetail | null>;
    isActive: () => boolean;
    onLoading: (id: string) => void;
    onLoaded: (draft: LoadedPersonalityDraft) => void;
    onError: (id: string) => void;
  }) => PersonalityDraftLoader;
  createPersonalityModeSubmitter?: (options: {
    create: (fields: PersonalityWriteFields) => Promise<PersonalityDetail>;
    update: (id: string, fields: PersonalityWriteFields) => Promise<PersonalityDetail>;
    onSaved: (id: string) => void;
    onPending: (pending: boolean) => void;
    onError: (target: PersonalityEditorSaveTarget) => void;
  }) => (target: PersonalityEditorSaveTarget, fields: PersonalityWriteFields) => Promise<boolean>;
}

async function editAndCopyContract(): Promise<EditAndCopyContractModule> {
  return (await import('./PersonalityEditorDialog')) as unknown as EditAndCopyContractModule;
}

describe('RED: create editor contract', () => {
  it('starts blank with Forge orange, no eager errors, and a disabled create action', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain("createSignal('')");
    expect(source).toContain("createSignal('#FF6A2C')");
    expect(source).toContain('Create Personality');
    expect(source).toMatch(/disabled=\{[^}]*isValid/);
    expect(source).not.toMatch(/setTouched\([^,]+,\s*true\).*createEffect/s);
  });

  it('returns the exact validation messages for touched or submitted invalid fields', () => {
    expect(
      validatePersonalityDraft({ name: '', badge: '', color: 'orange', markdown: '' }),
    ).toEqual({
      name: 'Enter a name.',
      badge: 'Use 1–4 letters or numbers.',
      color: 'Enter a hex color such as #7A78FF.',
      markdown: 'Add Markdown instructions.',
    });

    expect(
      validatePersonalityDraft({
        ...validFields,
        markdown: 'é'.repeat(MAX_PERSONALITY_MARKDOWN_BYTES / 2 + 1),
      }),
    ).toEqual({ markdown: 'Instructions must be smaller than 2 MB.' });
  });

  it('counts UTF-8 bytes and normalizes only valid free-form colors', () => {
    expect(personalityMarkdownBytes('é')).toBe(2);
    expect(personalityMarkdownBytes('hello')).toBe(5);
    expect(normalizePersonalityColor('#abc')).toBe('#ABC');
    expect(normalizePersonalityColor('#7a78ff')).toBe('#7A78FF');
    expect(normalizePersonalityColor('rgb(0, 0, 0)')).toBeNull();
  });

  it('defines the exact accessible eight-swatch palette and keyboard movement', () => {
    expect(PERSONALITY_COLOR_OPTIONS).toEqual([
      { name: 'Mint', value: '#2FD198' },
      { name: 'Violet', value: '#7A78FF' },
      { name: 'Orange', value: '#FF944D' },
      { name: 'Forge orange', value: '#FF6A2C' },
      { name: 'Blue', value: '#4DA3FF' },
      { name: 'Pink', value: '#E85D9E' },
      { name: 'Gold', value: '#F5C451' },
      { name: 'Red', value: '#F05D5E' },
    ]);
    expect(nextPersonalityColorIndex('ArrowRight', 7, 8)).toBe(0);
    expect(nextPersonalityColorIndex('ArrowLeft', 0, 8)).toBe(7);
    expect(nextPersonalityColorIndex('Home', 5, 8)).toBe(0);
    expect(nextPersonalityColorIndex('End', 1, 8)).toBe(7);
    expect(nextPersonalityColorIndex('Enter', 1, 8)).toBeNull();
  });

  it('uppercases valid badge input and retains the last valid preview identity', () => {
    const initial = { badge: 'QE', color: '#FF6A2C' };
    const updated = retainLastValidIdentity(initial, 'ai', '#abc');

    expect(updated).toEqual({ badge: 'AI', color: '#ABC' });
    expect(retainLastValidIdentity(updated, 'A!', 'not-a-color')).toEqual(updated);
  });

  it('locks duplicate submits, reports pending state, and emits only the returned ID', async () => {
    const request = deferred<PersonalityDetail>();
    const create = vi.fn(() => request.promise);
    const onSaved = vi.fn();
    const onPending = vi.fn();
    const onError = vi.fn();
    const submit = createPersonalitySubmitter({ create, onSaved, onPending, onError });

    const first = submit(validFields);
    const duplicate = submit(validFields);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(validFields);
    expect(onPending).toHaveBeenLastCalledWith(true);

    request.resolve(savedDetail);
    await expect(first).resolves.toBe(true);
    await expect(duplicate).resolves.toBe(false);
    expect(onSaved).toHaveBeenCalledWith(savedDetail.id);
    expect(onPending).toHaveBeenLastCalledWith(false);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retains the draft after rejection and permits one explicit retry', async () => {
    const firstRequest = deferred<PersonalityDetail>();
    const create = vi
      .fn<(_fields: PersonalityWriteFields) => Promise<PersonalityDetail>>()
      .mockImplementationOnce(() => firstRequest.promise)
      .mockResolvedValueOnce(savedDetail);
    const onSaved = vi.fn();
    const onPending = vi.fn();
    const onError = vi.fn();
    const submit = createPersonalitySubmitter({ create, onSaved, onPending, onError });

    const first = submit(validFields);
    if (create.mock.calls.length > 0) {
      firstRequest.reject(new Error('/private/path must stay hidden'));
    }
    await expect(first).resolves.toBe(false);

    expect(validFields).toEqual({
      name: 'Incident Commander',
      badge: 'IC',
      color: '#FF6A2C',
      markdown: '## Role\n\nCoordinate the response.',
    });
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(submit(validFields)).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledWith(savedDetail.id);
  });

  it('renders the fixed create shell, linked validation, swatch state, and busy lock hooks', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

    expect(source).toContain('Create a reusable personality available in every project.');
    expect(source).toContain('Shown in the library and future task panes.');
    expect(source).toContain('1–4 letters or numbers.');
    expect(source).toContain('Describe the role, focus, approach, and anti-patterns in Markdown…');
    expect(source).toContain('Markdown size:');
    expect(source).toContain('Creating…');
    expect(source).toContain('aria-describedby');
    expect(source).toContain('aria-invalid');
    expect(source).toContain('aria-pressed');
    expect(source).toContain('role="alert"');
    expect(source).toContain('personality-editor-body');
    expect(source).toContain('personality-editor-footer');
    expect(source).toContain("'max-height': 'calc(100vh - 64px)'");
    expect(styles).toMatch(/\.personality-editor-swatch[\s\S]*?color: var\(--fg\);/);
    expect(styles).toMatch(/\.personality-markdown \{[\s\S]*?font-size: 16px;/);
  });
});

describe('RED: binding editor contract', () => {
  const claude = agentDef('claude-code', 'Claude Code', 'claude', false);
  const codex = agentDef('codex', 'Codex CLI', 'codex');
  const opencode = agentDef('opencode', 'OpenCode', 'opencode');
  const custom = agentDef('custom-reviewer', 'Custom Reviewer', 'reviewer');

  it('filters and labels exactly the three portable built-in binding agents', async () => {
    const editorModule = await import('./PersonalityEditorDialog');
    const filter = (
      editorModule as unknown as {
        personalityBindingAgents?: (agents: AgentDef[]) => AgentDef[];
      }
    ).personalityBindingAgents;

    expect(filter).toBeTypeOf('function');
    if (!filter) return;

    expect(filter([custom, opencode, claude, codex])).toEqual([
      { ...claude, name: 'Claude Code' },
      { ...codex, name: 'Codex' },
      { ...opencode, name: 'opencode' },
    ]);
  });

  it('opts into a selected None radio while unavailable built-ins remain selectable', () => {
    const onClear = vi.fn();
    const props: Parameters<typeof AgentSelector>[0] & {
      showNone: boolean;
      noneLabel: string;
      onClear: () => void;
      density: 'editor';
    } = {
      agents: [claude, { ...codex, name: 'Codex' }, { ...opencode, name: 'opencode' }],
      selectedAgent: null,
      onSelect: vi.fn(),
      showNone: true,
      noneLabel: 'None',
      onClear,
      density: 'editor',
    };

    const html = renderToString(() => AgentSelector(props));

    expect(html.match(/role="radio"/g)).toHaveLength(4);
    expect(html).toContain('None');
    expect(html).toContain('Claude Code');
    expect(html).toContain('(not installed)');
    expect(html).toContain('Codex');
    expect(html).toContain('opencode');
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain('disabled');
    expect(html).toContain('agent-selector-editor');
  });

  it('preserves AgentSelector defaults when nullable editor props are omitted', () => {
    const html = renderToString(() =>
      AgentSelector({ agents: [codex], selectedAgent: codex, onSelect: vi.fn() }),
    );

    expect(html).toContain('Codex CLI');
    expect(html).not.toContain('>None<');
    expect(html).not.toContain('agent-selector-editor');
  });

  it('keeps a free-form model visible after an empty dynamic catalog result', () => {
    const selection: ModelSelection = { model: 'provider/custom-model' };
    const baseProps: Parameters<typeof ModelSelector>[0] = {
      agentDef: opencode,
      selection,
      onChange: vi.fn(),
    };
    const editorProps: Parameters<typeof ModelSelector>[0] & { density: 'editor' } = {
      ...baseProps,
      density: 'editor',
    };

    const defaultHtml = renderToString(() => ModelSelector(baseProps));
    const editorHtml = renderToString(() => ModelSelector(editorProps));

    expect(editorHtml).toContain('provider/custom-model');
    expect(editorHtml).toContain('model-selector-editor');
    expect(defaultHtml).not.toContain('model-selector-editor');
  });

  it('renders exact binding copy, clears selection on agent changes, and hides models for None', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('Default binding');
    expect(source).toMatch(
      /Saved with this personality to prefill future task setup\. You can override it per\s+run\./,
    );
    expect(source).toContain('Forge will use its normal task default.');
    expect(source).toContain('<AgentSelector');
    expect(source).toContain('showNone');
    expect(source).toContain('noneLabel="None"');
    expect(source).toContain('<ModelSelector');
    expect(source).toContain('setModelSelection({})');
    expect(source).toMatch(/<Show\s+when=\{selectedBindingAgent\(\)\}/);
    expect(source).not.toContain('customAgents');
  });
});

describe('RED: edit and copy editor contract', () => {
  const customWithBinding: PersonalityDetail = {
    ...savedDetail,
    defaultAgent: 'codex',
    defaultModel: 'gpt-5.6-sol',
    defaultReasoningEffort: 'high',
  };
  const builtinWithBinding: PersonalityDetail = {
    id: 'principal-engineer',
    name: 'Principal Engineer',
    badge: 'PE',
    color: '#7A78FF',
    builtin: true,
    modifiedFromSeed: true,
    markdown: '## Role\n\nGuide high-leverage architecture.',
    defaultAgent: 'claude-code',
    defaultModel: 'fable',
    defaultReasoningEffort: 'max',
  };

  it('derives edit versus copy only from fresh detail and copies narrow editable fields', async () => {
    const { personalityDraftFromDetail } = await editAndCopyContract();

    expect(personalityDraftFromDetail).toBeTypeOf('function');
    if (!personalityDraftFromDetail) return;

    expect(personalityDraftFromDetail(customWithBinding)).toEqual({
      mode: 'edit',
      sourceId: customWithBinding.id,
      fields: {
        name: customWithBinding.name,
        badge: customWithBinding.badge,
        color: customWithBinding.color,
        markdown: customWithBinding.markdown,
        defaultAgent: 'codex',
        defaultModel: 'gpt-5.6-sol',
        defaultReasoningEffort: 'high',
      },
    });

    const privateBuiltin = {
      ...builtinWithBinding,
      path: '/private/personality.md',
      seedRevision: 42,
      pristineHash: 'must-not-cross',
    };
    const copy = personalityDraftFromDetail(privateBuiltin);
    expect(copy).toEqual({
      mode: 'copy',
      sourceId: builtinWithBinding.id,
      fields: {
        name: 'Principal Engineer (Copy)',
        badge: 'PE',
        color: '#7A78FF',
        markdown: builtinWithBinding.markdown,
        defaultAgent: 'claude-code',
        defaultModel: 'fable',
        defaultReasoningEffort: 'max',
      },
    });
    expect(copy.fields).not.toHaveProperty('builtin');
    expect(copy.fields).not.toHaveProperty('modifiedFromSeed');
    expect(copy.fields).not.toHaveProperty('path');
    expect(copy.fields).not.toHaveProperty('seedRevision');
    expect(copy.fields).not.toHaveProperty('pristineHash');
  });

  it('accepts only the newest open target and invalidates pending reads on close', async () => {
    const { createPersonalityDraftLoader } = await editAndCopyContract();

    expect(createPersonalityDraftLoader).toBeTypeOf('function');
    if (!createPersonalityDraftLoader) return;

    const customRequest = deferred<PersonalityDetail | null>();
    const builtinRequest = deferred<PersonalityDetail | null>();
    const closedRequest = deferred<PersonalityDetail | null>();
    const read = vi
      .fn<(id: string) => Promise<PersonalityDetail | null>>()
      .mockImplementationOnce(() => customRequest.promise)
      .mockImplementationOnce(() => builtinRequest.promise)
      .mockImplementationOnce(() => closedRequest.promise);
    const onLoading = vi.fn();
    const onLoaded = vi.fn();
    const onError = vi.fn();
    let open = true;
    const loader = createPersonalityDraftLoader({
      read,
      isActive: () => open,
      onLoading,
      onLoaded,
      onError,
    });

    const customLoad = loader.load(customWithBinding.id);
    const builtinLoad = loader.load(builtinWithBinding.id);
    builtinRequest.resolve(builtinWithBinding);
    await builtinLoad;
    customRequest.resolve(customWithBinding);
    await customLoad;

    expect(read).toHaveBeenNthCalledWith(1, customWithBinding.id);
    expect(read).toHaveBeenNthCalledWith(2, builtinWithBinding.id);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded).toHaveBeenCalledWith({
      mode: 'copy',
      sourceId: builtinWithBinding.id,
      fields: expect.objectContaining({ name: 'Principal Engineer (Copy)' }),
    });

    const closedLoad = loader.load(customWithBinding.id);
    open = false;
    loader.invalidate();
    closedRequest.resolve(customWithBinding);
    await closedLoad;

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onLoading).toHaveBeenCalledTimes(3);
  });

  it('routes current read failures to recovery without fabricating a draft', async () => {
    const { createPersonalityDraftLoader } = await editAndCopyContract();

    expect(createPersonalityDraftLoader).toBeTypeOf('function');
    if (!createPersonalityDraftLoader) return;

    const onLoaded = vi.fn();
    const onError = vi.fn();
    const loader = createPersonalityDraftLoader({
      read: vi.fn().mockRejectedValueOnce(new Error('/private/path stays hidden')),
      isActive: () => true,
      onLoading: vi.fn(),
      onLoaded,
      onError,
    });

    await loader.load(customWithBinding.id);

    expect(onLoaded).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(customWithBinding.id);
  });

  it('updates a custom and creates a built-in copy end to end', async () => {
    const { personalityDraftFromDetail, createPersonalityModeSubmitter } =
      await editAndCopyContract();

    expect(personalityDraftFromDetail).toBeTypeOf('function');
    expect(createPersonalityModeSubmitter).toBeTypeOf('function');
    if (!personalityDraftFromDetail || !createPersonalityModeSubmitter) return;

    const copiedDetail: PersonalityDetail = {
      ...builtinWithBinding,
      id: 'principal-engineer-copy',
      name: 'Principal Engineer (Copy)',
      builtin: false,
      modifiedFromSeed: false,
    };
    const create = vi.fn().mockResolvedValue(copiedDetail);
    const update = vi.fn().mockResolvedValue(customWithBinding);
    const onSaved = vi.fn();
    const onPending = vi.fn();
    const onError = vi.fn();
    const submit = createPersonalityModeSubmitter({
      create,
      update,
      onSaved,
      onPending,
      onError,
    });

    const customDraft = personalityDraftFromDetail(customWithBinding);
    const copyDraft = personalityDraftFromDetail(builtinWithBinding);
    await expect(
      submit({ mode: 'edit', id: customDraft.sourceId }, customDraft.fields),
    ).resolves.toBe(true);
    await expect(submit({ mode: 'copy' }, copyDraft.fields)).resolves.toBe(true);

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(customWithBinding.id, customDraft.fields);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(copyDraft.fields);
    expect(onSaved.mock.calls).toEqual([[customWithBinding.id], [copiedDetail.id]]);
    expect(onPending.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retains a failed mode draft and permits one explicit retry without crossing mutations', async () => {
    const { createPersonalityModeSubmitter } = await editAndCopyContract();

    expect(createPersonalityModeSubmitter).toBeTypeOf('function');
    if (!createPersonalityModeSubmitter) return;

    const update = vi
      .fn<(_id: string, _fields: PersonalityWriteFields) => Promise<PersonalityDetail>>()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(customWithBinding);
    const create = vi.fn<(_fields: PersonalityWriteFields) => Promise<PersonalityDetail>>();
    const onSaved = vi.fn();
    const onError = vi.fn();
    const submit = createPersonalityModeSubmitter({
      create,
      update,
      onSaved,
      onPending: vi.fn(),
      onError,
    });
    const fields = { ...validFields };
    const target: PersonalityEditorSaveTarget = { mode: 'edit', id: customWithBinding.id };

    await expect(submit(target, fields)).resolves.toBe(false);
    expect(fields).toEqual(validFields);
    expect(onError).toHaveBeenCalledWith(target);
    await expect(submit(target, fields)).resolves.toBe(true);

    expect(update).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(onSaved).toHaveBeenCalledWith(customWithBinding.id);
  });

  it('renders exact mode, loading, recovery, busy, and failure copy with no privileged fields', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('editId?: string | null');
    expect(source).toContain('Edit Personality');
    expect(source).toContain('Create Personality Copy');
    expect(source).toContain(
      'Update this personality’s identity, instructions, and default binding.',
    );
    expect(source).toContain(
      'The built-in stays unchanged. Saving creates a new custom personality.',
    );
    expect(source).toContain('Save Changes');
    expect(source).toContain('Create Copy');
    expect(source).toContain('Saving…');
    expect(source).toContain('Creating copy…');
    expect(source).toContain('Reload Personality');
    expect(source).toContain('Close Editor');
    expect(source).toContain('Couldn’t save changes. Review the fields and try again.');
    expect(source).toContain('Couldn’t create the copy. Review the fields and try again.');
    expect(source).not.toContain('seedRevision');
    expect(source).not.toContain('pristineHash');
    expect(source).not.toContain('copiedFrom');
    expect(source).not.toContain('Delete');
  });
});

describe('RED: markdown preview contract', () => {
  it('gates one sanitized HTML sink behind explicit Preview mode', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('createHighlightedMarkdownState');
    expect(source).toMatch(
      /createHighlightedMarkdownState\(\(\) =>[\s\S]{0,80}previewing\(\) \? markdown\(\) : undefined/,
    );
    expect(source.match(/\binnerHTML=/g)).toHaveLength(1);
    expect(source).toMatch(/innerHTML=\{markdownPreview\.html\(\)\}/);
    expect(source).not.toMatch(/\bMarked\b|DOMPurify|mermaid\.render/);
  });

  it('defines keyboard-selecting Edit and Preview tabs with one active panel', async () => {
    const editorModule = (await import('./PersonalityEditorDialog')) as unknown as {
      nextPersonalityMarkdownTabIndex?: (key: string, current: number) => number | null;
    };
    const nextTab = editorModule.nextPersonalityMarkdownTabIndex;
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(nextTab).toBeTypeOf('function');
    if (!nextTab) return;
    expect(nextTab('ArrowRight', 0)).toBe(1);
    expect(nextTab('ArrowRight', 1)).toBe(0);
    expect(nextTab('ArrowLeft', 0)).toBe(1);
    expect(nextTab('Home', 1)).toBe(0);
    expect(nextTab('End', 0)).toBe(1);
    expect(nextTab('Enter', 0)).toBeNull();
    expect(source).toContain('role="tablist"');
    expect(source.match(/role="tab"/g)).toHaveLength(2);
    expect(source).toContain('aria-selected');
    expect(source).toContain('aria-controls');
    expect(source).toContain('role="tabpanel"');
    expect(source).toContain('aria-labelledby');
  });

  it('renders exact empty and current-generation loading preview states', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain('Add Markdown instructions to preview them.');
    expect(source).toContain('Rendering preview…');
    expect(source).toMatch(/markdownPreview\.loading\(\)/);
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
  });

  it('keeps approved editor geometry, typography, scrolling, and responsive minima', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

    expect(source).toContain('width="min(840px, calc(100vw - 32px))"');
    expect(source).toContain("height: 'min(720px, calc(100vh - 64px))'");
    expect(styles).toMatch(
      /\.personality-editor-body \{[\s\S]*?padding: 24px;[\s\S]*?overflow-y: auto;/,
    );
    expect(styles).toMatch(/\.personality-editor-form \{[\s\S]*?max-width: 760px;/);
    expect(styles).toMatch(
      /\.personality-editor-preview \{[\s\S]*?min-height: 320px;[\s\S]*?padding: 24px;[\s\S]*?overflow: auto;/,
    );
    expect(styles).toMatch(/\.personality-editor-heading-copy h2 \{[\s\S]*?font-size: 20px;/);
    expect(styles).toMatch(
      /\.personality-markdown \{[\s\S]*?font-size: 16px;[\s\S]*?line-height: 1\.7;/,
    );
    expect(styles).toMatch(
      /\.personality-markdown h1,[\s\S]*?\{[\s\S]*?font-size: 20px;[\s\S]*?line-height: 1\.2;/,
    );
    expect(styles).toMatch(/\.personality-markdown code,[\s\S]*?\{[\s\S]*?font-size: 14px;/);
    expect(styles).toMatch(
      /@media \(max-width: 719px\) \{[\s\S]*?\.personality-editor-identity-grid \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/,
    );
    expect(styles).toMatch(
      /@media \(max-height: 639px\) \{[\s\S]*?\.personality-editor-(?:markdown|preview)[\s\S]*?min-height: 240px;/,
    );
  });
});

describe('RED: topmost dialog contract', () => {
  it('routes header, footer, overlay, and Escape exits through one mutation guard', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toMatch(
      /function requestClose\(\): void \{[\s\S]*?if \(saving\(\)\) return;[\s\S]*?props\.onClose\(\);[\s\S]*?\}/,
    );
    expect(source).toContain('onClose={requestClose}');
    expect(source.match(/onClick=\{requestClose\}/g)).toHaveLength(3);
    expect(source).not.toContain("document.addEventListener('keydown'");
  });

  it('keeps the draft busy and every direct close or submit control locked during mutation', () => {
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(source).toContain("aria-busy={saving() || loading() ? 'true' : undefined}");
    expect(
      (source.match(/<fieldset[\s\S]*?disabled=\{saving\(\)\}/g) ?? []).length,
    ).toBeGreaterThanOrEqual(3);
    expect((source.match(/disabled=\{saving\(\)\}/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(source).toContain('disabled={!isValid() || saving()}');
  });

  it('allows only one mode-aware mutation until the pending request settles', async () => {
    const request = deferred<PersonalityDetail>();
    const create = vi.fn<(_fields: PersonalityWriteFields) => Promise<PersonalityDetail>>();
    const update = vi.fn(() => request.promise);
    const onPending = vi.fn();
    const onSaved = vi.fn();
    const submit = createPersonalityModeSubmitter({
      create,
      update,
      onPending,
      onSaved,
      onError: vi.fn(),
    });
    const target: PersonalityEditorSaveTarget = { mode: 'edit', id: savedDetail.id };

    const first = submit(target, validFields);
    const duplicate = submit(target, validFields);

    expect(update).toHaveBeenCalledTimes(1);
    expect(onPending).toHaveBeenLastCalledWith(true);
    await expect(duplicate).resolves.toBe(false);

    request.resolve(savedDetail);
    await expect(first).resolves.toBe(true);
    expect(onPending).toHaveBeenLastCalledWith(false);
    expect(onSaved).toHaveBeenCalledWith(savedDetail.id);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('RED: reset catalog contract', () => {
  it('keeps built-in modification and reset metadata outside every editor draft', async () => {
    const { personalityDraftFromDetail } = await editAndCopyContract();
    const source = readFileSync(new URL('./PersonalityEditorDialog.tsx', import.meta.url), 'utf8');

    expect(personalityDraftFromDetail).toBeTypeOf('function');
    if (!personalityDraftFromDetail) return;

    const detail = {
      id: 'principal-engineer',
      name: 'Principal Engineer',
      badge: 'PE',
      color: '#7A78FF',
      builtin: true,
      modifiedFromSeed: true,
      markdown: '## Role\n\nGuide high-leverage architecture.',
      seedRevision: 42,
      pristineHash: 'must-not-cross',
      path: '/private/personality.md',
      filename: 'principal-engineer.md',
      rawYaml: 'must-not-cross',
      reset: true,
    };

    const draft = personalityDraftFromDetail(detail);

    expect(draft.fields).not.toHaveProperty('builtin');
    expect(draft.fields).not.toHaveProperty('modifiedFromSeed');
    expect(draft.fields).not.toHaveProperty('seedRevision');
    expect(draft.fields).not.toHaveProperty('pristineHash');
    expect(draft.fields).not.toHaveProperty('path');
    expect(draft.fields).not.toHaveProperty('filename');
    expect(draft.fields).not.toHaveProperty('rawYaml');
    expect(draft.fields).not.toHaveProperty('reset');
    expect(source).not.toContain('resetPersonality');
    expect(source).not.toContain('seedRevision');
    expect(source).not.toContain('pristineHash');
    expect(source).not.toContain('rawYaml');
  });
});
