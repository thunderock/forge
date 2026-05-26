import { describe, expect, it } from 'vitest';
import { analyzeCoordinatorRunLog, formatCoordinatorRunReport } from './check-coordinator-run.mjs';

describe('check-coordinator-run', () => {
  it('passes when every spawned coordinated task logs backend initial-prompt delivery', () => {
    const result = analyzeCoordinatorRunLog(`
[1] [01:00:00.000] [MCP info] create_task name=task-one baseBranch=task/root
[1] [01:00:00.100] DEBUG pty — spawn command agent-one {"taskId":"task-1","command":"codex"}
[1] [01:00:00.110] [MCP info] create_task OK id=task-1
[1] [01:00:00.500] INFO coordinator.initial_prompt — scheduled {"taskId":"task-1","agentId":"agent-one","delayMs":1500}
[1] [01:00:02.000] INFO coordinator.initial_prompt — delivered {"taskId":"task-1","agentId":"agent-one"}
[1] [01:00:03.000] [MCP info] create_task name=task-two baseBranch=task/root
[1] [01:00:03.100] DEBUG pty — spawn command agent-two {"taskId":"task-2","command":"codex"}
[1] [01:00:03.110] [MCP info] create_task OK id=task-2
[1] [01:00:03.500] INFO coordinator.initial_prompt — scheduled {"taskId":"task-2","agentId":"agent-two","delayMs":1500}
[1] [01:00:04.500] INFO coordinator.initial_prompt — delivered {"taskId":"task-2","agentId":"agent-two"}
`);

    expect(result.tasks).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it('flags startup control handoff with no backend initial-prompt delivery', () => {
    const result = analyzeCoordinatorRunLog(`
[1] [01:13:57.267] [MCP info] create_task name=task-200-update-check-policy baseBranch=task/root
[1] [01:13:57.426] DEBUG pty — spawn command agent-one {"taskId":"task-200","command":"codex"}
[1] [01:13:57.427] [MCP info] create_task OK id=task-200
[1] [01:13:57.523] DEBUG ipc — mcp_control_changed
[1] [01:13:57.534] DEBUG ipc — write_to_agent
`);

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'initial_prompt_not_confirmed',
        taskId: 'task-200',
        taskName: 'task-200-update-check-policy',
        detail: expect.stringContaining('startup control changed 97ms after spawn'),
      }),
    ]);
  });

  it('distinguishes scheduled-but-not-delivered startup failures', () => {
    const result = analyzeCoordinatorRunLog(`
[1] [01:13:57.267] [MCP info] create_task name=task-200-update-check-policy baseBranch=task/root
[1] [01:13:57.426] DEBUG pty — spawn command agent-one {"taskId":"task-200","command":"codex"}
[1] [01:13:57.427] [MCP info] create_task OK id=task-200
[1] [01:13:58.000] INFO coordinator.initial_prompt — scheduled {"taskId":"task-200","agentId":"agent-one","delayMs":1500}
`);

    expect(result.issues).toEqual([
      expect.objectContaining({
        severity: 'error',
        code: 'initial_prompt_not_confirmed',
        taskId: 'task-200',
        detail: expect.stringContaining('scheduled at line 5'),
      }),
    ]);
  });

  it('reports when no coordinated task spawns are present', () => {
    const result = analyzeCoordinatorRunLog('[1] [01:00:00.000] DEBUG ipc — get_mcp_status');

    expect(formatCoordinatorRunReport(result, { file: '/tmp/run.out' })).toBe(
      'run.out: no coordinated task spawns found',
    );
  });
});
