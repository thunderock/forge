// Broadcast prompt fan-out — renderer-only delivery engine.
//
// Target enumeration (this file) resolves, live on every call, the set of
// running AI agents that a broadcast should reach. Scope is app-wide (all
// projects). Excluded: the top-level coordinator agent, coordinator-controlled
// children, shells (structurally — they live in shellAgentIds), and
// landed/exited agents. Delivery fans out over the UNMODIFIED sendPrompt so the
// per-agent skill token, per-agent bracketed-paste decision, FOCUS_IN, scaled
// pasteDelayMs, and the paste->Enter split are all inherited — broadcast never
// calls .focus() or mutates activeTaskId (delivery is focus-independent).
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
import { renderSkillInvocation } from '../lib/agent-args';
import { error as logError } from '../lib/log';
import { store } from './core';
import { isLandedTaskState } from './landing';
import { showNotification } from './notification';
import { sendPrompt } from './tasks';
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

/** Point-in-time delivery tally the dialog renders (07-03 consumes this). */
export interface BroadcastSummary {
  /** Written through immediately (agent idle + ready + empty queue). */
  immediate: number;
  /** Deferred to a busy agent's FIFO (drains on its next stable prompt). */
  queued: number;
  /** Rejected: oversize (> MAX_PROMPT_BYTES) or the agent's queue is full. */
  skipped: number;
}

/** A queued prompt carries its owning taskId so delivery can call the
 *  UNMODIFIED sendPrompt(taskId, agentId, text). Rendered PER AGENT at
 *  enqueue/dispatch time so each agent's FIFO holds its own final string. */
interface QueuedPrompt {
  taskId: string;
  text: string;
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
// Post-send echo settle window (parity with coordinator PROMPT_ECHO_IDLE_SUPPRESSION_MS):
// after a write, the agent echoes the prompt text which can momentarily re-expose
// a prompt marker — suppress the NEXT flush until the agent genuinely returns to
// a stable prompt so the echo does not chain-fire the queue.
const ECHO_SUPPRESS_MS = 2_000;
// Documented flippable policy: a human broadcast into a truly-busy interactive
// TUI risks landing mid-dialog, so failing safe (drop + notify) is correct for a
// manual action. 07-02 wires the backstop interval that enforces this.
const BROADCAST_NEVER_IDLE_POLICY: 'drop' | 'force-write' = 'drop';

// Per-agent append-only FIFO + synchronous write lock + stability/age/echo anchors.
const queue = new Map<string, QueuedPrompt[]>();
const writing = new Set<string>();
const promptReadySeenAt = new Map<string, number>();
const enqueuedAt = new Map<string, number>();
const stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const suppressUntil = new Map<string, number>();

// One-time, lazy subscription to the NON-EXCLUSIVE readiness notifier. Mirrors
// the coordinator's buildAgentOutputCb -> flushNextQueuedPrompt wiring without
// touching the single-slot ready callback owned by PromptInput.
let unsubscribeReadiness: (() => void) | undefined;
function ensureSubscribed(): void {
  if (unsubscribeReadiness) return;
  unsubscribeReadiness = subscribeAgentReadiness((agentId) => tryFlush(agentId));
}

/** Render a broadcast for one agent: a skill is emitted in that agent's syntax
 *  (`/name` claude/opencode, `$name` codex) via renderSkillInvocation, prefixed
 *  to the body. Bracketing is NOT decided here — it is decided per agent INSIDE
 *  sendPrompt (isAgentBracketedPasteEnabled + shouldBypassBracketedPaste), which
 *  is exactly why sendPrompt is reused unchanged. */
function renderForAgent(def: AgentDef, skill: string | undefined, text: string): string {
  return skill ? `${renderSkillInvocation(def, skill)} ${text}`.trim() : text;
}

/** A user-facing label for delivery notices: the owning task name, else the id. */
function agentLabel(taskId: string, agentId: string): string {
  const name = store.tasks[taskId]?.name;
  return typeof name === 'string' && name.length > 0 ? name : agentId;
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
  suppressUntil.delete(agentId);
  const timer = stabilityTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    stabilityTimers.delete(agentId);
  }
}

/** True when a queued broadcast may still be delivered to this agent. Re-filters
 *  at flush time (never a list cached at dispatch): the agent must still be
 *  running and — when its owning task is resolvable — must not have since become
 *  coordinator-controlled or landed. */
function isDeliverable(agentId: string): boolean {
  if (store.agents[agentId]?.status !== 'running') return false;
  const head = queue.get(agentId)?.[0];
  const task = head ? store.tasks[head.taskId] : undefined;
  if (task) {
    if (task.coordinatorMode === true) return false;
    if (task.controlledBy === 'coordinator' || task.coordinatedBy) return false;
    if (isLandedTaskState(task.landingState)) return false;
  }
  return true;
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

/** Append a prompt to an agent's FIFO (no-op push helper shared by enqueue and
 *  the dispatch write-through). */
function pushQueued(agentId: string, prompt: QueuedPrompt): void {
  const q = queue.get(agentId);
  if (q) {
    q.push(prompt);
  } else {
    queue.set(agentId, [prompt]);
    enqueuedAt.set(agentId, Date.now());
  }
}

/** Append a prompt to an agent's FIFO. Rejects (returns false) when the prompt
 *  exceeds MAX_PROMPT_BYTES or the queue is already at MAX_PENDING_PER_AGENT. */
export function enqueue(agentId: string, prompt: QueuedPrompt): boolean {
  if (new TextEncoder().encode(prompt.text).length > MAX_PROMPT_BYTES) return false;
  const q = queue.get(agentId);
  if (q && q.length >= MAX_PENDING_PER_AGENT) return false;
  pushQueued(agentId, prompt);
  ensureSubscribed();
  return true;
}

/**
 * Broadcast `text` (optionally leading with a skill) to every enumerated running
 * AI agent. Idle+ready agents write through immediately; busy agents enqueue and
 * drain on their next stable prompt. Delivery is focus-independent and per-agent
 * (skill token + bracketing decided per agent inside sendPrompt). Returns a
 * point-in-time summary: immediate (written now), queued (deferred), skipped
 * (oversize / queue full).
 */
export async function broadcast(text: string, skill?: string): Promise<BroadcastSummary> {
  ensureSubscribed();
  const summary: BroadcastSummary = { immediate: 0, queued: 0, skipped: 0 };
  const now = Date.now();
  // Live enumeration (never cached): each PTY is independent, so dispatch across
  // agents in parallel — ordering only matters WITHIN one agentId (its FIFO + lock).
  for (const target of enumerateBroadcastTargets()) {
    const rendered = renderForAgent(target.def, skill, text);
    if (new TextEncoder().encode(rendered).length > MAX_PROMPT_BYTES) {
      summary.skipped += 1;
      continue;
    }
    const decision = decideBroadcastDelivery({
      phase: 'dispatch',
      queueLength: queue.get(target.agentId)?.length ?? 0,
      ready: readiness(target.agentId).ready,
      questionActive: isAgentAskingQuestion(target.agentId),
      writeLocked: writing.has(target.agentId),
      idle: isAgentIdle(target.agentId), // the dispatch write-through gate: a
      // genuinely idle+ready agent write-throughs with NO stability wait.
      promptFirstReadyAt: promptReadySeenAt.get(target.agentId),
      enqueuedAt: enqueuedAt.get(target.agentId),
      now,
      suppressUntil: suppressUntil.get(target.agentId),
      stabilityMs: PROMPT_STABILITY_MS,
      neverIdleTimeoutMs: NEVER_IDLE_TIMEOUT_MS,
      neverIdlePolicy: BROADCAST_NEVER_IDLE_POLICY,
    });
    const prompt: QueuedPrompt = { taskId: target.taskId, text: rendered };
    if (decision.action === 'write-through') {
      pushQueued(target.agentId, prompt);
      void deliverNext(target.agentId); // fire-and-forget; deliverNext holds its own lock
      summary.immediate += 1;
    } else if (enqueue(target.agentId, prompt)) {
      summary.queued += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

/** Output-handler-driven drain. Reads live signals, asks the pure decision fn,
 *  and flushes / drops / waits accordingly. Safe to call re-entrantly. */
export function tryFlush(agentId: string): void {
  const q = queue.get(agentId);
  if (!q?.length) return;
  if (!isDeliverable(agentId)) {
    // Agent gone or no longer a valid target — drop queued items so a flush timer
    // never writes to a dead pty. Full lifecycle teardown wires in 07-02.
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
    suppressUntil: suppressUntil.get(agentId),
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
 *  BEFORE any await, shift atomically, release in `finally`. Delivery is the
 *  UNMODIFIED sendPrompt (per-agent skill already rendered into the item;
 *  bracketing/FOCUS_IN/paste split decided per agent inside sendPrompt). */
async function deliverNext(agentId: string): Promise<void> {
  if (writing.has(agentId)) return; // single-flight
  const q = queue.get(agentId);
  if (!q?.length) return;
  writing.add(agentId); // acquire lock synchronously BEFORE any await
  const queued = q.shift(); // atomic shift under the lock
  if (queued === undefined) {
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
    await sendPrompt(queued.taskId, agentId, queued.text);
    // Success: open the echo-settle window and reset the stability anchor so the
    // NEXT item must re-establish a stable prompt before it flushes (prevents the
    // post-write prompt echo from chain-firing the queue).
    suppressUntil.set(agentId, Date.now() + ECHO_SUPPRESS_MS);
    promptReadySeenAt.delete(agentId);
  } catch (err) {
    // sendPrompt is a black box (three awaited writes, throws a plain Error) — we
    // CANNOT know whether the body already landed, so we DROP the (already
    // shifted) item and NEVER re-enqueue, failing safe against a duplicate body.
    logError('broadcast.deliver', 'broadcast delivery failed', err, { agentId });
    showNotification(`Broadcast delivery failed for ${agentLabel(queued.taskId, agentId)}`);
  } finally {
    writing.delete(agentId);
    // Items remain → re-arm a stability recheck (gated again by the echo window).
    if (queue.get(agentId)?.length) scheduleStabilityRecheck(agentId);
  }
}

/** Test-only accessor (queue/writing/timer sizes + reset). */
export const __broadcastTestHooks = {
  reset(): void {
    for (const timer of stabilityTimers.values()) clearTimeout(timer);
    queue.clear();
    writing.clear();
    promptReadySeenAt.clear();
    enqueuedAt.clear();
    stabilityTimers.clear();
    suppressUntil.clear();
    if (unsubscribeReadiness) {
      unsubscribeReadiness();
      unsubscribeReadiness = undefined;
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
