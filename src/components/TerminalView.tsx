import { onMount, onCleanup, createEffect, Show } from 'solid-js';
import { Terminal, type IMarker } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke, fireAndForget, Channel } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';
import { getTerminalFontFamily } from '../lib/fonts';
import { TERMINAL_SCROLLBACK_LINES } from '../lib/terminalConstants';
import { getTerminalTheme, getTerminalThemeForCustom } from '../lib/theme';
import { matchesGlobalShortcut } from '../lib/shortcuts';
import { isMac } from '../lib/platform';
import { resolvedBindings } from '../store/keybindings';
import { matchesKeyEvent } from '../lib/keybindings';
import {
  store,
  setTaskLastInputAt,
  retryTaskMcpStartup,
  markTaskUserActivity,
  setTaskTerminalInputPending,
} from '../store/store';
import { isLandedTaskState } from '../store/landing';
import { warn as logWarn } from '../lib/log';
import { registerTerminal, unregisterTerminal, markDirty } from '../lib/terminalFitManager';
import { dataTransferToShellArgs, escapePath } from '../lib/terminalDrop';
import { cleanCopiedTerminalText } from '../lib/copy-text';
import { hasTerminalUserActivity, nextTerminalInputPending } from '../lib/terminalInputPending';
import type { PtyOutput } from '../ipc/types';

let windowUnloading = false;
if (typeof window !== 'undefined') {
  const markWindowUnloading = () => {
    windowUnloading = true;
  };
  window.addEventListener('beforeunload', markWindowUnloading);
  window.addEventListener('pagehide', markWindowUnloading);
}

type ClipboardPaste =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

// Pre-computed base64 lookup table — avoids atob() intermediate string allocation.
const B64_LOOKUP = new Uint8Array(128);
for (let i = 0; i < 64; i++) {
  B64_LOOKUP['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;
}

function base64ToUint8Array(b64: string): Uint8Array {
  let end = b64.length;
  while (end > 0 && b64.charCodeAt(end - 1) === 61 /* '=' */) end--;
  const out = new Uint8Array((end * 3) >>> 2);
  let j = 0;
  for (let i = 0; i < end; ) {
    const a = B64_LOOKUP[b64.charCodeAt(i++)];
    const b = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const c = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const d = i < end ? B64_LOOKUP[b64.charCodeAt(i++)] : 0;
    const triplet = (a << 18) | (b << 12) | (c << 6) | d;
    out[j++] = (triplet >>> 16) & 0xff;
    if (j < out.length) out[j++] = (triplet >>> 8) & 0xff;
    if (j < out.length) out[j++] = triplet & 0xff;
  }
  return out;
}

interface TerminalViewProps {
  taskId: string;
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  isShell?: boolean;
  stepsEnabled?: boolean;
  dockerMode?: boolean;
  dockerImage?: string;
  spawnDelayMs?: number;
  attachExisting?: boolean;
  preserveSessionOnCleanup?: boolean;
  dockerMountWorktreeParent?: boolean;
  onExit?: (exitInfo: {
    exit_code: number | null;
    signal: string | null;
    last_output: string[];
  }) => void;
  onData?: (data: Uint8Array) => void;
  onPromptDetected?: (text: string) => void;
  onFileLink?: (filePath: string) => void;
  onReady?: (focusFn: () => void) => void;
  onBufferReady?: (getBuffer: () => string) => void;
  /** Exposes step-bookmark API: `mark(i)` registers a marker at the current line for
   *  step index `i`; `jump(i)` scrolls the viewport so that marker is visible.
   *  Called with `undefined` on unmount so the consumer can reset its state — important
   *  on agent restart, where this component remounts but the parent does not. */
  onStepNavReady?: (
    api: { mark: (i: number) => void; jump: (i: number) => boolean } | undefined,
  ) => void;
  fontSize?: number;
  autoFocus?: boolean;
  initialCommand?: string;
  isFocused?: boolean;
}

// Status parsing only needs recent output. Capping forwarded bytes avoids
// expensive full-chunk decoding during large terminal bursts.
const STATUS_ANALYSIS_MAX_BYTES = 8 * 1024;

/** Terminal-layer bindings — filtered from resolved bindings.
 *  Called in the key handler (hot path); resolveBindings walks the full
 *  defaults list on each call, which is fine at human typing speed. */
function getTerminalBindings() {
  return resolvedBindings().filter((b) => b.layer === 'terminal');
}

export function TerminalView(props: TerminalViewProps) {
  let containerRef!: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let webglAddon: WebglAddon | undefined;

  function activeTerminalTheme() {
    const id = store.activeCustomThemeId;
    const custom = id ? store.customThemes[id] : undefined;
    return custom
      ? getTerminalThemeForCustom(custom.terminalBackground)
      : getTerminalTheme(store.themePreset);
  }

  onMount(() => {
    // Capture props eagerly so cleanup/callbacks always use the original values
    const taskId = props.taskId;
    const agentId = props.agentId;
    const initialFontSize = props.fontSize ?? 13;
    const attachExisting = props.attachExisting ?? true;
    const preserveSessionOnCleanup = props.preserveSessionOnCleanup === true;
    let ptyDetachedByLanding = false;

    function taskPtyDetached(): boolean {
      return ptyDetachedByLanding || isLandedTaskState(store.tasks[taskId]?.landingState);
    }

    function canForwardInput(): boolean {
      return !taskPtyDetached();
    }

    term = new Terminal({
      cursorBlink: true,
      fontSize: initialFontSize,
      fontFamily: getTerminalFontFamily(store.terminalFont),
      theme: activeTerminalTheme(),
      allowProposedApi: true,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      disableStdin: taskPtyDetached(),
    });

    fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        // Require Cmd+click (Mac) or Ctrl+click (Linux) to open links
        if (!(isMac ? event.metaKey : event.ctrlKey)) return;
        try {
          const parsed = new URL(uri);
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            window.open(uri, '_blank');
          }
        } catch {
          // Invalid URL, ignore
        }
      }),
    );

    term.open(containerRef);

    // Block direct PTY keyboard input only after self-landing has removed the
    // backend PTY. Coordinator automation now waits for user activity instead of
    // disabling the user's terminal.
    createEffect(() => {
      const task = store.tasks[taskId];
      if (isLandedTaskState(task?.landingState)) ptyDetachedByLanding = true;
      if (term) term.options.disableStdin = taskPtyDetached();
    });

    // File path link provider — makes file paths clickable in terminal output
    // Must be registered after term.open() so the DOM is available.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        if (!term) {
          callback(undefined);
          return;
        }
        const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? '';
        // Match file paths: absolute, ./ or ../ relative, and bare relative with /
        // Supports @scoped packages, line:col suffixes like foo.ts:42:10
        const regex =
          /(?:\/[\w@./-]+|\.{1,2}\/[\w@./-]+|[\w@][\w@./-]*\/[\w@./-]+)(?::\d+(?::\d+)?)?/g;
        const links: { startIndex: number; length: number; text: string }[] = [];
        let match: RegExpExecArray | null;
        while ((match = regex.exec(line)) !== null) {
          // Strip trailing punctuation that's not part of the path
          const text = match[0].replace(/[.,;:!?)]+$/, '');
          if (!text) continue;
          // Must contain a dot somewhere (file extension) to avoid matching plain directories
          if (!text.includes('.')) continue;
          links.push({
            startIndex: match.index,
            length: text.length,
            text,
          });
        }
        callback(
          links.map((link) => ({
            range: {
              start: { x: link.startIndex + 1, y },
              end: { x: link.startIndex + link.length + 1, y },
            },
            text: link.text,
            activate(event: MouseEvent, _text: string) {
              // Require Cmd+click (Mac) or Ctrl+click (Linux) to open links
              const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
              if (!modifierHeld) return;
              // Strip line:col suffix for opening
              const filePath = link.text.replace(/:\d+(:\d+)?$/, '');
              // Resolve relative paths against the task's working directory
              const resolved = filePath.startsWith('/') ? filePath : `${props.cwd}/${filePath}`;
              // .md files open in viewer; Shift held = open externally instead
              if (/\.md$/i.test(resolved) && props.onFileLink && !event.shiftKey) {
                props.onFileLink(resolved);
              } else {
                invoke(IPC.OpenPath, { filePath: resolved }).catch(console.error);
              }
            },
          })),
        );
      },
    });

    props.onReady?.(() => term?.focus());

    // Step bookmarks — anchor each agent step to the current scrollback line so the
    // user can jump from the steps panel back to the terminal moment a step was written.
    // Markers auto-track buffer truncation; once the marker scrolls past the scrollback
    // limit xterm disposes it, in which case `jump` returns false so the caller can no-op.
    // The map is owned by xterm and freed implicitly when term.dispose() runs in onCleanup.
    const stepMarkers = new Map<number, IMarker>();
    const stepNavApi = {
      mark(i: number) {
        if (!term || stepMarkers.has(i)) return;
        const m = term.registerMarker(0);
        if (m) stepMarkers.set(i, m);
      },
      jump(i: number): boolean {
        if (!term) return false;
        const m = stepMarkers.get(i);
        if (!m || m.isDisposed) return false;
        term.scrollToLine(m.line);
        return true;
      },
    };
    props.onStepNavReady?.(stepNavApi);
    onCleanup(() => props.onStepNavReady?.(undefined));

    props.onBufferReady?.(() => {
      if (!term) return '';
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i <= buf.length - 1; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      // Trim trailing empty lines
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      return lines.join('\n');
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') {
        // Suppress Shift+Enter keyup so xterm doesn't echo a bare Enter
        if (e.key === 'Enter' && e.shiftKey) return false;
        return true;
      }

      // Let global app shortcuts pass through to the window handler
      if (matchesGlobalShortcut(e)) return false;

      // Look up terminal bindings from registry
      for (const binding of getTerminalBindings()) {
        if (!matchesKeyEvent(e, binding)) continue;

        e.preventDefault();

        // Special actions that need custom handling
        if (binding.action === 'copy') {
          // Belt to the DOM `copy` listener's braces: covers paths where the
          // browser's `copy` event never fires (e.g. Linux Ctrl+Shift+C goes
          // through here, the macOS Edit→Copy menu role goes through the
          // listener). Both produce identical cleaned output, so a redundant
          // double-write is harmless.
          const sel = term?.getSelection();
          if (sel) navigator.clipboard.writeText(cleanCopiedTerminalText(sel));
          return false;
        }

        if (binding.action === 'paste') {
          (async () => {
            // Single round-trip resolver — main process picks the most useful
            // representation: a file path (Finder copy), then a saved image
            // (screenshot), then plain text. Pasting an image-file copy as
            // its bare basename was the bug we're avoiding here.
            //
            // We funnel the result through term.paste() rather than writing
            // to the PTY directly so xterm wraps the payload in bracketed
            // paste markers (\x1b[200~ … \x1b[201~) when the agent has
            // bracketed-paste mode on. CLI agents like Claude Code use that
            // wrapper to recognise "the user pasted a file path", which is
            // what triggers automatic image attachment instead of treating
            // the path as literal typed text.
            const paste = await invoke<ClipboardPaste>(IPC.ResolveClipboardPaste);
            if (paste.kind === 'file' || paste.kind === 'image') {
              term?.paste(escapePath(paste.path));
              return;
            }
            if (paste.kind === 'text') term?.paste(paste.text);
          })().catch((err: unknown) => {
            logWarn('terminal.paste', 'paste handler failed', { err });
          });
          return false;
        }

        if (binding.action?.startsWith('scrollback:')) {
          switch (binding.action) {
            case 'scrollback:line-up':
              term?.scrollLines(-1);
              break;
            case 'scrollback:line-down':
              term?.scrollLines(1);
              break;
            case 'scrollback:page-up':
              term?.scrollPages(-1);
              break;
            case 'scrollback:page-down':
              term?.scrollPages(1);
              break;
          }
          return false;
        }

        // Generic escape sequence bindings
        if (binding.escapeSequence) {
          enqueueInput(binding.escapeSequence);
          return false;
        }
      }

      return true;
    });

    // Drag-and-drop support — when the user drops a file on the terminal,
    // type the absolute path(s) into the agent so it can read the file. By
    // default xterm/Browsers would only insert the basename (text/plain),
    // which a CLI agent like Claude Code can't open.
    function handleDragOver(e: DragEvent) {
      if (!e.dataTransfer || e.dataTransfer.types.indexOf('Files') === -1) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    }
    function handleDrop(e: DragEvent) {
      if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      void (async () => {
        try {
          const args = await dataTransferToShellArgs(dt);
          if (args) {
            term?.focus();
            // Use term.paste() so xterm emits bracketed-paste markers for
            // agents that have bracketed-paste mode on (Claude Code,
            // Codex). Without the markers the agent sees the path as
            // literal typing and skips the file-attachment recognition.
            term?.paste(args);
          }
        } catch (err) {
          logWarn('terminal.drop', 'drop handler failed', { err });
        }
      })();
    }
    // Use capture so we run before xterm's own listeners (which would otherwise
    // insert just the basename via the dragged item's text/plain payload).
    containerRef.addEventListener('dragover', handleDragOver, true);
    containerRef.addEventListener('drop', handleDrop, true);

    // Clean the selection before it reaches the clipboard: strip per-line
    // padding (TUIs commonly fill rendered lines out to column width), then
    // reflow wrapped paragraphs whose interior lines are uniformly long.
    // Catches both the keybinding path and the Electron Edit→Copy menu role
    // (which fires a synthetic `copy` event and bypasses our
    // attachCustomKeyEventHandler hook). Capture phase runs ahead of any
    // xterm-internal listener.
    function handleCopy(event: ClipboardEvent) {
      const sel = term?.getSelection();
      if (!sel || !event.clipboardData) return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', cleanCopiedTerminalText(sel));
    }
    containerRef.addEventListener('copy', handleCopy, true);

    onCleanup(() => {
      containerRef.removeEventListener('dragover', handleDragOver, true);
      containerRef.removeEventListener('drop', handleDrop, true);
      containerRef.removeEventListener('copy', handleCopy, true);
    });

    fitAddon.fit();
    registerTerminal(agentId, containerRef, fitAddon, term);

    if (props.autoFocus) {
      term.focus();
    }

    let outputRaf: number | undefined;
    let outputQueue: Uint8Array[] = [];
    let outputQueuedBytes = 0;
    let outputWriteInFlight = false;
    let watermark = 0;
    let ptyPaused = false;
    const FLOW_HIGH = 256 * 1024; // 256KB — pause PTY reader
    const FLOW_LOW = 32 * 1024; // 32KB — resume PTY reader
    let pendingExitPayload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    } | null = null;

    function emitExit(payload: {
      exit_code: number | null;
      signal: string | null;
      last_output: string[];
    }) {
      if (!term) return;
      term.write('\r\n\x1b[90m[Process exited]\x1b[0m\r\n');
      props.onExit?.(payload);
    }

    function flushOutputQueue() {
      if (!term || outputWriteInFlight || outputQueue.length === 0) return;

      const chunks = outputQueue;
      const totalBytes = outputQueuedBytes;
      outputQueue = [];
      outputQueuedBytes = 0;

      let payload: Uint8Array;
      if (chunks.length === 1) {
        payload = chunks[0];
      } else {
        payload = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.length;
        }
      }

      const statusPayload =
        payload.length > STATUS_ANALYSIS_MAX_BYTES
          ? payload.subarray(payload.length - STATUS_ANALYSIS_MAX_BYTES)
          : payload;

      outputWriteInFlight = true;
      // eslint-disable-next-line solid/reactivity -- write callback is not a reactive context
      term.write(payload, () => {
        outputWriteInFlight = false;
        watermark = Math.max(watermark - payload.length, 0);

        // Resume PTY reader when xterm.js has caught up
        if (watermark < FLOW_LOW && ptyPaused) {
          ptyPaused = false;
          if (taskPtyDetached()) return;
          invoke(IPC.ResumeAgent, { agentId }).catch((err: unknown) => {
            logWarn('terminal.flow', 'ResumeAgent failed', { err });
            ptyPaused = false;
          });
        }

        props.onData?.(statusPayload);
        if (outputQueue.length > 0) {
          scheduleOutputFlush();
          return;
        }
        if (pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      });
    }

    function scheduleOutputFlush() {
      if (outputRaf !== undefined) return;
      outputRaf = requestAnimationFrame(() => {
        outputRaf = undefined;
        flushOutputQueue();
      });
    }

    function enqueueOutput(chunk: Uint8Array) {
      outputQueue.push(chunk);
      outputQueuedBytes += chunk.length;
      watermark += chunk.length;

      // Pause PTY reader when xterm.js falls behind
      if (watermark > FLOW_HIGH && !ptyPaused && !taskPtyDetached()) {
        ptyPaused = true;
        invoke(IPC.PauseAgent, { agentId }).catch((err: unknown) => {
          logWarn('terminal.flow', 'PauseAgent failed', { err });
          ptyPaused = false;
        });
      }

      // Flush large bursts promptly to keep perceived latency low.
      if (outputQueuedBytes >= 64 * 1024) {
        flushOutputQueue();
      } else {
        scheduleOutputFlush();
      }
    }

    const onOutput = new Channel<PtyOutput>();
    let initialCommandSent = false;
    onOutput.onmessage = (msg) => {
      if (msg.type === 'Data') {
        enqueueOutput(base64ToUint8Array(msg.data));
        if (!initialCommandSent && props.initialCommand) {
          const cmd = props.initialCommand;
          initialCommandSent = true;
          setTimeout(() => enqueueInput(cmd + '\r'), 50);
        }
      } else if (msg.type === 'Exit') {
        pendingExitPayload = msg.data;
        flushOutputQueue();
        if (!outputWriteInFlight && outputQueue.length === 0 && pendingExitPayload) {
          const exit = pendingExitPayload;
          pendingExitPayload = null;
          emitExit(exit);
        }
      }
    };

    let inputBuffer = '';
    let pendingInput = '';
    let inputFlushTimer: number | undefined;

    function flushPendingInput() {
      if (!pendingInput) return;
      const data = pendingInput;
      pendingInput = '';
      if (inputFlushTimer !== undefined) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = undefined;
      }
      if (!canForwardInput()) return;
      fireAndForget(IPC.WriteToAgent, { agentId, data });
      if (!props.isShell && (data.includes('\r') || data.includes('\n'))) {
        setTaskLastInputAt(props.taskId);
      }
    }

    function enqueueInput(data: string) {
      if (!canForwardInput()) return;
      pendingInput += data;
      if (pendingInput.length >= 2048) {
        flushPendingInput();
        return;
      }
      if (inputFlushTimer !== undefined) return;
      // eslint-disable-next-line solid/reactivity
      inputFlushTimer = window.setTimeout(() => {
        inputFlushTimer = undefined;
        flushPendingInput();
      }, 8);
    }

    function noteUserTerminalInput(data: string) {
      if (props.isShell || !store.tasks[props.taskId]) return;
      const hadActivity = hasTerminalUserActivity(data);
      if (hadActivity) markTaskUserActivity(props.taskId);
      const pending = nextTerminalInputPending(
        store.tasks[props.taskId]?.terminalInputPending === true,
        data,
      );
      setTaskTerminalInputPending(props.taskId, pending);
    }

    // eslint-disable-next-line solid/reactivity -- event handler reads current prop values intentionally
    term.onData((data) => {
      if (!canForwardInput()) return;
      noteUserTerminalInput(data);
      if (props.onPromptDetected) {
        for (const ch of data) {
          if (ch === '\r') {
            const trimmed = inputBuffer.trim();
            if (trimmed) props.onPromptDetected?.(trimmed);
            inputBuffer = '';
          } else if (ch === '\x7f') {
            inputBuffer = inputBuffer.slice(0, -1);
          } else if (ch === '\x03' || ch === '\x15') {
            inputBuffer = '';
          } else if (ch === '\x1b') {
            // Skip escape sequences — break out, rest of data may contain seq chars
            break;
          } else if (ch >= ' ') {
            inputBuffer += ch;
          }
        }
      }
      enqueueInput(data);
    });

    let resizeFlushTimer: number | undefined;
    let pendingResize: { cols: number; rows: number } | null = null;
    let lastSentCols = -1;
    let lastSentRows = -1;

    function flushPendingResize() {
      if (!pendingResize) return;
      const { cols, rows } = pendingResize;
      pendingResize = null;
      if (taskPtyDetached()) return;
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      fireAndForget(IPC.ResizeAgent, { agentId, cols, rows });
    }

    term.onResize(({ cols, rows }) => {
      pendingResize = { cols, rows };
      if (resizeFlushTimer !== undefined) return;
      resizeFlushTimer = window.setTimeout(() => {
        resizeFlushTimer = undefined;
        flushPendingResize();
      }, 33);
    });

    // Only disable cursor blink for non-focused terminals to save one RAF
    // loop per terminal.
    createEffect(() => {
      if (!term) return;
      term.options.cursorBlink = props.isFocused === true;
    });

    // Load WebGL addon for all terminals. On context loss (e.g. too many
    // WebGL contexts), the terminal gracefully falls back to the DOM renderer.
    try {
      webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon?.dispose();
        webglAddon = undefined;
      });
      term.loadAddon(webglAddon);
    } catch {
      // WebGL2 not supported — DOM renderer used automatically
    }

    let spawnTimer: number | undefined;
    let spawnStarted = false;

    function startSpawn() {
      if (!term || spawnStarted) return;
      const landingState = store.tasks[taskId]?.landingState;
      if (isLandedTaskState(landingState)) return;
      spawnStarted = true;
      invoke(IPC.SpawnAgent, {
        taskId,
        agentId,
        command: props.command,
        args: props.args,
        cwd: props.cwd,
        env: props.env ?? {},
        cols: term.cols,
        rows: term.rows,
        isShell: props.isShell,
        stepsEnabled: props.stepsEnabled,
        dockerMode: props.dockerMode,
        dockerImage: props.dockerImage,
        dockerMountWorktreeParent: props.dockerMountWorktreeParent,
        shareDockerAgentAuth: store.shareDockerAgentAuth,
        attachExisting,
        onOutput,
      })
        // eslint-disable-next-line solid/reactivity -- promise callbacks are not reactive contexts
        .then(() => {
          flushPendingResize();
          flushPendingInput();
        })
        // eslint-disable-next-line solid/reactivity -- promise catch handler reads current prop values intentionally
        .catch((err) => {
          // eslint-disable-next-line no-control-regex -- intentionally stripping control/escape chars to prevent terminal injection
          const safeErr = String(err).replace(/[\x00-\x1f\x7f]/g, '');
          term?.write(`\x1b[31mFailed to spawn: ${safeErr}\x1b[0m\r\n`);
          props.onExit?.({
            exit_code: null,
            signal: 'spawn_failed',
            last_output: [`Failed to spawn: ${safeErr}`],
          });
        });
    }

    // For coordinator and coordinated sub-tasks, defer spawn until MCP is ready.
    // Coordinator tasks wait for StartMCPServer to complete; sub-tasks wait for hydrateTask.
    // Always install the watcher when MCP lifecycle is present so that Retry (error → ready)
    // works even when the component mounts in 'error' state.
    const spawnDelayMsVal = props.spawnDelayMs ?? 0;
    const task = store.tasks[taskId];
    if (task?.mcpStartupStatus !== undefined) {
      let spawned = false;
      createEffect(() => {
        if (spawned) return;
        const status = store.tasks[taskId]?.mcpStartupStatus;
        if (status === 'ready') {
          spawned = true;
          if (spawnDelayMsVal > 0) {
            spawnTimer = window.setTimeout(startSpawn, spawnDelayMsVal);
          } else {
            startSpawn();
          }
        }
        // 'error' is handled by the overlay rendered outside onMount
      });
    } else if (spawnDelayMsVal > 0) {
      spawnTimer = window.setTimeout(startSpawn, spawnDelayMsVal);
    } else {
      startSpawn();
    }

    onCleanup(() => {
      const preserveSession = preserveSessionOnCleanup;
      if (!windowUnloading || preserveSession) {
        flushPendingInput();
        flushPendingResize();
      }
      if (spawnTimer !== undefined) clearTimeout(spawnTimer);
      if (inputFlushTimer !== undefined) clearTimeout(inputFlushTimer);
      if (resizeFlushTimer !== undefined) clearTimeout(resizeFlushTimer);
      if (outputRaf !== undefined) cancelAnimationFrame(outputRaf);
      onOutput.cleanup?.();
      webglAddon?.dispose();
      webglAddon = undefined;
      unregisterTerminal(agentId);
      if (ptyPaused && !taskPtyDetached()) {
        fireAndForget(IPC.ResumeAgent, { agentId });
        ptyPaused = false;
      }
      if (!preserveSession && spawnStarted && !taskPtyDetached()) {
        fireAndForget(IPC.KillAgent, { agentId });
      }
      term?.dispose();
    });
  });

  createEffect(() => {
    const size = props.fontSize;
    if (size === undefined || !term || !fitAddon) return;
    term.options.fontSize = size;
    markDirty(props.agentId);
  });

  createEffect(() => {
    const font = store.terminalFont;
    if (!term || !fitAddon) return;
    term.options.fontFamily = getTerminalFontFamily(font);
    markDirty(props.agentId);
  });

  createEffect(() => {
    if (!term) return;
    term.options.theme = activeTerminalTheme();
    markDirty(props.agentId);
  });

  const mcpError = () => store.tasks[props.taskId]?.mcpStartupError;
  const mcpStatus = () => store.tasks[props.taskId]?.mcpStartupStatus;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          padding: '4px 0 0 4px',
          contain: 'strict',
        }}
      />
      <Show when={mcpStatus() === 'error'}>
        <div
          style={{
            position: 'absolute',
            inset: '0',
            display: 'flex',
            'flex-direction': 'column',
            'align-items': 'center',
            'justify-content': 'center',
            gap: '12px',
            background: 'rgba(0,0,0,0.85)',
            'font-family': 'var(--font-ui)',
            'z-index': '10',
          }}
        >
          <span
            style={{
              color: '#ff6b6b',
              'font-size': '13px',
              'text-align': 'center',
              padding: '0 16px',
            }}
          >
            MCP startup failed: {mcpError() ?? 'unknown error'}
          </span>
          <button
            style={{
              padding: '6px 16px',
              background: '#3b82f6',
              color: '#fff',
              border: 'none',
              'border-radius': '4px',
              'font-size': '13px',
              cursor: 'pointer',
            }}
            onClick={() => retryTaskMcpStartup(props.taskId)}
          >
            Retry
          </button>
        </div>
      </Show>
    </div>
  );
}
