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

import { createSignal } from 'solid-js';
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
  normalizeCurrentFrame,
  subscribeAgentReadiness,
  subscribeAgentTeardown,
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
// manual action. Flippable module constant (the pure fn implements both branches).
const BROADCAST_NEVER_IDLE_POLICY: 'drop' | 'force-write' = 'drop';
// Backstop sweep cadence — the SINGLE interval in this module, existing only as
// the never-idle timeout + dead-agent sweep. The primary flush trigger remains
// the output-driven readiness hook; this self-stops when all queues drain.
const FLUSH_BACKSTOP_MS = 500;
// Quiescence fallback (mirrors the initialPrompt slow path's QUIESCENCE_THRESHOLD_MS,
// with the same 500ms poll = FLUSH_BACKSTOP_MS): a markerless agent (e.g. opencode,
// whose TUI has no ❯/›/> ready marker) is delivered to once its normalized output
// frame has been unchanged this long. Without it, such agents never flush.
const QUIESCENCE_MS = 1_500;
// Live policy the flush path reads (defaults to the constant; test-flippable).
let neverIdlePolicy: 'drop' | 'force-write' = BROADCAST_NEVER_IDLE_POLICY;

// Per-agent append-only FIFO + synchronous write lock + stability/age/echo anchors.
const queue = new Map<string, QueuedPrompt[]>();
const writing = new Set<string>();
const promptReadySeenAt = new Map<string, number>();
const enqueuedAt = new Map<string, number>();
const stabilityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const suppressUntil = new Map<string, number>();
// Per-agent normalized-frame snapshot for the quiescence fallback ({frame, since}):
// a markerless agent flushes once its frame has been unchanged for QUIESCENCE_MS,
// sampled on each tryFlush (the backstop's 500ms cadence is the poll).
const quiescenceFrame = new Map<string, { frame: string; since: number }>();

// Reactive per-agent "pending broadcast" display text for the per-pane indicator
// (PromptInput reads it via getBroadcastPending). Derived from the head of each
// agent's FIFO on every queue mutation; cleared when that agent's queue drains.
const [pendingDisplay, setPendingDisplay] = createSignal<Record<string, string>>({});

/** Recompute an agent's pending-broadcast label from the current head of its FIFO
 *  (with a "(+N more)" suffix when several are stacked). Called after every queue
 *  mutation so the per-pane indicator tracks enqueue → deliver → drain. */
function refreshPending(agentId: string): void {
  const q = queue.get(agentId);
  const head = q?.[0]?.text;
  const depth = q?.length ?? 0;
  setPendingDisplay((prev) => {
    if (head === undefined) {
      if (!(agentId in prev)) return prev;
      const next = { ...prev };
      delete next[agentId];
      return next;
    }
    const snippet = head.length > 80 ? `${head.slice(0, 80)}…` : head;
    const label = depth > 1 ? `${snippet} (+${depth - 1} more)` : snippet;
    if (prev[agentId] === label) return prev;
    return { ...prev, [agentId]: label };
  });
}

/** Reactive: the broadcast prompt currently queued for an agent — the head of its
 *  FIFO (with a "(+N more)" suffix when several are stacked), or undefined when
 *  nothing is pending. PromptInput renders this at the bottom of the agent's pane
 *  as the per-agent delivery feedback (the dialog fires-and-closes). */
export function getBroadcastPending(agentId: string): string | undefined {
  return pendingDisplay()[agentId];
}

// The ONE backstop interval (never-idle timeout + dead-agent sweep). Runs only
// while a queue is non-empty and self-stops when all drain. NO `.unref()`: the
// renderer is a pure browser context so setInterval returns a `number` with no
// such method (calling it throws) and browser timers keep no process alive.
let backstop: ReturnType<typeof setInterval> | null = null;

// One-time, lazy subscription to the NON-EXCLUSIVE readiness notifier. Mirrors
// the coordinator's buildAgentOutputCb -> flushNextQueuedPrompt wiring without
// touching the single-slot ready callback owned by PromptInput.
let unsubscribeReadiness: (() => void) | undefined;
let unsubscribeTeardown: (() => void) | undefined;
function ensureSubscribed(): void {
  if (unsubscribeReadiness) return;
  unsubscribeReadiness = subscribeAgentReadiness((agentId) => tryFlush(agentId));
  // Wire teardown to the renderer's canonical per-agent removal routine so
  // queue/timer/lock/anchors are dropped on agent exit (never leak, never flush
  // into a dead pty).
  unsubscribeTeardown = subscribeAgentTeardown((agentId) => teardownAgent(agentId));
}

/** True while any agent still has a pending queued prompt. */
function hasPendingQueues(): boolean {
  for (const q of queue.values()) if (q.length) return true;
  return false;
}

/** Start the single backstop interval if a queue is pending and it is not
 *  already running. */
function startBackstop(): void {
  if (backstop !== null || !hasPendingQueues()) return;
  backstop = setInterval(runBackstopTick, FLUSH_BACKSTOP_MS);
}

/** Stop the backstop once every queue has drained. */
function maybeStopBackstop(): void {
  if (backstop === null || hasPendingQueues()) return;
  clearInterval(backstop);
  backstop = null;
}

/** Backstop sweep: for every agent with pending items, drop it if it is gone,
 *  else re-run the flush decision (drives the never-idle timeout for silent
 *  busy agents that never re-emit a readiness edge). */
function runBackstopTick(): void {
  // Snapshot keys — teardownAgent/deliverNext mutate the queue map during sweep.
  for (const agentId of [...queue.keys()]) {
    if (!queue.get(agentId)?.length) continue;
    if (store.agents[agentId]?.status !== 'running') {
      teardownAgent(agentId);
      continue;
    }
    tryFlush(agentId);
  }
  maybeStopBackstop();
}

/** ONE shared teardown for an agent — wired to clearAgentActivity via
 *  subscribeAgentTeardown, and reused for the flush-time drop of a gone/invalid
 *  agent. Drops queue/timer/lock/anchors/suppress and stops the backstop if idle. */
function teardownAgent(agentId: string): void {
  queue.delete(agentId);
  const timer = stabilityTimers.get(agentId);
  if (timer !== undefined) {
    clearTimeout(timer);
    stabilityTimers.delete(agentId);
  }
  writing.delete(agentId);
  promptReadySeenAt.delete(agentId);
  enqueuedAt.delete(agentId);
  suppressUntil.delete(agentId);
  quiescenceFrame.delete(agentId);
  refreshPending(agentId);
  maybeStopBackstop();
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

/** Quiescence fallback for markerless agents (mirrors the initialPrompt slow
 *  path): true once the agent's normalized output frame has been unchanged for
 *  QUIESCENCE_MS. Sampled on each tryFlush; the backstop's 500ms cadence is the
 *  poll. An empty/whitespace frame does not start the clock. */
function isQuiescent(agentId: string, now: number): boolean {
  const frame = normalizeCurrentFrame(getAgentOutputTail(agentId)).trim();
  if (!frame) {
    quiescenceFrame.delete(agentId);
    return false;
  }
  const prev = quiescenceFrame.get(agentId);
  if (!prev || prev.frame !== frame) {
    quiescenceFrame.set(agentId, { frame, since: now });
    return false;
  }
  return now - prev.since >= QUIESCENCE_MS;
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
  refreshPending(agentId);
}

/** Append a prompt to an agent's FIFO. Rejects (returns false) when the prompt
 *  exceeds MAX_PROMPT_BYTES or the queue is already at MAX_PENDING_PER_AGENT. */
export function enqueue(agentId: string, prompt: QueuedPrompt): boolean {
  if (new TextEncoder().encode(prompt.text).length > MAX_PROMPT_BYTES) return false;
  const q = queue.get(agentId);
  if (q && q.length >= MAX_PENDING_PER_AGENT) return false;
  pushQueued(agentId, prompt);
  ensureSubscribed();
  startBackstop(); // sweep never-idle/dead agents that never re-emit readiness
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
      neverIdlePolicy,
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
    // Agent gone or no longer a valid target — tear down so a flush timer never
    // writes to a dead pty (and the backstop stops once all queues drain).
    teardownAgent(agentId);
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
    // Quiescence fallback, but NEVER while a busy marker (esc to interrupt / Working…)
    // is showing — a running agent can be mid-work with momentarily-static output,
    // and quiescing there would interrupt it. (The initialPrompt slow path doesn't
    // need this guard because it runs at startup, before any work is in flight.)
    quiescent: r.reason !== 'busy' && isQuiescent(agentId, now),
    promptFirstReadyAt: promptReadySeenAt.get(agentId),
    enqueuedAt: enqueuedAt.get(agentId),
    now,
    suppressUntil: suppressUntil.get(agentId),
    stabilityMs: PROMPT_STABILITY_MS,
    neverIdleTimeoutMs: NEVER_IDLE_TIMEOUT_MS,
    neverIdlePolicy,
  });
  if (decision.action === 'flush') {
    void deliverNext(agentId);
  } else if (decision.action === 'drop') {
    dropHead(agentId);
  } else if (decision.action === 'wait' && r.ready) {
    // Only self-poll while waiting for a READY marker to persist the ~50ms
    // stability window. A not-ready (busy) agent is driven by the output
    // readiness hook + the backstop sweep, not a tight timer — no busy-poll.
    scheduleStabilityRecheck(agentId);
  }
  // 'write-through' / 'enqueue' are dispatch-phase only — unreachable here.
}

/** Drop the head-of-queue item under the never-idle policy and notify the user
 *  (the agent stayed busy past NEVER_IDLE_TIMEOUT_MS — a manual broadcast fails
 *  safe rather than landing mid-dialog). */
function dropHead(agentId: string): void {
  const q = queue.get(agentId);
  if (!q?.length) return;
  const dropped = q.shift();
  const label = dropped ? agentLabel(dropped.taskId, agentId) : agentId;
  showNotification(`${label} stayed busy — broadcast not delivered`);
  if (q.length === 0) {
    teardownAgent(agentId);
  } else {
    enqueuedAt.set(agentId, Date.now());
    refreshPending(agentId);
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
  refreshPending(agentId);
  try {
    await sendPrompt(queued.taskId, agentId, queued.text);
    // Success: open the echo-settle window and reset the stability anchor so the
    // NEXT item must re-establish a stable prompt before it flushes (prevents the
    // post-write prompt echo from chain-firing the queue).
    suppressUntil.set(agentId, Date.now() + ECHO_SUPPRESS_MS);
    promptReadySeenAt.delete(agentId);
    quiescenceFrame.delete(agentId);
  } catch (err) {
    // sendPrompt is a black box (three awaited writes, throws a plain Error) — we
    // CANNOT know whether the body already landed, so we DROP the (already
    // shifted) item and NEVER re-enqueue, failing safe against a duplicate body.
    logError('broadcast.deliver', 'broadcast delivery failed', err, { agentId });
    showNotification(`Broadcast delivery failed for ${agentLabel(queued.taskId, agentId)}`);
  } finally {
    writing.delete(agentId);
    // Items remain → re-arm a stability recheck (gated again by the echo window);
    // otherwise this queue drained → stop the backstop if no agent is pending.
    if (queue.get(agentId)?.length) scheduleStabilityRecheck(agentId);
    else maybeStopBackstop();
  }
}

/** Test-only accessor (queue/writing/timer sizes, backstop + policy control, reset). */
export const __broadcastTestHooks = {
  reset(): void {
    for (const timer of stabilityTimers.values()) clearTimeout(timer);
    if (backstop !== null) {
      clearInterval(backstop);
      backstop = null;
    }
    queue.clear();
    writing.clear();
    promptReadySeenAt.clear();
    enqueuedAt.clear();
    stabilityTimers.clear();
    suppressUntil.clear();
    quiescenceFrame.clear();
    setPendingDisplay({});
    neverIdlePolicy = BROADCAST_NEVER_IDLE_POLICY;
    if (unsubscribeReadiness) {
      unsubscribeReadiness();
      unsubscribeReadiness = undefined;
    }
    if (unsubscribeTeardown) {
      unsubscribeTeardown();
      unsubscribeTeardown = undefined;
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
  isBackstopActive(): boolean {
    return backstop !== null;
  },
  setNeverIdlePolicy(policy: 'drop' | 'force-write'): void {
    neverIdlePolicy = policy;
  },
  internalSizes(): {
    queue: number;
    writing: number;
    promptReadySeenAt: number;
    enqueuedAt: number;
    stabilityTimers: number;
    suppressUntil: number;
  } {
    return {
      queue: queue.size,
      writing: writing.size,
      promptReadySeenAt: promptReadySeenAt.size,
      enqueuedAt: enqueuedAt.size,
      stabilityTimers: stabilityTimers.size,
      suppressUntil: suppressUntil.size,
    };
  },
};
