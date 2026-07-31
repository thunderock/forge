import { describe, expect, it } from 'vitest';
import { getProjectTaskCount } from './project-remove-confirmation';

describe('getProjectTaskCount', () => {
  it('counts open and collapsed tasks for the project', () => {
    expect(
      getProjectTaskCount(
        {
          taskOrder: ['task-1', 'task-2', 'missing-task'],
          collapsedTaskOrder: ['collapsed-1', 'collapsed-other'],
          tasks: {
            'task-1': { projectId: 'project-a' },
            'task-2': { projectId: 'project-b' },
            'collapsed-1': { projectId: 'project-a' },
            'collapsed-other': { projectId: 'project-c' },
          },
        },
        'project-a',
      ),
    ).toBe(2);
  });

  it('returns 0 when the project has no tasks', () => {
    expect(
      getProjectTaskCount(
        {
          taskOrder: ['task-1'],
          collapsedTaskOrder: [],
          tasks: { 'task-1': { projectId: 'other' } },
        },
        'project-a',
      ),
    ).toBe(0);
  });
});
