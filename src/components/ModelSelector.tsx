import { createSignal, createEffect, createMemo, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import type { AgentDef, CodexModelInfo } from '../ipc/types';
import type { ModelSelection } from '../store/types';
import { SegmentedButtons } from './SegmentedButtons';
import {
  HOST_DEFAULT,
  OTHER,
  claudeModelOptions,
  curatedModelsFor,
  effortsForModel,
  isClaude,
  isCodex,
  isEffortSupported,
  isOpenCode,
} from '../lib/agent-models';

interface ModelSelectorProps {
  agentDef: AgentDef;
  selection: ModelSelection;
  onChange: (sel: ModelSelection) => void;
}

const inputStyle = {
  flex: '1',
  background: theme.bgInput,
  border: `1px solid ${theme.border}`,
  'border-radius': '6px',
  padding: '5px 10px',
  color: theme.fg,
  'font-size': '13px',
  'font-family': "'JetBrains Mono', monospace",
  outline: 'none',
} as const;

const labelStyle = { 'font-size': '12px', color: theme.fgMuted } as const;

/**
 * Inline per-agent model picker for the New Task dialog (MDL-01/03/04). Reuses
 * the ProjectSelect `<select>` style + SegmentedButtons; opencode and codex
 * models are fetched dynamically (MDL-06), claude aliases are labeled with the
 * host-resolved IDs (MDL-08). Holds no persisted state — the dialog owns the
 * value and writes it back on submit.
 */
export function ModelSelector(props: ModelSelectorProps) {
  const [openCodeModels, setOpenCodeModels] = createSignal<string[]>([]);
  const [codexModels, setCodexModels] = createSignal<CodexModelInfo[]>([]);
  const [claudeResolved, setClaudeResolved] = createSignal<Record<string, string>>({});
  const [loadingModels, setLoadingModels] = createSignal(false);

  // Fetch dynamic opencode models when opencode is the selected agent.
  createEffect(() => {
    const def = props.agentDef;
    if (!isOpenCode(def)) {
      setOpenCodeModels([]);
      return;
    }
    setLoadingModels(true);
    void invoke<string[]>(IPC.ListOpenCodeModels)
      .then((models) => setOpenCodeModels(Array.isArray(models) ? models : []))
      .catch(() => setOpenCodeModels([]))
      .finally(() => setLoadingModels(false));
  });

  // Fetch the codex cache models (MDL-06) when codex is the selected agent;
  // empty means "use the curated fallback" (MDL-09).
  createEffect(() => {
    const def = props.agentDef;
    if (!isCodex(def)) {
      setCodexModels([]);
      return;
    }
    setLoadingModels(true);
    void invoke<CodexModelInfo[]>(IPC.ListCodexModels)
      .then((models) => setCodexModels(Array.isArray(models) ? models : []))
      .catch(() => setCodexModels([]))
      .finally(() => setLoadingModels(false));
  });

  // Resolve claude alias -> concrete-ID labels (MDL-08) when claude is selected;
  // missing resolution leaves labels as plain aliases (MDL-09).
  createEffect(() => {
    const def = props.agentDef;
    if (!isClaude(def)) {
      setClaudeResolved({});
      return;
    }
    void invoke<Record<string, string>>(IPC.ResolveClaudeModels)
      .then((resolved) =>
        setClaudeResolved(resolved && typeof resolved === 'object' ? resolved : {}),
      )
      .catch(() => setClaudeResolved({}));
  });

  const listedModels = createMemo(() => {
    if (isOpenCode(props.agentDef)) return openCodeModels();
    if (isCodex(props.agentDef)) {
      const fetched = codexModels();
      return fetched.length > 0 ? fetched.map((m) => m.slug) : curatedModelsFor(props.agentDef);
    }
    return curatedModelsFor(props.agentDef);
  });

  // <select> value: host-default, a listed model, or OTHER (custom / free-text).
  const selectValue = createMemo(() => {
    const model = props.selection.model?.trim() ?? '';
    if (!model) return HOST_DEFAULT;
    return listedModels().includes(model) ? model : OTHER;
  });

  const showOtherInput = createMemo(() => selectValue() === OTHER);
  const claudeOptions = createMemo(() => claudeModelOptions(claudeResolved()));
  const efforts = createMemo(() =>
    effortsForModel(props.agentDef, props.selection.model?.trim() || undefined, codexModels()),
  );
  const showEffort = createMemo(() => efforts().length > 0);

  // Reset an effort the selected model doesn't support (MDL-07): covers both
  // switching models and a stale persisted prefill. Waits out an in-flight codex
  // fetch so a valid persisted effort (e.g. sol+ultra) isn't cleared against the
  // static fallback list.
  createEffect(() => {
    if (isCodex(props.agentDef) && loadingModels()) return;
    if (!isEffortSupported(props.selection.reasoningEffort, efforts())) {
      props.onChange({ model: props.selection.model, reasoningEffort: undefined });
    }
  });

  function onSelectChange(value: string): void {
    const effort = props.selection.reasoningEffort;
    if (value === HOST_DEFAULT) {
      props.onChange({ reasoningEffort: effort });
    } else if (value === OTHER) {
      // Keep any existing custom text; the free-text input drives `model` from here.
      props.onChange({ model: props.selection.model ?? '', reasoningEffort: effort });
    } else {
      props.onChange({ model: value, reasoningEffort: effort });
    }
  }

  return (
    <div
      data-nav-field="model-selection"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <label style={labelStyle}>Model</label>
      <select
        class="project-select"
        value={selectValue()}
        onChange={(e) => onSelectChange(e.currentTarget.value)}
      >
        <option value={HOST_DEFAULT}>Host default</option>
        <Show when={isOpenCode(props.agentDef) && loadingModels()}>
          <option value="" disabled>
            Loading models…
          </option>
        </Show>
        <Show
          when={isClaude(props.agentDef)}
          fallback={<For each={listedModels()}>{(m) => <option value={m}>{m}</option>}</For>}
        >
          <For each={claudeOptions()}>{(o) => <option value={o.value}>{o.label}</option>}</For>
        </Show>
        <option value={OTHER}>Other…</option>
      </select>

      <Show when={showOtherInput()}>
        <input
          type="text"
          value={props.selection.model ?? ''}
          onInput={(e) =>
            props.onChange({
              model: e.currentTarget.value,
              reasoningEffort: props.selection.reasoningEffort,
            })
          }
          placeholder={isOpenCode(props.agentDef) ? 'provider/model' : 'model id'}
          style={inputStyle}
        />
      </Show>

      <Show when={showEffort()}>
        <label style={labelStyle}>Reasoning effort</label>
        <SegmentedButtons
          options={[
            { value: '', label: 'Default' },
            ...efforts().map((e) => ({ value: e, label: e })),
          ]}
          value={props.selection.reasoningEffort ?? ''}
          onChange={(v) =>
            props.onChange({ model: props.selection.model, reasoningEffort: v || undefined })
          }
        />
      </Show>
    </div>
  );
}
