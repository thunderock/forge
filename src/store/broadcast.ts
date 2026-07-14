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
import { store } from './core';
import { isLandedTaskState } from './landing';

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
