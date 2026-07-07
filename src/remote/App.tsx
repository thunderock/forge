import { createSignal, onMount, Show, Switch, Match } from 'solid-js';
import { initAuth, getPairedToken } from './auth';
import { connect } from './ws';
import { AgentList } from './AgentList';
import { AgentDetail } from './AgentDetail';
import { ConnectScreen } from './ConnectScreen';
import { PairScreen } from './PairScreen';
import { NewTaskScreen } from './NewTaskScreen';

type View = 'list' | 'detail' | 'pair' | 'newtask';

export function App() {
  const [authed, setAuthed] = createSignal(false);
  // Separate view state from detail data so the agentId/taskName signals
  // never become empty while AgentDetail is still mounted (avoids reactive
  // race where Show disposes children *after* props re-evaluate to null).
  const [view, setView] = createSignal<View>('list');
  const [detailAgentId, setDetailAgentId] = createSignal('');
  const [detailTaskName, setDetailTaskName] = createSignal('');

  function selectAgent(id: string, name: string) {
    setDetailAgentId(id);
    setDetailTaskName(name);
    setView('detail');
  }

  // Creating a task needs the elevated paired token; pair first if we don't
  // have one yet.
  function startNewTask() {
    setView(getPairedToken() ? 'newtask' : 'pair');
  }

  function onConnected() {
    setAuthed(true);
    connect();
  }

  onMount(() => {
    const token = initAuth();
    if (token) onConnected();
  });

  return (
    <Show when={authed()} fallback={<ConnectScreen onConnected={onConnected} />}>
      <Switch fallback={<AgentList onSelect={selectAgent} onNewTask={startNewTask} />}>
        <Match when={view() === 'detail'}>
          <AgentDetail
            agentId={detailAgentId()}
            taskName={detailTaskName()}
            onBack={() => setView('list')}
          />
        </Match>
        <Match when={view() === 'pair'}>
          <PairScreen onPaired={() => setView('newtask')} onCancel={() => setView('list')} />
        </Match>
        <Match when={view() === 'newtask'}>
          <NewTaskScreen
            onCreated={() => setView('list')}
            onCancel={() => setView('list')}
            onNeedsPairing={() => setView('pair')}
          />
        </Match>
      </Switch>
    </Show>
  );
}
