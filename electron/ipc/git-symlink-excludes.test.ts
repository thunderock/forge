import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileSync, mockReadFileSync, mockAppendFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
}));

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFileSync: mockExecFileSync,
    execFile: vi.fn(),
    spawn: vi.fn(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    })),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: mockReadFileSync,
      appendFileSync: mockAppendFileSync,
      promises: actual.promises,
    },
  };
});

import { ensureSymlinkExcludes } from './git.js';

function makeEnoentError(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

describe('ensureSymlinkExcludes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when symlinkNames is empty', () => {
    ensureSymlinkExcludes('/worktree', []);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('adds header and root-anchored entry on first call', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).toContain('# forge: worktree symlinks');
    expect(appended).toContain('/node_modules');
  });

  it('uses root-anchored patterns without trailing slash so symlinks are matched', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules', '.env']);

    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).toContain('/node_modules\n');
    expect(appended).toContain('/.env\n');
    // No trailing slash — must match symlinks, not just directories
    expect(appended).not.toContain('/node_modules/');
    expect(appended).not.toContain('/.env/');
  });

  it('writes to the info/exclude file inside --git-common-dir', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    const [excludePath] = mockAppendFileSync.mock.calls[0] as [string];
    expect(excludePath).toMatch(/\.git[/\\]info[/\\]exclude$/);
  });

  it('resolves an absolute commonDir returned by git rev-parse', () => {
    mockExecFileSync.mockReturnValueOnce('/abs/repo/.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    const [excludePath] = mockAppendFileSync.mock.calls[0] as [string];
    expect(excludePath).toBe('/abs/repo/.git/info/exclude');
  });

  it('resolves a relative commonDir against the worktree path', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    const [excludePath] = mockAppendFileSync.mock.calls[0] as [string];
    expect(excludePath).toBe('/worktree/.git/info/exclude');
  });

  it('appends without repeating the header when it is already present', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('# forge: worktree symlinks\n/existing\n');

    ensureSymlinkExcludes('/worktree', ['.env']);

    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).not.toContain('# forge: worktree symlinks');
    expect(appended).toContain('/.env');
  });

  it('skips names that are already present in the exclude file', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('/node_modules\n');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('adds only the missing entries when some names are already excluded', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('/node_modules\n');

    ensureSymlinkExcludes('/worktree', ['node_modules', '.env']);

    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).not.toContain('/node_modules');
    expect(appended).toContain('/.env');
  });

  it('handles ENOENT on the exclude file and still writes the block', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockImplementationOnce(() => {
      throw makeEnoentError();
    });

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).toContain('/node_modules');
  });

  it('is a no-op when git rev-parse fails (not a git repo)', () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('not a git repository');
    });

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it('adds a newline prefix when the existing file does not end with one', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('# some existing content');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended.startsWith('\n')).toBe(true);
  });

  it('does not add a redundant newline prefix when file already ends with one', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('# some existing content\n');

    ensureSymlinkExcludes('/worktree', ['node_modules']);

    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended.startsWith('\n')).toBe(false);
  });

  it('adds multiple names in a single appendFileSync call', () => {
    mockExecFileSync.mockReturnValueOnce('.git\n');
    mockReadFileSync.mockReturnValueOnce('');

    ensureSymlinkExcludes('/worktree', ['node_modules', '.env', '.cursor']);

    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [, appended] = mockAppendFileSync.mock.calls[0] as [string, string];
    expect(appended).toContain('/node_modules');
    expect(appended).toContain('/.env');
    expect(appended).toContain('/.cursor');
  });
});
