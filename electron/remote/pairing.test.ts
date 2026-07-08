// Tests for device pairing + paired-mobile task-creation routes in the remote
// HTTP server. Verifies the read-only mobile token cannot create tasks, that a
// correct PIN elevates it to a paired token, and the attempt/expiry limits hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';

vi.mock('../ipc/pty.js', () => ({
  writeToAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  subscribeToAgent: vi.fn(),
  unsubscribeFromAgent: vi.fn(),
  getAgentScrollback: vi.fn(() => null),
  getActiveAgentIds: vi.fn(() => []),
  getAgentMeta: vi.fn(() => null),
  getAgentCols: vi.fn(() => 80),
  onPtyEvent: vi.fn(() => vi.fn()),
}));

vi.mock('./protocol.js', () => ({
  parseClientMessage: vi.fn(() => null),
}));

const { startRemoteServer, toFriendlyListenError } = await import('./server.js');

type Resp = { status: number; json: () => Promise<unknown> };

let port = 0;
let stop: () => Promise<void>;
let mobileToken = '';
let generatePin: () => { pin: string; expiresAt: number };
const createTaskFromMobile = vi.fn(async () => ({ taskId: 'task-123' }));
const getProjects = vi.fn(async () => [{ id: 'proj-1', name: 'Repo One' }]);

function req(method: string, path: string, token: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        resolve({
          status: res.statusCode ?? 0,
          json: () => Promise.resolve(raw ? (JSON.parse(raw) as unknown) : null),
        });
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

async function pair(): Promise<string> {
  const { pin } = generatePin();
  const res = await req('POST', '/api/pair/verify', mobileToken, { pin });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  createTaskFromMobile.mockClear();
  getProjects.mockClear();
  const srv = await startRemoteServer({
    port: 0,
    host: '127.0.0.1',
    staticDir: '/nonexistent',
    getTaskName: (id) => id,
    getAgentStatus: () => ({ status: 'exited', exitCode: null, lastLine: '' }),
    getCoordinator: () => null,
    getProjects,
    createTaskFromMobile,
  });
  port = srv.port;
  stop = srv.stop;
  mobileToken = srv.mobileToken;
  generatePin = srv.generatePairingPin;
});

afterEach(async () => {
  await stop();
});

describe('pairing', () => {
  it('elevates the mobile token to a paired token with the correct PIN', async () => {
    const paired = await pair();
    expect(typeof paired).toBe('string');
    expect(paired).not.toBe(mobileToken);
  });

  it('rejects an incorrect PIN', async () => {
    generatePin();
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '000000' });
    // A random wrong guess; if it happened to match, the test PIN space is 1e6.
    expect([401]).toContain(res.status);
  });

  it('rejects a non-6-digit PIN with 400', async () => {
    generatePin();
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '12' });
    expect(res.status).toBe(400);
  });

  it('locks out after too many wrong attempts', async () => {
    const { pin } = generatePin();
    const wrong = pin === '999999' ? '888888' : '999999';
    for (let i = 0; i < 5; i++) {
      const r = await req('POST', '/api/pair/verify', mobileToken, { pin: wrong });
      expect(r.status).toBe(401);
    }
    // PIN is now invalidated even though we submit the correct value.
    const afterLock = await req('POST', '/api/pair/verify', mobileToken, { pin });
    expect(afterLock.status).toBe(401);
  });

  it('returns 401 when no PIN has been generated', async () => {
    const res = await req('POST', '/api/pair/verify', mobileToken, { pin: '123456' });
    expect(res.status).toBe(401);
  });
});

describe('paired-mobile routes', () => {
  it('mobile token cannot list projects or create tasks (403)', async () => {
    expect((await req('GET', '/api/mobile/projects', mobileToken)).status).toBe(403);
    expect(
      (
        await req('POST', '/api/mobile/tasks', mobileToken, {
          projectId: 'p',
          name: 'n',
          prompt: 'x',
        })
      ).status,
    ).toBe(403);
  });

  it('paired token can list projects', async () => {
    const paired = await pair();
    const res = await req('GET', '/api/mobile/projects', paired);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'proj-1', name: 'Repo One' }]);
  });

  it('paired token can create a task', async () => {
    const paired = await pair();
    const res = await req('POST', '/api/mobile/tasks', paired, {
      projectId: 'proj-1',
      name: 'Fix bug',
      prompt: 'Investigate the crash',
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ taskId: 'task-123' });
    expect(createTaskFromMobile).toHaveBeenCalledWith({
      projectId: 'proj-1',
      name: 'Fix bug',
      prompt: 'Investigate the crash',
    });
  });

  it('rejects task creation with a missing name or prompt', async () => {
    const paired = await pair();
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { projectId: 'proj-1', prompt: 'x' })).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { projectId: 'proj-1', name: 'n' })).status,
    ).toBe(400);
    expect(
      (await req('POST', '/api/mobile/tasks', paired, { name: 'n', prompt: 'x' })).status,
    ).toBe(400);
    expect(createTaskFromMobile).not.toHaveBeenCalled();
  });

  it('paired token still has read-only agent access', async () => {
    const paired = await pair();
    expect((await req('GET', '/api/agents', paired)).status).toBe(200);
  });

  it('rejects unauthenticated access', async () => {
    expect((await req('GET', '/api/mobile/projects', 'bogus-token')).status).toBe(401);
  });
});

describe('toFriendlyListenError', () => {
  it('rewrites EADDRINUSE to an actionable message but keeps the code for retry', () => {
    const raw = Object.assign(new Error('listen EADDRINUSE: address already in use 0.0.0.0:7777'), {
      code: 'EADDRINUSE',
    }) as NodeJS.ErrnoException;
    const friendly = toFriendlyListenError(raw, 7777);
    expect(friendly.code).toBe('EADDRINUSE'); // retry loop still detects it
    expect(friendly.message).toMatch(/already in use/i);
    expect(friendly.message).toContain('7777');
  });

  it('passes other errors through unchanged', () => {
    const other = Object.assign(new Error('boom'), { code: 'EACCES' }) as NodeJS.ErrnoException;
    expect(toFriendlyListenError(other, 7777)).toBe(other);
  });
});
