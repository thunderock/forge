import { For, Show } from 'solid-js';
import { store } from '../store/store';
import { theme } from '../lib/theme';
import type { AgentDef } from '../ipc/types';

interface AgentSelectorProps {
  agents: AgentDef[];
  // Single-select mode (default)
  selectedAgent?: AgentDef | null;
  onSelect?: (agent: AgentDef) => void;
  // Multi-select mode (fan-out): pass multiSelect + selectedIds + onToggle
  multiSelect?: boolean;
  selectedIds?: Set<string>;
  onToggle?: (agent: AgentDef) => void;
  wrap?: boolean;
  showNone?: boolean;
  noneLabel?: string;
  onClear?: () => void;
  density?: 'editor';
  describedBy?: string;
}

/**
 * Agent picker. Single-select (roving-tabindex radiogroup) by default; opt into
 * `multiSelect` (checkbox group) for fan-out — where uninstalled agents are shown
 * but not selectable.
 */
export function AgentSelector(props: AgentSelectorProps) {
  const btnRefs: HTMLButtonElement[] = [];
  const allowWrap = () => props.wrap ?? true;
  const isMulti = () => props.multiSelect === true;
  const options = (): (AgentDef | null)[] =>
    !isMulti() && props.showNone ? [null, ...props.agents] : props.agents;

  const isSelected = (agent: AgentDef | null) => {
    if (!agent) return !isMulti() && !props.selectedAgent;
    return isMulti()
      ? (props.selectedIds?.has(agent.id) ?? false)
      : props.selectedAgent?.id === agent.id;
  };

  // Only multi-select disables uninstalled agents; single-select keeps today's behavior.
  const isDisabled = (agent: AgentDef | null) =>
    agent !== null && isMulti() && agent.available === false;

  function activate(agent: AgentDef | null) {
    if (isDisabled(agent)) return;
    if (!agent) {
      props.onClear?.();
    } else if (isMulti()) {
      props.onToggle?.(agent);
    } else {
      props.onSelect?.(agent);
    }
  }

  function handleKeyDown(e: KeyboardEvent, idx: number) {
    const agents = options();
    let nextIdx: number | null = null;

    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIdx = (idx + 1) % agents.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIdx = (idx - 1 + agents.length) % agents.length;
    }

    if (nextIdx !== null) {
      // Radio semantics select on arrow; checkbox group only moves focus (Space/Enter toggles).
      if (!isMulti()) activate(agents[nextIdx] ?? null);
      btnRefs[nextIdx]?.focus();
    }
  }

  const tabIndexFor = (agent: AgentDef | null) => {
    if (isMulti()) return isDisabled(agent) ? -1 : 0;
    return isSelected(agent) ? 0 : -1;
  };

  return (
    <div
      class={`agent-selector${props.density === 'editor' ? ' agent-selector-editor' : ''}`}
      data-nav-field="agent"
      style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}
    >
      <label
        style={{
          'font-size': '12px',
          color: theme.fgMuted,
          'text-transform': 'uppercase',
          'letter-spacing': '0.05em',
        }}
      >
        {isMulti() ? 'Agents (each runs in its own worktree)' : 'Agent'}
      </label>
      <div
        role={isMulti() ? 'group' : 'radiogroup'}
        aria-describedby={props.describedBy}
        style={{
          display: 'flex',
          'flex-wrap': allowWrap() ? 'wrap' : 'nowrap',
          gap: '8px',
          'overflow-x': allowWrap() ? undefined : 'auto',
          'overflow-y': 'hidden',
          'padding-bottom': allowWrap() ? undefined : '2px',
        }}
      >
        <For each={options()}>
          {(agent, i) => (
            <button
              ref={(el) => (btnRefs[i()] = el)}
              type="button"
              role={isMulti() ? 'checkbox' : 'radio'}
              aria-checked={isSelected(agent)}
              disabled={isDisabled(agent)}
              tabIndex={tabIndexFor(agent)}
              class={`agent-btn ${isSelected(agent) ? 'selected' : ''}`}
              onClick={() => activate(agent)}
              onKeyDown={(e) => handleKeyDown(e, i())}
              style={{
                flex: allowWrap() ? '0 1 auto' : '0 0 auto',
                'min-width': '70px',
                padding: '10px 8px',
                background: isSelected(agent) ? theme.bgSelected : theme.bgInput,
                border: isSelected(agent)
                  ? `1px solid ${theme.accent}`
                  : `1px solid ${theme.border}`,
                'border-radius': '8px',
                color: isSelected(agent)
                  ? store.themePreset === 'graphite' ||
                    store.themePreset === 'minimal' ||
                    store.themePreset === 'zenburnesque'
                    ? '#ffffff'
                    : theme.accentText
                  : theme.fg,
                cursor: isDisabled(agent) ? 'not-allowed' : 'pointer',
                opacity: isDisabled(agent) ? 0.5 : 1,
                'font-size': '13px',
                'font-weight': isSelected(agent) ? '500' : '400',
                'text-align': 'center',
                'white-space': 'nowrap',
              }}
            >
              {agent?.name ?? props.noneLabel ?? 'None'}
              <Show when={agent?.available === false}>
                <span
                  style={{
                    'font-size': '11px',
                    color: theme.fgMuted,
                    'margin-left': '4px',
                  }}
                >
                  (not installed)
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
