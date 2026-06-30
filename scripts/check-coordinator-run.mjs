#!/usr/bin/env node
/* global console, process */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_STARTUP_WINDOW_MS = 2_000;

function timestampMs(line) {
  const match = line.match(/\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})]/);
  if (!match) return undefined;
  const [, hh, mm, ss, ms] = match;
  return Number(hh) * 60 * 60 * 1_000 + Number(mm) * 60 * 1_000 + Number(ss) * 1_000 + Number(ms);
}

function ensureTask(tasks, taskId) {
  let task = tasks.get(taskId);
  if (!task) {
    task = { taskId };
    tasks.set(taskId, task);
  }
  return task;
}

function contextJson(line) {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(line.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function parseSpawn(line) {
  const match = line.match(/pty .* spawn command ([^\s]+) (\{.*)$/);
  if (!match) return undefined;
  const [, agentId, json] = match;
  try {
    const parsed = JSON.parse(json);
    if (typeof parsed.taskId !== 'string') return undefined;
    return { agentId, taskId: parsed.taskId };
  } catch {
    return undefined;
  }
}

function nearestStartupTask(tasks, eventAt, startupWindowMs) {
  if (eventAt === undefined) return undefined;
  let nearest;
  let nearestDelta = Number.POSITIVE_INFINITY;
  for (const task of tasks.values()) {
    if (task.spawnAt === undefined || task.startupControlLine !== undefined) continue;
    const delta = eventAt - task.spawnAt;
    if (delta < 0 || delta > startupWindowMs) continue;
    if (delta < nearestDelta) {
      nearest = task;
      nearestDelta = delta;
    }
  }
  return nearest;
}

export function analyzeCoordinatorRunLog(logText, options = {}) {
  const startupWindowMs = options.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS;
  const tasks = new Map();
  const pendingCreateNames = [];
  const lines = logText.split(/\r?\n/);

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const at = timestampMs(line);

    const createNameMatch = line.match(/\[MCP info] create_task name=(.*?) baseBranch=/);
    if (createNameMatch) {
      pendingCreateNames.push({ name: createNameMatch[1], line: lineNo, at });
      return;
    }

    const spawn = parseSpawn(line);
    if (spawn) {
      const task = ensureTask(tasks, spawn.taskId);
      task.agentId = spawn.agentId;
      task.spawnAt = at;
      task.spawnLine = lineNo;
      task.name ??= pendingCreateNames[0]?.name;
      return;
    }

    const createOkMatch = line.match(/\[MCP info] create_task OK id=([^\s]+)/);
    if (createOkMatch) {
      const task = ensureTask(tasks, createOkMatch[1]);
      const pending = pendingCreateNames.shift();
      task.createOkLine = lineNo;
      task.createOkAt = at;
      task.name ??= pending?.name;
      return;
    }

    if (line.includes('coordinator.initial_prompt') && line.includes('scheduled')) {
      const ctx = contextJson(line);
      if (typeof ctx?.taskId === 'string') {
        const task = ensureTask(tasks, ctx.taskId);
        task.scheduledLine = lineNo;
        task.scheduledAt = at;
      }
      return;
    }

    if (line.includes('coordinator.initial_prompt') && line.includes('delivered')) {
      const ctx = contextJson(line);
      if (typeof ctx?.taskId === 'string') {
        const task = ensureTask(tasks, ctx.taskId);
        task.deliveredLine = lineNo;
        task.deliveredAt = at;
      }
      return;
    }

    if (line.includes('mcp_control_changed')) {
      const task = nearestStartupTask(tasks, at, startupWindowMs);
      if (task) {
        task.startupControlLine = lineNo;
        task.startupControlAt = at;
      }
    }
  });

  const coordinatedTasks = [...tasks.values()].filter(
    (task) => task.spawnLine !== undefined && task.createOkLine !== undefined,
  );
  const issues = [];

  for (const task of coordinatedTasks) {
    if (task.deliveredLine === undefined) {
      const delta =
        task.startupControlAt !== undefined && task.spawnAt !== undefined
          ? task.startupControlAt - task.spawnAt
          : undefined;
      issues.push({
        severity: 'error',
        code: 'initial_prompt_not_confirmed',
        taskId: task.taskId,
        taskName: task.name,
        line: task.spawnLine,
        message: 'spawned coordinated task has no backend initial-prompt delivery log',
        detail:
          delta !== undefined
            ? `startup control changed ${delta}ms after spawn; this often means a trust/startup dialog caused a false human-control hold`
            : task.scheduledLine !== undefined
              ? `initial prompt was scheduled at line ${task.scheduledLine} but no delivered log was found`
              : 'no coordinator.initial_prompt delivered log was found for this task',
      });
      continue;
    }

    if (task.startupControlLine !== undefined) {
      const delta =
        task.startupControlAt !== undefined && task.spawnAt !== undefined
          ? task.startupControlAt - task.spawnAt
          : undefined;
      issues.push({
        severity: 'warning',
        code: 'startup_control_handoff',
        taskId: task.taskId,
        taskName: task.name,
        line: task.startupControlLine,
        message: 'task changed control during startup before initial prompt delivery settled',
        detail: delta !== undefined ? `control changed ${delta}ms after spawn` : undefined,
      });
    }
  }

  return { tasks: coordinatedTasks, issues };
}

export function formatCoordinatorRunReport(result, options = {}) {
  const label = options.file ? basename(options.file) : 'coordinator run log';
  if (result.tasks.length === 0) {
    return `${label}: no coordinated task spawns found`;
  }

  const errors = result.issues.filter((issue) => issue.severity === 'error');
  const warnings = result.issues.filter((issue) => issue.severity === 'warning');
  const lines = [
    `${label}: ${result.tasks.length} coordinated task spawn(s), ${errors.length} error(s), ${warnings.length} warning(s)`,
  ];

  for (const issue of result.issues) {
    const task = issue.taskName ? `${issue.taskName} (${issue.taskId})` : issue.taskId;
    lines.push(`- ${issue.severity.toUpperCase()} ${issue.code}: ${task}`);
    lines.push(`  line ${issue.line}: ${issue.message}`);
    if (issue.detail) lines.push(`  ${issue.detail}`);
  }

  return lines.join('\n');
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error('Usage: node scripts/check-coordinator-run.mjs /tmp/forge-*.out');
    return 2;
  }
  const text = readFileSync(file, 'utf8');
  const result = analyzeCoordinatorRunLog(text);
  console.log(formatCoordinatorRunReport(result, { file }));
  return result.issues.some((issue) => issue.severity === 'error') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
