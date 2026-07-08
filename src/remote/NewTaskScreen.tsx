import { createSignal, onMount, For, Show } from 'solid-js';
import { fetchProjects, createTask, ApiError, type MobileProject } from './api';
import { clearPairedToken } from './auth';

interface NewTaskScreenProps {
  onCreated: () => void;
  onCancel: () => void;
  /** Called when the paired token is missing/stale — caller routes to pairing. */
  onNeedsPairing: () => void;
}

const inputStyle = {
  width: '100%',
  padding: '12px 14px',
  'font-size': '15px',
  background: '#10161d',
  border: '1px solid #223040',
  'border-radius': '8px',
  color: '#d7e4f0',
  outline: 'none',
} as const;

export function NewTaskScreen(props: NewTaskScreenProps) {
  const [projects, setProjects] = createSignal<MobileProject[]>([]);
  const [projectId, setProjectId] = createSignal('');
  const [name, setName] = createSignal('');
  const [prompt, setPrompt] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);

  // A stale paired token (desktop restarted) surfaces as 401 — drop it and send
  // the user back through pairing rather than showing a dead-end error.
  function handleAuthError(err: unknown): boolean {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      clearPairedToken();
      props.onNeedsPairing();
      return true;
    }
    return false;
  }

  onMount(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
      setProjectId(list[0]?.id ?? '');
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : 'Could not load projects');
    } finally {
      setLoading(false);
    }
  });

  const canSubmit = () => !!projectId() && !!name().trim() && !!prompt().trim() && !busy();

  async function handleSubmit(e: Event) {
    e.preventDefault();
    if (!canSubmit()) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({ projectId: projectId(), name: name().trim(), prompt: prompt().trim() });
      props.onCreated();
    } catch (err) {
      if (handleAuthError(err)) return;
      setError(err instanceof Error ? err.message : 'Could not create task');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
        color: '#678197',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          'justify-content': 'space-between',
          padding: '14px 16px',
          'border-bottom': '1px solid #223040',
          background: '#12181f',
          'flex-shrink': '0',
        }}
      >
        <button
          onClick={() => props.onCancel()}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#2ec8ff',
            'font-size': '15px',
            cursor: 'pointer',
            padding: '0',
          }}
        >
          Cancel
        </button>
        <span style={{ 'font-size': '16px', 'font-weight': '600', color: '#d7e4f0' }}>
          New Task
        </span>
        <span style={{ width: '48px' }} />
      </div>

      <Show
        when={!loading()}
        fallback={
          <div style={{ 'text-align': 'center', 'padding-top': '60px', color: '#678197' }}>
            Loading…
          </div>
        }
      >
        <form
          onSubmit={handleSubmit}
          style={{
            flex: '1',
            overflow: 'auto',
            padding: '16px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '16px',
            'padding-bottom': 'max(16px, env(safe-area-inset-bottom))',
          }}
        >
          <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={{ 'font-size': '13px', color: '#9bb0c3' }}>Project</span>
            <select
              value={projectId()}
              onChange={(e) => setProjectId(e.currentTarget.value)}
              style={{ ...inputStyle, appearance: 'none' }}
            >
              <Show when={projects().length === 0}>
                <option value="">No projects available</option>
              </Show>
              <For each={projects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
            </select>
          </label>

          <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px' }}>
            <span style={{ 'font-size': '13px', color: '#9bb0c3' }}>Task name</span>
            <input
              type="text"
              maxlength={200}
              placeholder="Short name for the task"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              style={inputStyle}
            />
          </label>

          <label style={{ display: 'flex', 'flex-direction': 'column', gap: '6px', flex: '1' }}>
            <span style={{ 'font-size': '13px', color: '#9bb0c3' }}>Prompt</span>
            <textarea
              placeholder="What should the agent work on?"
              value={prompt()}
              onInput={(e) => setPrompt(e.currentTarget.value)}
              maxlength={16000}
              rows={6}
              style={{
                ...inputStyle,
                resize: 'vertical',
                'min-height': '120px',
                'line-height': '1.5',
              }}
            />
          </label>

          <Show when={error()}>
            <p style={{ 'font-size': '13px', color: '#fca5a5', margin: '0' }}>{error()}</p>
          </Show>

          <button
            type="submit"
            disabled={!canSubmit()}
            style={{
              padding: '14px',
              'font-size': '16px',
              'font-weight': '600',
              background: canSubmit() ? '#2ec8ff' : '#1a2430',
              color: canSubmit() ? '#031018' : '#678197',
              border: 'none',
              'border-radius': '8px',
              cursor: canSubmit() ? 'pointer' : 'default',
            }}
          >
            {busy() ? 'Creating…' : 'Create task'}
          </button>
        </form>
      </Show>
    </div>
  );
}
