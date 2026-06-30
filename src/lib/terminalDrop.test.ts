import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { escapePath, dataTransferToShellArgs } from './terminalDrop';

describe('escapePath', () => {
  it('passes safe paths through unchanged', () => {
    expect(escapePath('/Users/foo/bar.png')).toBe('/Users/foo/bar.png');
    expect(escapePath('relative/path-1.txt')).toBe('relative/path-1.txt');
    expect(escapePath('a_b.c')).toBe('a_b.c');
    expect(escapePath('user@host:/some/path')).toBe('user@host:/some/path');
  });

  it('escapes whitespace', () => {
    expect(escapePath('/Users/foo/My Image.png')).toBe('/Users/foo/My\\ Image.png');
    expect(escapePath('a\tb')).toBe('a\\\tb');
  });

  it('escapes embedded apostrophes', () => {
    expect(escapePath(`/tmp/it's.png`)).toBe(`/tmp/it\\'s.png`);
  });

  it('escapes embedded double quotes', () => {
    expect(escapePath('/tmp/say "hi".png')).toBe('/tmp/say\\ \\"hi\\".png');
  });

  it('escapes shell metacharacters', () => {
    expect(escapePath('/tmp/a$b.png')).toBe('/tmp/a\\$b.png');
    expect(escapePath('/tmp/a`b.png')).toBe('/tmp/a\\`b.png');
    expect(escapePath('/tmp/(weird).png')).toBe('/tmp/\\(weird\\).png');
    expect(escapePath('/tmp/a&b.png')).toBe('/tmp/a\\&b.png');
    expect(escapePath('/tmp/a|b.png')).toBe('/tmp/a\\|b.png');
    expect(escapePath('/tmp/a;b.png')).toBe('/tmp/a\\;b.png');
    expect(escapePath('/tmp/a*b.png')).toBe('/tmp/a\\*b.png');
    expect(escapePath('/tmp/a?b.png')).toBe('/tmp/a\\?b.png');
    expect(escapePath('/tmp/[a].png')).toBe('/tmp/\\[a\\].png');
    expect(escapePath('/tmp/{a}.png')).toBe('/tmp/\\{a\\}.png');
    expect(escapePath('/tmp/~a.png')).toBe('/tmp/\\~a.png');
    expect(escapePath('/tmp/#a.png')).toBe('/tmp/\\#a.png');
    expect(escapePath('/tmp/!a.png')).toBe('/tmp/\\!a.png');
    expect(escapePath('/tmp/a<b>.png')).toBe('/tmp/a\\<b\\>.png');
  });

  it('escapes embedded backslash', () => {
    expect(escapePath('a\\b')).toBe('a\\\\b');
  });

  it('renders the empty string as an explicit empty argv', () => {
    expect(escapePath('')).toBe('""');
  });

  it('chains escapes for paths with multiple metacharacters', () => {
    expect(escapePath(`/tmp/it's "weird" & cool.png`)).toBe(
      `/tmp/it\\'s\\ \\"weird\\"\\ \\&\\ cool.png`,
    );
  });
});

// File / DataTransfer don't exist in jsdom-less vitest by default. Provide
// the smallest shape the helper actually reads.
type FakeFile = Pick<File, 'name' | 'size' | 'arrayBuffer'>;
function makeFakeFile(name: string, bytes: Uint8Array): FakeFile {
  // Copy the bytes into a fresh ArrayBuffer so the test never returns a
  // SharedArrayBuffer view (which the File.arrayBuffer typing forbids).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return {
    name,
    size: bytes.length,
    arrayBuffer: () => Promise.resolve(ab),
  };
}
function makeFakeDt(files: FakeFile[]): DataTransfer {
  return { files: files as unknown as FileList } as unknown as DataTransfer;
}

describe('dataTransferToShellArgs', () => {
  let getPathForFile: ReturnType<typeof vi.fn>;
  let invoke: ReturnType<typeof vi.fn>;
  let originalElectron: unknown;

  beforeEach(() => {
    getPathForFile = vi.fn();
    invoke = vi.fn();
    // Vitest runs in node by default — there is no window. Define one with
    // the only field the helpers touch (electron.{getPathForFile,ipcRenderer}).
    const g = globalThis as { window?: { electron?: unknown }; electron?: unknown };
    originalElectron = g.window;
    g.window = {
      electron: {
        getPathForFile,
        // dataTransferToShellArgs calls invoke() from ./ipc, which itself
        // dispatches via window.electron.ipcRenderer.invoke. Stub the
        // whole chain so the helper never touches a real ipcRenderer.
        ipcRenderer: { invoke },
      },
    };
  });
  afterEach(() => {
    const g = globalThis as { window?: unknown };
    g.window = originalElectron;
  });

  it('returns "" for an empty DataTransfer', async () => {
    expect(await dataTransferToShellArgs(makeFakeDt([]))).toBe('');
    expect(getPathForFile).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses getPathForFile when File has a backing path', async () => {
    getPathForFile.mockReturnValue('/Users/foo/My Image.png');
    const dt = makeFakeDt([makeFakeFile('My Image.png', new Uint8Array([1, 2, 3]))]);

    const args = await dataTransferToShellArgs(dt);

    expect(args).toBe('/Users/foo/My\\ Image.png');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('joins multiple resolved paths with a single space', async () => {
    getPathForFile.mockReturnValueOnce('/a/b.png').mockReturnValueOnce('/c d/e.png');
    const dt = makeFakeDt([
      makeFakeFile('b.png', new Uint8Array()),
      makeFakeFile('e.png', new Uint8Array()),
    ]);

    expect(await dataTransferToShellArgs(dt)).toBe('/a/b.png /c\\ d/e.png');
  });

  it('falls back to SaveDroppedImage IPC when File has no path', async () => {
    getPathForFile.mockReturnValue('');
    invoke.mockResolvedValue('/tmp/forge-drop-123-screenshot.png');
    const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic
    const dt = makeFakeDt([makeFakeFile('screenshot.png', bytes)]);

    const args = await dataTransferToShellArgs(dt);

    expect(args).toBe('/tmp/forge-drop-123-screenshot.png');
    expect(invoke).toHaveBeenCalledTimes(1);
    const [channel, payload] = invoke.mock.calls[0];
    expect(channel).toBe('save_dropped_image');
    expect(payload.name).toBe('screenshot.png');
    expect(typeof payload.data).toBe('string');
    // Base64-encoded 4-byte PNG magic header.
    expect(payload.data).toBe('iVBORw==');
  });

  it('skips files larger than 50 MB', async () => {
    getPathForFile.mockReturnValue('');
    const huge = makeFakeFile('huge.bin', new Uint8Array());
    // The helper reads .size before allocating an arrayBuffer.
    Object.defineProperty(huge, 'size', { value: 50 * 1024 * 1024 + 1 });
    const dt = makeFakeDt([huge]);

    expect(await dataTransferToShellArgs(dt)).toBe('');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('drops failed resolutions but keeps successful ones', async () => {
    getPathForFile.mockReturnValueOnce('/good/a.png').mockReturnValueOnce('');
    invoke.mockRejectedValueOnce(new Error('main blew up'));
    const dt = makeFakeDt([
      makeFakeFile('a.png', new Uint8Array()),
      makeFakeFile('b.png', new Uint8Array([1])),
    ]);

    expect(await dataTransferToShellArgs(dt)).toBe('/good/a.png');
  });

  it('isolates a thrown arrayBuffer() from sibling files', async () => {
    // Path-less file whose .arrayBuffer() rejects (e.g. revoked blob URL,
    // permission flap). A naive Promise.all would reject the whole drop and
    // lose the path-backed sibling.
    getPathForFile.mockImplementation((file: File) =>
      file.name === 'good.png' ? '/good.png' : '',
    );
    const broken: FakeFile = {
      name: 'broken.png',
      size: 10,
      arrayBuffer: () => Promise.reject(new Error('blob revoked')),
    };
    const dt = makeFakeDt([broken, makeFakeFile('good.png', new Uint8Array())]);

    expect(await dataTransferToShellArgs(dt)).toBe('/good.png');
    expect(invoke).not.toHaveBeenCalled();
  });
});
