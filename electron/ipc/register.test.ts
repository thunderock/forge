import { describe, expect, it } from 'vitest';
import { openExternalHttpUrl, selectMcpJsonDir, validateExternalHttpUrl } from './register.js';

describe('selectMcpJsonDir', () => {
  it('returns worktreePath when defined', () => {
    expect(selectMcpJsonDir('/worktrees/my-task', '/project')).toBe('/worktrees/my-task');
  });

  it('returns projectRoot when worktreePath is undefined', () => {
    expect(selectMcpJsonDir(undefined, '/project')).toBe('/project');
  });

  it('returns empty string when worktreePath is empty string (nullish coalescing only catches null/undefined)', () => {
    expect(selectMcpJsonDir('', '/project')).toBe('');
  });
});

describe('validateExternalHttpUrl', () => {
  it('accepts http and https URLs', () => {
    expect(validateExternalHttpUrl('https://example.com/path?q=1')).toBe(
      'https://example.com/path?q=1',
    );
    expect(validateExternalHttpUrl('http://example.com/')).toBe('http://example.com/');
  });

  it('normalizes protocol and host casing', () => {
    expect(validateExternalHttpUrl('HTTPS://EXAMPLE.COM/pr/1')).toBe('https://example.com/pr/1');
  });

  it('rejects non-web protocols', () => {
    expect(() => validateExternalHttpUrl('file:///etc/passwd')).toThrow(
      'url must use http or https',
    );
    expect(() => validateExternalHttpUrl('javascript:alert(1)')).toThrow(
      'url must use http or https',
    );
  });

  it('rejects invalid and non-string values', () => {
    expect(() => validateExternalHttpUrl('not a url')).toThrow('url must be a valid URL');
    expect(() => validateExternalHttpUrl(undefined)).toThrow('url must be a string');
  });
});

describe('openExternalHttpUrl', () => {
  it('opens the normalized URL', async () => {
    const opened: string[] = [];

    await openExternalHttpUrl('HTTPS://EXAMPLE.COM/pr/1', async (url) => {
      opened.push(url);
    });

    expect(opened).toEqual(['https://example.com/pr/1']);
  });

  it('does not call the opener for invalid URLs', async () => {
    const opened: string[] = [];

    await expect(
      openExternalHttpUrl('file:///etc/passwd', async (url) => {
        opened.push(url);
      }),
    ).rejects.toThrow('url must use http or https');

    expect(opened).toEqual([]);
  });

  it('does not include the URL in opener failure errors', async () => {
    await expect(
      openExternalHttpUrl('https://example.com/?token=secret', async (url) => {
        throw new Error(`OS refused ${url}`);
      }),
    ).rejects.toThrow('Failed to open external URL');
  });
});
