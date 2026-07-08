import { setStore } from './core';
import { invoke } from '../lib/ipc';
import { IPC } from '../../electron/ipc/channels';

interface ServerResult {
  url: string;
  wifiUrl: string | null;
  tailscaleUrl: string | null;
  port: number;
  unavailableReason?: string;
}

// Generation counter — incremented on stop so in-flight poll responses
// that arrive after stop are discarded instead of overwriting the store.
let stopGeneration = 0;

/** Persisted toggle: whether to auto-start the remote server on app launch. */
export function setAutoStartRemoteAccess(enabled: boolean): void {
  setStore('autoStartRemoteAccess', enabled);
}

// Dedupe concurrent starts. With auto-start on launch, the persisted-state
// trigger can race the Connect Phone modal's open effect: both pass the
// backend's `if (remoteServer)` guard while it's still null, and the second
// listen() fails with EADDRINUSE. Sharing one in-flight promise prevents that.
let startInflight: Promise<ServerResult> | null = null;

export function startRemoteAccess(port?: number): Promise<ServerResult> {
  if (startInflight) return startInflight;
  startInflight = startRemoteAccessImpl(port).finally(() => {
    startInflight = null;
  });
  return startInflight;
}

async function startRemoteAccessImpl(port?: number): Promise<ServerResult> {
  const result = await invoke<ServerResult>(IPC.StartRemoteServer, port ? { port } : {});
  if (result.unavailableReason) {
    throw new Error(
      result.unavailableReason === 'coordinator_active'
        ? 'Remote access is unavailable while a coordinator is active. Stop the coordinator first.'
        : `Remote access unavailable: ${result.unavailableReason}`,
    );
  }
  setStore('remoteAccess', {
    enabled: true,
    port: result.port,
    url: result.url,
    wifiUrl: result.wifiUrl,
    tailscaleUrl: result.tailscaleUrl,
    connectedClients: 0,
  });
  return result;
}

export async function stopRemoteAccess(): Promise<{ stopped: boolean; reason?: string }> {
  stopGeneration++;
  const result = await invoke<{ stopped: boolean; reason?: string }>(IPC.StopRemoteServer);
  if (result.stopped) {
    setStore('remoteAccess', {
      enabled: false,
      port: 7777,
      url: null,
      wifiUrl: null,
      tailscaleUrl: null,
      connectedClients: 0,
    });
  }
  return result;
}

/**
 * Mint a short-lived pairing PIN shown on the desktop. A phone enters it to
 * elevate its read-only connection to one that can create tasks.
 */
export function generatePairingPin(): Promise<{ pin: string; expiresAt: number }> {
  return invoke<{ pin: string; expiresAt: number }>(IPC.GeneratePairingPin);
}

export async function refreshRemoteStatus(): Promise<void> {
  const gen = stopGeneration;
  const result = await invoke<{
    enabled: boolean;
    connectedClients: number;
    url?: string;
    wifiUrl?: string;
    tailscaleUrl?: string;
    port?: number;
  }>(IPC.GetRemoteStatus);

  // Discard stale response if stopRemoteAccess was called while in-flight
  if (gen !== stopGeneration) return;

  if (result.enabled) {
    setStore('remoteAccess', {
      enabled: true,
      connectedClients: result.connectedClients,
      url: result.url ?? null,
      wifiUrl: result.wifiUrl ?? null,
      tailscaleUrl: result.tailscaleUrl ?? null,
      port: result.port ?? 7777,
    });
  } else {
    setStore('remoteAccess', 'enabled', false);
    setStore('remoteAccess', 'connectedClients', 0);
  }
}
