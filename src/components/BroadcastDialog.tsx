import { createSignal, createEffect, createUniqueId, on, For, Show } from 'solid-js';
import { Dialog } from './Dialog';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { broadcast, getBroadcastTargetCount } from '../store/store';
import { theme, sectionLabelStyle, bannerStyle } from '../lib/theme';
import { isMac } from '../lib/platform';

interface BroadcastDialogProps {
  open: boolean;
  onClose: () => void;
}

// Fire-and-read dialog over the tested broadcast() engine. Presents EXACTLY a
// prompt textarea + an optional skill field (autocompleted from the same
// IPC.ListAgentSkills used by NewTaskDialog) — no agent/model/git options. It
// only calls the engine: it never focuses a terminal pane nor changes the
// active task, so delivery (via sendPrompt → pty write) is focus-independent
// and reaches background agents while a shell (or nothing) is focused.
export function BroadcastDialog(props: BroadcastDialogProps) {
  const [prompt, setPrompt] = createSignal('');
  // Optional skill, rendered per-agent inside broadcast() (`/name` claude/opencode,
  // `$name` codex). Suggestions are best-effort autocomplete only.
  const [skill, setSkill] = createSignal('');
  const [skillSuggestions, setSkillSuggestions] = createSignal<string[]>([]);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const titleId = createUniqueId();
  const skillListId = createUniqueId();

  // Live compose-time target count. getBroadcastTargetCount() reads the store, so
  // calling it in JSX keeps this reactive — it reflects agents that start or exit
  // while the dialog is open, not just the count at open time.
  const targetCount = () => getBroadcastTargetCount();
  const sendLabel = isMac ? '⌘⇧⏎' : 'Ctrl+Shift+Enter';

  // Reset the compose state and pull fresh skill suggestions on each open.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setPrompt('');
        setSkill('');
        setSending(false);
        setError('');
        invoke<string[]>(IPC.ListAgentSkills).then(
          (skills) => setSkillSuggestions(Array.isArray(skills) ? skills : []),
          () => setSkillSuggestions([]),
        );
      },
    ),
  );

  const canSend = () => prompt().trim().length > 0 && !sending();

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!canSend()) return;
    const text = prompt().trim();
    const skillArg = skill().trim() || undefined;
    setSending(true);
    setError('');
    try {
      // Fire-and-forget: the engine owns delivery/queueing independently of this
      // dialog, so dismiss immediately on success. Per-agent feedback shows at the
      // bottom of each pane — immediate delivery, or a "Queued (broadcast): …" line
      // for a busy agent (getBroadcastPending → PromptInput).
      await broadcast(text, skillArg);
      props.onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={props.open} onClose={props.onClose} width="520px" labelledBy={titleId}>
      <form
        onSubmit={handleSubmit}
        style={{ display: 'flex', 'flex-direction': 'column', gap: '20px' }}
      >
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '4px' }}>
          <h2
            id={titleId}
            style={{ margin: '0', 'font-size': '17px', color: theme.fg, 'font-weight': '600' }}
          >
            Broadcast Prompt
          </h2>
          <span style={{ 'font-size': '13px', color: theme.fgMuted }}>
            Sends to {targetCount()} running agents
          </span>
        </div>

        {/* Prompt */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <label style={sectionLabelStyle}>Prompt</label>
          <textarea
            autofocus
            class="input-field"
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                e.stopPropagation();
                if (canSend()) void handleSubmit(e);
              }
            }}
            placeholder="What should every running agent work on?"
            rows={4}
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '14px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
              resize: 'vertical',
            }}
          />
        </div>

        {/* Skill (optional) — rendered per-agent (/name vs $name) inside broadcast() */}
        <div style={{ display: 'flex', 'flex-direction': 'column', gap: '8px' }}>
          <label style={sectionLabelStyle}>
            Skill <span style={{ opacity: '0.5', 'text-transform': 'none' }}>(optional)</span>
          </label>
          <input
            class="input-field"
            type="text"
            list={skillListId}
            value={skill()}
            onInput={(e) => setSkill(e.currentTarget.value)}
            placeholder="e.g. gsd-quick — runs /gsd-quick (claude/opencode) or $gsd-quick (codex)"
            style={{
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              padding: '10px 14px',
              color: theme.fg,
              'font-size': '14px',
              'font-family': "'JetBrains Mono', monospace",
              outline: 'none',
            }}
          />
          <datalist id={skillListId}>
            <For each={skillSuggestions()}>{(s) => <option value={s} />}</For>
          </datalist>
        </div>

        <Show when={error()}>
          <div style={{ ...bannerStyle(theme.error), 'font-size': '13px' }}>{error()}</div>
        </Show>

        {/* Footer */}
        <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
          <button
            type="button"
            class="btn-secondary"
            onClick={() => props.onClose()}
            style={{
              padding: '9px 18px',
              background: theme.bgInput,
              border: `1px solid ${theme.border}`,
              'border-radius': '8px',
              color: theme.fgMuted,
              cursor: 'pointer',
              'font-size': '14px',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            class="btn-primary"
            disabled={!canSend()}
            title={`Broadcast (${sendLabel})`}
            style={{
              padding: '9px 20px',
              background: theme.accent,
              border: 'none',
              'border-radius': '8px',
              color: theme.accentText,
              cursor: 'pointer',
              'font-size': '14px',
              'font-weight': '500',
              opacity: !canSend() ? '0.4' : '1',
              display: 'inline-flex',
              'align-items': 'center',
              gap: '8px',
            }}
          >
            <Show when={sending()}>
              <span class="inline-spinner" aria-hidden="true" />
            </Show>
            {sending() ? 'Broadcasting...' : 'Broadcast'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
