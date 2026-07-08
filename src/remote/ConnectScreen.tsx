import { createSignal, Show } from 'solid-js';
import { applyConnectionString } from './auth';

interface ConnectScreenProps {
  onConnected: () => void;
}

/**
 * Shown when the app has no valid connection (fresh install, or the token went
 * stale after a desktop restart). Lets the user re-establish the link by pasting
 * the connection URL from the desktop "Connect Phone" dialog.
 */
export function ConnectScreen(props: ConnectScreenProps) {
  const [input, setInput] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  function handleSubmit(e: Event) {
    e.preventDefault();
    const result = applyConnectionString(input());
    if (result === 'invalid') {
      setError('Paste the full connection URL from the desktop app (it contains a token).');
      return;
    }
    setError(null);
    // 'navigating' reloads the page at the new origin; 'stored' connects in place.
    if (result === 'stored') props.onConnected();
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        'align-items': 'center',
        'justify-content': 'center',
        height: '100%',
        padding: '24px',
        gap: '20px',
        'text-align': 'center',
        background: '#0b0f14',
        color: '#678197',
      }}
    >
      <div>
        <p style={{ 'font-size': '17px', color: '#d7e4f0', 'margin-bottom': '8px' }}>
          Not connected
        </p>
        <p style={{ 'font-size': '14px', color: '#678197', 'line-height': '1.5' }}>
          On your computer, open Forge → <strong>Connect Phone</strong>, then scan the QR code or
          paste the connection URL below.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          'flex-direction': 'column',
          gap: '10px',
          width: '100%',
          'max-width': '360px',
        }}
      >
        <input
          type="url"
          inputmode="url"
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          placeholder="http://…/?token=…"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          style={{
            width: '100%',
            padding: '12px 14px',
            'font-size': '15px',
            'font-family': 'monospace',
            background: '#10161d',
            border: '1px solid #223040',
            'border-radius': '8px',
            color: '#d7e4f0',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={!input().trim()}
          style={{
            padding: '12px 14px',
            'font-size': '15px',
            'font-weight': '600',
            background: input().trim() ? '#2ec8ff' : '#1a2430',
            color: input().trim() ? '#031018' : '#678197',
            border: 'none',
            'border-radius': '8px',
            cursor: input().trim() ? 'pointer' : 'default',
          }}
        >
          Connect
        </button>
        <Show when={error()}>
          <p style={{ 'font-size': '13px', color: '#fca5a5', margin: '0' }}>{error()}</p>
        </Show>
      </form>
    </div>
  );
}
