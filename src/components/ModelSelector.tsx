import { createSignal, createEffect, createMemo, For, Show } from 'solid-js';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';
import type { ModelSelection } from '../store/types';
import { SegmentedButtons } from './SegmentedButtons';
import {
  HOST_DEFAULT,
  OTHER,
  CODEX_EFFORTS,
  agentSupportsEffort,
  curatedModelsFor,
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
 * the ProjectSelect `<select>` style + SegmentedButtons; opencode models are
 * fetched dynamically. Holds no persisted state — the dialog owns the value and
 * writes it back on submit.
 */
export function ModelSelector(props: ModelSelectorProps) {
  const [openCodeModels, setOpenCodeModels] = createSignal<string[]>([]);
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

  const listedModels = createMemo(() =>
    isOpenCode(props.agentDef) ? openCodeModels() : curatedModelsFor(props.agentDef),
  );

  // <select> value: host-default, a listed model, or OTHER (custom / free-text).
  const selectValue = createMemo(() => {
    const model = props.selection.model?.trim() ?? '';
    if (!model) return HOST_DEFAULT;
    return listedModels().includes(model) ? model : OTHER;
  });

  const showOtherInput = createMemo(() => selectValue() === OTHER);
  const showEffort = createMemo(() => agentSupportsEffort(props.agentDef));

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
        <For each={listedModels()}>{(m) => <option value={m}>{m}</option>}</For>
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
            ...CODEX_EFFORTS.map((e) => ({ value: e as string, label: e })),
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
