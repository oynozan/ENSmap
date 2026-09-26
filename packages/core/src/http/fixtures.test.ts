import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { loadEnv, workspaceRoot } from '../config/env.ts';
import { createFixtureFetch, FIXTURES_DIR, fixtureMode } from './fixtures.ts';

const SECRET = 's3cret';
const SECRET_URL = `https://rpc.example/v3/${SECRET}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ensmap-fixtures-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const offline: typeof fetch = () =>
  Promise.reject(new Error('network is off during replay'));

function respondWith(body: string | null, init: ResponseInit): typeof fetch {
  return () => Promise.resolve(new Response(body, init));
}

function savedFiles(): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function replayer(secrets: readonly string[] = [SECRET]) {
  return createFixtureFetch({ dir, mode: 'replay', secrets, inner: offline });
}

describe('createFixtureFetch', () => {
  it('fails a replay with no recorded file, naming the redacted request', async () => {
    await expect(
      replayer()(SECRET_URL, { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({
      message:
        'Fixture missing for POST https://rpc.example/v3/[redacted]; record with ENSMAP_FIXTURES=record',
    });
  });

  it('records a response, then replays the same status and body', async () => {
    const init: RequestInit = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${SECRET}`,
        'x-api-key': SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ q: 1 }),
    };
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [SECRET],
      inner: respondWith('{"answer":42}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'x-served-for': SECRET },
      }),
    });

    const recorded = await record(SECRET_URL, init);
    expect(recorded.status).toBe(201);
    expect(await recorded.json()).toEqual({ answer: 42 });

    const replayed = await replayer()(SECRET_URL, init);
    expect(replayed.status).toBe(201);
    expect(replayed.statusText).toBe('Created');
    expect(await replayed.json()).toEqual({ answer: 42 });
  });

  it('saves one content-addressed file with no authorization header and no secret', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [SECRET],
      inner: respondWith('{"answer":42}', {
        status: 200,
        headers: { 'x-served-for': SECRET },
      }),
    });

    await record(SECRET_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'x-api-key': SECRET },
      body: JSON.stringify({ q: SECRET }),
    });

    const files = savedFiles();
    expect(files).toHaveLength(1);
    const [file = ''] = files;
    expect(file.slice(dir.length)).toMatch(
      /^\/rpc\.example\/[0-9a-f]{64}\.json$/,
    );
    const saved = readFileSync(file, 'utf8');
    expect(saved).not.toContain(SECRET);
    expect(saved.toLowerCase()).not.toContain('authorization');
    expect(saved).toContain('[redacted]');
    expect(() => JSON.parse(saved) as unknown).not.toThrow();
  });

  it('saves only the response headers replay uses, not echoed client details', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: respondWith('{"answer":42}', {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '2',
          'cf-connecting-ip': '203.0.113.7',
          'set-cookie': 'session=abc',
          'user-agent': 'node',
        },
      }),
    });
    await record('https://api.example/graphql', { method: 'POST', body: '{}' });

    const [file = ''] = savedFiles();
    const saved = JSON.parse(readFileSync(file, 'utf8')) as {
      response: { headers: Record<string, string> };
    };
    expect(saved.response.headers).toEqual({
      'content-type': 'application/json',
      'retry-after': '2',
    });
    const replayed = await replayer()('https://api.example/graphql', {
      method: 'POST',
      body: '{}',
    });
    expect(replayed.headers.get('retry-after')).toBe('2');
  });

  it('replays a fixture recorded under a different secret value', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [SECRET],
      inner: respondWith('{"answer":42}', { status: 200 }),
    });
    await record(SECRET_URL);

    const replayed = await replayer(['other-key'])(
      'https://rpc.example/v3/other-key',
    );

    expect(await replayed.json()).toEqual({ answer: 42 });
  });

  it('shares one fixture across JSON-RPC ids and echoes the request id on replay', async () => {
    const echoId: typeof fetch = async (input, init) => {
      const { id } = z
        .object({ id: z.number() })
        .parse(await new Request(input, init).json());
      return Response.json({ jsonrpc: '2.0', id, result: '0x1' });
    };
    const rpc = (id: number): RequestInit => ({
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'eth_chainId',
        params: [],
      }),
    });
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: echoId,
    });

    await record('https://rpc.example/', rpc(1));
    await record('https://rpc.example/', rpc(2));
    expect(savedFiles()).toHaveLength(1);

    const replayed = await replayer()('https://rpc.example/', rpc(7));
    expect(await replayed.json()).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: '0x1',
    });
  });

  it('keys bodies by canonical JSON, so key order does not matter', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: respondWith('{"ok":true}', { status: 200 }),
    });
    await record('https://api.example/', {
      method: 'POST',
      body: '{"b":1,"a":{"d":2,"c":3}}',
    });

    const replayed = await replayer()('https://api.example/', {
      method: 'POST',
      body: '{"a":{"c":3,"d":2},"b":1}',
    });

    expect(await replayed.json()).toEqual({ ok: true });
  });

  it('keeps different bodies in different fixtures', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: () => Promise.resolve(Response.json({ ok: true })),
    });

    await record('https://api.example/', { method: 'POST', body: '{"q":1}' });
    await record('https://api.example/', { method: 'POST', body: '{"q":2}' });

    expect(savedFiles()).toHaveLength(2);
  });

  it('records and replays a non-JSON body as text', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: respondWith('Bad Gateway', { status: 502 }),
    });
    await record('https://api.example/');

    const replayed = await replayer()('https://api.example/');

    expect(replayed.status).toBe(502);
    expect(await replayed.text()).toBe('Bad Gateway');
  });

  it('records and replays a response with no body', async () => {
    const record = createFixtureFetch({
      dir,
      mode: 'record',
      secrets: [],
      inner: respondWith(null, { status: 204 }),
    });
    await record('https://api.example/');

    const replayed = await replayer()('https://api.example/');

    expect(replayed.status).toBe(204);
    expect(await replayed.text()).toBe('');
  });

  it('passes straight through to the inner fetch when off', async () => {
    let calls = 0;
    const off = createFixtureFetch({
      dir,
      mode: 'off',
      secrets: [],
      inner: () => {
        calls += 1;
        return Promise.resolve(new Response('live'));
      },
    });

    const response = await off('https://api.example/');

    expect(await response.text()).toBe('live');
    expect(calls).toBe(1);
    expect(savedFiles()).toEqual([]);
  });
});

describe('FIXTURES_DIR', () => {
  it('resolves to packages/core/test/fixtures from the module, not the cwd', () => {
    expect(FIXTURES_DIR).toBe(
      join(workspaceRoot(), 'packages', 'core', 'test', 'fixtures'),
    );
  });
});

describe('fixtureMode', () => {
  it('uses an explicit ENSMAP_FIXTURES value over the Vitest default', () => {
    vi.stubEnv('VITEST', 'true');

    expect(fixtureMode(loadEnv({ ENSMAP_FIXTURES: 'off' }))).toBe('off');
    expect(fixtureMode(loadEnv({ ENSMAP_FIXTURES: 'record' }))).toBe('record');
  });

  it('defaults to replay when unset under Vitest', () => {
    vi.stubEnv('VITEST', 'true');

    expect(fixtureMode(loadEnv({}))).toBe('replay');
  });

  it('defaults to off when unset outside Vitest', () => {
    vi.stubEnv('VITEST', undefined);

    expect(fixtureMode(loadEnv({}))).toBe('off');
  });
});
