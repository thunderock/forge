import { onMount, onCleanup, createSignal, Show } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { TERMINAL_SCROLLBACK_LINES, base64ToUint8Array } from '../lib/terminalConstants';
import { createTerminalHttpLinkHandler } from '../lib/terminalLinks';
import { subscribeAgent, unsubscribeAgent, onOutput, onScrollback, agents, status } from './ws';

interface AgentDetailProps {
  agentId: string;
  taskName: string;
  onBack: () => void;
}

const openRemoteHttpLink = createTerminalHttpLinkHandler({
  isMac: false,
  openExternal: (url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  },
});

export function AgentDetail(props: AgentDetailProps) {
  let termContainer: HTMLDivElement | undefined;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  const [atBottom, setAtBottom] = createSignal(true);
  const [termFontSize, setTermFontSize] = createSignal(10);

  const MIN_FONT = 6;
  const MAX_FONT = 24;

  const agentInfo = () => agents().find((a) => a.agentId === props.agentId);

  onMount(() => {
    if (!termContainer) return;

    // Disable xterm helper elements that capture touch events over
    // the header/toolbar areas (not needed since disableStdin is true)
    const style = document.createElement('style');
    style.textContent =
      '.xterm-helper-textarea, .xterm-composition-view { pointer-events: none !important; }';
    document.head.appendChild(style);
    onCleanup(() => style.remove());

    term = new Terminal({
      fontSize: 10,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
      theme: { background: '#0b0f14' },
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: false,
      disableStdin: true,
      convertEol: false,
      linkHandler: {
        activate: openRemoteHttpLink,
        allowNonHttpProtocols: false,
      },
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    fitAddon.fit();

    term.onScroll(() => {
      if (!term) return;
      const isBottom = term.buffer.active.viewportY >= term.buffer.active.baseY;
      setAtBottom(isBottom);
    });

    const cleanupScrollback = onScrollback(props.agentId, (data, cols) => {
      if (term && cols > 0) {
        term.resize(cols, term.rows);
      }
      // Clear before writing — on reconnect the server re-sends the full
      // scrollback buffer, so we must avoid duplicate content.
      term?.clear();
      const bytes = base64ToUint8Array(data);
      term?.write(bytes, () => term?.scrollToBottom());
    });

    const cleanupOutput = onOutput(props.agentId, (data) => {
      const bytes = base64ToUint8Array(data);
      term?.write(bytes);
    });

    subscribeAgent(props.agentId);

    let resizeRaf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => fitAddon?.fit());
    });
    observer.observe(termContainer);

    // Refit terminal when soft keyboard opens/closes on mobile
    if (window.visualViewport) {
      const onViewportResize = () => fitAddon?.fit();
      window.visualViewport.addEventListener('resize', onViewportResize);
      onCleanup(() => window.visualViewport?.removeEventListener('resize', onViewportResize));
    }

    // Manual touch scrolling for mobile — xterm.js doesn't handle this well
    let touchStartY = 0;
    let touchActive = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
        touchActive = true;
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!touchActive || !term || e.touches.length !== 1) return;
      const dy = touchStartY - e.touches[0].clientY;
      const lineHeight = term.options.fontSize ?? 13;
      const lines = Math.trunc(dy / lineHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        touchStartY = e.touches[0].clientY;
      }
      e.preventDefault();
    };
    const onTouchEnd = () => {
      touchActive = false;
    };
    termContainer.addEventListener('touchstart', onTouchStart, { passive: true });
    termContainer.addEventListener('touchmove', onTouchMove, { passive: false });
    termContainer.addEventListener('touchend', onTouchEnd, { passive: true });

    onCleanup(() => {
      termContainer.removeEventListener('touchstart', onTouchStart);
      termContainer.removeEventListener('touchmove', onTouchMove);
      termContainer.removeEventListener('touchend', onTouchEnd);
      observer.disconnect();
      unsubscribeAgent(props.agentId);
      cleanupScrollback();
      cleanupOutput();
      term?.dispose();
    });
  });

  function scrollToBottom() {
    term?.scrollToBottom();
  }

  return (
    <div
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        background: '#0b0f14',
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          'align-items': 'center',
          gap: '10px',
          padding: '10px 14px',
          'border-bottom': '1px solid #223040',
          'flex-shrink': '0',
          position: 'relative',
          'z-index': '10',
          background: '#12181f',
        }}
      >
        <button
          onClick={() => props.onBack()}
          style={{
            background: 'none',
            border: 'none',
            color: '#2ec8ff',
            'font-size': '17px',
            cursor: 'pointer',
            padding: '8px 10px',
            'touch-action': 'manipulation',
          }}
        >
          &#8592; Back
        </button>
        <span
          style={{
            'font-size': '15px',
            'font-weight': '500',
            color: '#d7e4f0',
            flex: '1',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'white-space': 'nowrap',
          }}
        >
          {props.taskName}
        </span>
        <div
          style={{
            width: '8px',
            height: '8px',
            'border-radius': '50%',
            background: agentInfo()?.status === 'running' ? '#2fd198' : '#678197',
          }}
        />
      </div>

      {/* Connection status banner */}
      <Show when={status() !== 'connected'}>
        <div
          style={{
            padding: '6px 16px',
            background: status() === 'connecting' ? '#78350f' : '#7f1d1d',
            color: status() === 'connecting' ? '#fde68a' : '#fca5a5',
            'font-size': '13px',
            'text-align': 'center',
            'flex-shrink': '0',
          }}
        >
          {status() === 'connecting' ? 'Reconnecting...' : 'Disconnected — check your network'}
        </div>
      </Show>

      {/* Terminal — overflow:hidden clips xterm.js overlays so they don't
           capture touch events over the header/toolbar areas */}
      <div
        ref={termContainer}
        style={{
          flex: '1',
          'min-height': '0',
          padding: '4px',
          position: 'relative',
          overflow: 'hidden',
        }}
      />

      {/* Scroll to bottom FAB */}
      <Show when={!atBottom()}>
        <button
          onClick={scrollToBottom}
          style={{
            position: 'absolute',
            bottom: '70px',
            right: '16px',
            width: '40px',
            height: '40px',
            'border-radius': '50%',
            background: '#12181f',
            border: '1px solid #223040',
            color: '#d7e4f0',
            'font-size': '17px',
            cursor: 'pointer',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            'z-index': '10',
            'touch-action': 'manipulation',
          }}
        >
          &#8595;
        </button>
      </Show>

      {/* Toolbar — font size controls only (mobile view is read-only) */}
      <div
        style={{
          'border-top': '1px solid #223040',
          padding: '8px 10px max(8px, env(safe-area-inset-bottom)) 10px',
          display: 'flex',
          'justify-content': 'flex-end',
          gap: '6px',
          'flex-shrink': '0',
          background: '#12181f',
          position: 'relative',
          'z-index': '10',
        }}
      >
        <button
          onClick={() => {
            const next = Math.max(MIN_FONT, termFontSize() - 1);
            setTermFontSize(next);
            if (term) {
              term.options.fontSize = next;
              fitAddon?.fit();
            }
          }}
          disabled={termFontSize() <= MIN_FONT}
          style={{
            background: '#1a2430',
            border: '1px solid #223040',
            'border-radius': '8px',
            padding: '10px 14px',
            color: termFontSize() <= MIN_FONT ? '#344050' : '#9bb0c3',
            'font-size': '14px',
            'font-weight': '700',
            'font-family': "'JetBrains Mono', 'Courier New', monospace",
            cursor: termFontSize() <= MIN_FONT ? 'default' : 'pointer',
            'touch-action': 'manipulation',
            transition: 'background 0.16s ease',
          }}
          title="Decrease font size"
        >
          A-
        </button>
        <button
          onClick={() => {
            const next = Math.min(MAX_FONT, termFontSize() + 1);
            setTermFontSize(next);
            if (term) {
              term.options.fontSize = next;
              fitAddon?.fit();
            }
          }}
          disabled={termFontSize() >= MAX_FONT}
          style={{
            background: '#1a2430',
            border: '1px solid #223040',
            'border-radius': '8px',
            padding: '10px 14px',
            color: termFontSize() >= MAX_FONT ? '#344050' : '#9bb0c3',
            'font-size': '14px',
            'font-weight': '700',
            'font-family': "'JetBrains Mono', 'Courier New', monospace",
            cursor: termFontSize() >= MAX_FONT ? 'default' : 'pointer',
            'touch-action': 'manipulation',
            transition: 'background 0.16s ease',
          }}
          title="Increase font size"
        >
          A+
        </button>
      </div>
    </div>
  );
}
