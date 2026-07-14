// Broadcast prompt fan-out — renderer-only engine spine.
//
// Target enumeration (this file) resolves, live on every call, the set of
// running AI agents that a broadcast should reach. Scope is app-wide (all
// projects). Excluded: the top-level coordinator agent, coordinator-controlled
// children, shells (structurally — they live in shellAgentIds), and
// landed/exited agents. Delivery (sendPrompt) and lifecycle teardown land in
// 07-02; this file mocks the write side behind a seam so the queue logic is
// provable with no real pty.
//
// Mirrors the proven FIFO shape of electron/mcp/coordinator.ts as a REFERENCE
// MODEL only — nothing is lifted or modified there. Renderer browser context
// (contextIsolation:true, nodeIntegration:false): no Buffer, and browser timers
// are `number`s with no `.unref()`.

import type { AgentDef } from '../ipc/types';
import {
  getAgentPromptReadiness,
  stripAnsi,
  type AgentPromptReadiness,
} from '../../electron/mcp/prompt-detect';
import { store } from './core';
import { isLandedTaskState } from './landing';
import {
  getAgentOutputTail,
  isAgentAskingQuestion,
  isAgentIdle,
  subscribeAgentReadiness,
} from './taskStatus';
import { decideBroadcastDelivery } from './broadcast-decision';

export interface BroadcastTarget {
  taskId: string;
  agentId: string;
  def: AgentDef;
}

/**
 * All running AI agents a broadcast should reach, recomputed live (never cached).
 * Iterates store.taskOrder across ALL projects; excludes the coordinator agent
 * itself, coordinator-controlled children, shells (shellAgentIds are never
 * enumerated), and landed/exited agents.
 */
export function enumerateBroadcastTargets(): BroadcastTarget[] {
  const targets: BroadcastTarget[] = [];
  for (const taskId of store.taskOrder) {
    const task = store.tasks[taskId];
    if (!task) continue;
    if (task.coordinatorMode === true) continue; // the top-level coordinator agent itself
    if (task.controlledBy === 'coordinator' || task.coordinatedBy) continue; // coordinator-controlled children
    if (isLandedTaskState(task.landingState)) continue; // sendPrompt throws on landed
    for (const agentId of task.agentIds) {
      // AI agents only — task.shellAgentIds are excluded structurally.
      const agent = store.agents[agentId];
      if (agent?.status === 'running') {
        targets.push({ taskId: task.id, agentId, def: agent.def });
      }
    }
  }
  return targets;
}

/** Live target count for the broadcast dialog header — recomputed, never cached. */
export function getBroadcastTargetCount(): number {
  return enumerateBroadcastTargets().length;
}

// ── Idle-gated per-agent FIFO queue ─────────────────────────────────────────
// Constants mirror the coordinator's VALUES only (electron/mcp/coordinator.ts) —
// this is the renderer (browser context), so there is NO Buffer (byte length via
// TextEncoder) and browser timers are `number`s with no `.unref()`.
const PROMPT_STABILITY_MS = 50; // = coordinator PROMPT_WRITE_DELAY_MS
const MAX_PENDING_PER_AGENT = 8;
const MAX_PROMPT_BYTES = 64 * 1024;
const NEVER_IDLE_TIMEOUT_MS = 120_000;
// Documented flippable policy: a human broadcast into a truly-busy interactive
// TUI risks landing mid-dialog, so failing safe (drop + notify) is correct for a
// manual action. 07-02 wires the backstop interval that enforces this.
const BROADCAST_NEVER_IDLE_POLICY: 'drop' | 'force-write' = 'drop';

// Per-agent append-only FIFO + synchronous write lock + stability/age anchors.
const queue = new Map<string, string[]>();
const writing = new Set<string>();
const promptReadySeenAt = new Map<string, number>();
const enqueuedAt = new Map<string, number>();
const stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Delivery seam. 07-02 replaces the default with a real sendPrompt write-through;
// here it is a no-op so the queue/decision logic is provable with no real pty.
type DeliverFn = (agentId: string, text: string) => Promise<void>;
const defaultDeliver: DeliverFn = () => Promise.resolve();
let deliver: DeliverFn = defaultDeliver;

// One-time, lazy subscription to the NON-EXCLUSIVE readiness notifier. Mirrors
// the coordinator's buildAgentOutputCb -> flushNextQueuedPrompt wiring without
// touching the single-slot ready callback owned by PromptInput.
let unsubscribe: (() => void) | undefined;
function ensureSubscribed(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeAgentReadiness((agentId) => tryFlush(agentId));
}

/** Strip ANSI + control chars → space, preserving line breaks for anchored
 *  prompt detection. Mirrors coordinator.ts::normalizedTail. */
function normalizeTail(tail: string): string {
  return (
    stripAnsi(tail)
      // eslint-disable-next-line no-control-regex -- preserve line breaks for anchored prompt detection.
      .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f\x7f]/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
  );
}

/** Live hardened readiness of the agent's settled output tail. */
function readiness(agentId: string): AgentPromptReadiness {
  return getAgentPromptReadiness(normalizeTail(getAgentOutputTail(agentId)));
}

/** Track when the prompt first read ready (flush-phase stability anchor).
 *  Set on first ready, cleared when not ready — mirrors coordinator.markAgentPromptReady. */
function markStable(agentId: string, ready: boolean, now: number): void {
  if (!ready) {
    promptReadySeenAt.delete(agentId);
    return;
  }
  if (!promptReadySeenAt.has(agentId)) promptReadySeenAt.set(agentId, now);
}

function clearAgentQueue(agentId: string): void {
  queue.delete(agentId);
  enqueuedAt.delete(agentId);
  promptReadySeenAt.delete(agentId);
  const timer = stabilityTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    stabilityTimers.delete(agentId);
  }
}

/** A single stability recheck per agent (mirrors the SHAPE of
 *  coordinator.scheduleQueuedPromptFlush — one timer per agent, cleared on fire —
 *  WITHOUT `.unref()`: renderer browser timers are `number`s with no such method). */
function scheduleStabilityRecheck(agentId: string): void {
  if (stabilityTimers.has(agentId)) return;
  const timer = setTimeout(() => {
    stabilityTimers.delete(agentId);
    tryFlush(agentId);
  }, PROMPT_STABILITY_MS);
  stabilityTimers.set(agentId, timer);
}

/** Append a prompt to an agent's FIFO. Rejects (returns false) when the prompt
 *  exceeds MAX_PROMPT_BYTES or the queue is already at MAX_PENDING_PER_AGENT. */
export function enqueue(agentId: string, text: string): boolean {
  if (new TextEncoder().encode(text).length > MAX_PROMPT_BYTES) return false;
  const q = queue.get(agentId);
  if (q) {
    if (q.length >= MAX_PENDING_PER_AGENT) return false;
    q.push(text);
  } else {
    queue.set(agentId, [text]);
    enqueuedAt.set(agentId, Date.now());
  }
  ensureSubscribed();
  return true;
}

/** Output-handler-driven drain. Reads live signals, asks the pure decision fn,
 *  and flushes / drops / waits accordingly. Safe to call re-entrantly. */
export function tryFlush(agentId: string): void {
  const q = queue.get(agentId);
  if (!q?.length) return;
  if (store.agents[agentId]?.status !== 'running') {
    // Agent gone — drop queued items. Full lifecycle teardown wires in 07-02.
    clearAgentQueue(agentId);
    return;
  }
  const r = readiness(agentId);
  const now = Date.now();
  markStable(agentId, r.ready, now);
  const decision = decideBroadcastDelivery({
    phase: 'flush',
    queueLength: q.length,
    ready: r.ready,
    questionActive: isAgentAskingQuestion(agentId),
    writeLocked: writing.has(agentId),
    idle: isAgentIdle(agentId),
    promptFirstReadyAt: promptReadySeenAt.get(agentId),
    enqueuedAt: enqueuedAt.get(agentId),
    now,
    stabilityMs: PROMPT_STABILITY_MS,
    neverIdleTimeoutMs: NEVER_IDLE_TIMEOUT_MS,
    neverIdlePolicy: BROADCAST_NEVER_IDLE_POLICY,
  });
  if (decision.action === 'flush') {
    void deliverNext(agentId);
  } else if (decision.action === 'drop') {
    dropHead(agentId);
  } else if (decision.action === 'wait') {
    scheduleStabilityRecheck(agentId);
  }
  // 'write-through' / 'enqueue' are dispatch-phase only — unreachable here.
}

/** Drop the head-of-queue item (never-idle policy). 07-02 adds the user notice. */
function dropHead(agentId: string): void {
  const q = queue.get(agentId);
  if (!q?.length) return;
  q.shift();
  // TODO(07-02): notify the user that a never-idle broadcast was dropped.
  if (q.length === 0) {
    clearAgentQueue(agentId);
  } else {
    enqueuedAt.set(agentId, Date.now());
  }
}

/** Deliver the next queued prompt under a synchronous single-flight write lock —
 *  the exact guard shape from coordinator.flushNextQueuedPrompt: acquire the lock
 *  BEFORE any await, shift atomically, release in `finally`. */
async function deliverNext(agentId: string): Promise<void> {
  if (writing.has(agentId)) return; // single-flight
  const q = queue.get(agentId);
  if (!q?.length) return;
  writing.add(agentId); // acquire lock synchronously BEFORE any await
  const text = q.shift(); // atomic shift under the lock
  if (text === undefined) {
    writing.delete(agentId);
    return;
  }
  if (q.length === 0) {
    queue.delete(agentId);
    enqueuedAt.delete(agentId);
  } else {
    enqueuedAt.set(agentId, Date.now());
  }
  try {
    await deliver(agentId, text);
  } finally {
    writing.delete(agentId);
    // Drain the next item, if any — the decision fn re-gates on stability/lock.
    if (queue.get(agentId)?.length) tryFlush(agentId);
  }
}

/** Test-only accessor (queue/writing/timer sizes + delivery seam override). */
export const __broadcastTestHooks = {
  setDeliver(fn: DeliverFn): void {
    deliver = fn;
  },
  reset(): void {
    for (const timer of stabilityTimers.values()) clearTimeout(timer);
    queue.clear();
    writing.clear();
    promptReadySeenAt.clear();
    enqueuedAt.clear();
    stabilityTimers.clear();
    deliver = defaultDeliver;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = undefined;
    }
  },
  queueLength(agentId: string): number {
    return queue.get(agentId)?.length ?? 0;
  },
  isWriting(agentId: string): boolean {
    return writing.has(agentId);
  },
  hasStabilityTimer(agentId: string): boolean {
    return stabilityTimers.has(agentId);
  },
};
