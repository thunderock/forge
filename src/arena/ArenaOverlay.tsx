import './arena-shared.css';
import './arena-config.css';
import './arena-countdown.css';
import './arena-battle.css';
import './arena-results.css';
import './arena-history.css';
import { Show, onMount } from 'solid-js';
import { arenaStore } from './store';
import { loadArenaPresets, loadArenaHistory } from './persistence';
import { ConfigScreen } from './ConfigScreen';
import { CountdownScreen } from './CountdownScreen';
import { BattleScreen } from './BattleScreen';
import { ResultsScreen } from './ResultsScreen';
import { HistoryScreen } from './HistoryScreen';

interface ArenaOverlayProps {
  onClose: () => void;
}

export function ArenaOverlay(props: ArenaOverlayProps) {
  onMount(() => {
    void loadArenaPresets();
    void loadArenaHistory();
  });

  function handleClose() {
    props.onClose();
  }

  return (
    <div class="arena-overlay">
      <div class="arena-header">
        <div class="arena-title">
          <svg
            width="20"
            height="20"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M3 3L13 13M9 12L12 9" />
            <path d="M13 3L3 13M4 9L7 12" />
          </svg>
          AI Arena
        </div>
        <button class="arena-close-btn" onClick={handleClose}>
          Close
        </button>
      </div>
      <div class="arena-body" classList={{ 'arena-body-battle': arenaStore.phase === 'battle' }}>
        <Show when={arenaStore.phase === 'config'}>
          <ConfigScreen />
        </Show>
        <Show when={arenaStore.phase === 'countdown'}>
          <CountdownScreen />
        </Show>
        <Show when={arenaStore.phase === 'battle'}>
          <BattleScreen />
        </Show>
        <Show when={arenaStore.phase === 'results'}>
          <ResultsScreen />
        </Show>
        <Show when={arenaStore.phase === 'history'}>
          <HistoryScreen />
        </Show>
      </div>
    </div>
  );
}
