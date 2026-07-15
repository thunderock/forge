// Pure decision function for broadcast prompt delivery — the tested correctness
// spine shared by the dispatch (write-through) and flush (queue-drain) paths.
//
// Mirrors the shape of `src/components/autofire-tick.ts::processAutoFireTick`:
// zero side effects, an injected `now`, and NO prompt detection of its own. The
// caller computes `ready` from the HARDENED getAgentPromptReadiness and `idle`
// from isAgentIdle — this module never scans for raw prompt glyphs.
//
// Phase split (do not conflate):
//  - dispatch: a user-initiated broadcast reading the SETTLED tail. Gates on the
//    debounced `idle` flag (false while output streams; true once settled at a
//    detected prompt, or after the 15s idle fallback). NO stability window here —
//    the one-chunk-flicker guard only applies to streamed chunks.
//  - flush: the output-handler-driven drain. Delivers on EITHER the ~50ms
//    `stability` window (a marker must persist; claude/codex) OR the `quiescent`
//    fallback (normalized output stable long enough; markerless agents like
//    opencode), mirroring the initialPrompt slow path — because this path
//    observes per-chunk output where a marker can flicker or never appear.

export type BroadcastDecision =
  | { action: 'write-through' }
  | { action: 'flush' }
  | { action: 'enqueue' }
  | { action: 'wait' }
  | { action: 'drop'; reason: 'never-idle' };

export interface BroadcastDecisionParams {
  phase: 'dispatch' | 'flush';
  /** Items already queued for this agent (excludes the item being dispatched). */
  queueLength: number;
  /** Live hardened readiness of the settled tail (getAgentPromptReadiness().ready). */
  ready: boolean;
  /** Agent is showing a question/confirmation dialog (isAgentAskingQuestion). */
  questionActive: boolean;
  /** A synchronous per-agent write is in flight. */
  writeLocked: boolean;
  /** Debounced idle flag (isAgentIdle) — false while non-prompt output streams. */
  idle: boolean;
  /** Flush-phase only: the agent's normalized output frame has been stable long
   *  enough to deliver WITHOUT a recognized prompt marker — the initialPrompt
   *  slow-path fallback for markerless agents (e.g. opencode). */
  quiescent?: boolean;
  /** When the prompt marker was first seen ready (flush-phase stability anchor). */
  promptFirstReadyAt?: number;
  /** When the head-of-queue item was enqueued (never-idle timeout anchor). */
  enqueuedAt?: number;
  /** Injected clock. */
  now: number;
  /** Suppress delivery until this time (e.g. post-echo settle window). */
  suppressUntil?: number;
  /** Marker-persistence window for the flush path (~50ms). */
  stabilityMs: number;
  /** How long a queued broadcast waits for an idle prompt before the policy fires. */
  neverIdleTimeoutMs: number;
  /** What to do when an agent never becomes idle before the timeout. */
  neverIdlePolicy: 'drop' | 'force-write';
}

/**
 * Decide what to do with a broadcast for a single agent. Assumes the caller has
 * already excluded non-running / non-target agents.
 */
export function decideBroadcastDelivery(p: BroadcastDecisionParams): BroadcastDecision {
  const stable =
    p.promptFirstReadyAt !== undefined && p.now - p.promptFirstReadyAt >= p.stabilityMs;
  const suppressed = p.suppressUntil !== undefined && p.now < p.suppressUntil;
  const notBlocked = !p.questionActive && !p.writeLocked && !suppressed;
  const base = p.ready && notBlocked;

  if (p.phase === 'dispatch') {
    // No stability wait: the caller reads the full settled tail here, so the
    // one-chunk flicker guard does not apply. The debounced `idle` flag already
    // encodes ">50ms at rest", preserving the no-mid-response-interrupt bar.
    return p.queueLength === 0 && base && p.idle
      ? { action: 'write-through' }
      : { action: 'enqueue' };
  }

  // flush phase — deliver on EITHER the hardened marker persisted ~50ms
  // (claude/codex) OR the quiescence fallback (markerless agents, e.g. opencode),
  // mirroring the initialPrompt slow path. Both still require not-question /
  // not-writing / not-echo-suppressed. (idle is passed but not required here so
  // one fn contract serves both phases.)
  if (notBlocked && ((p.ready && stable) || p.quiescent === true)) return { action: 'flush' };
  if (p.enqueuedAt !== undefined && p.now - p.enqueuedAt >= p.neverIdleTimeoutMs) {
    return p.neverIdlePolicy === 'force-write'
      ? { action: 'flush' }
      : { action: 'drop', reason: 'never-idle' };
  }
  return { action: 'wait' };
}
