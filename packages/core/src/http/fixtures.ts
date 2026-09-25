import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Env } from '../config/env.ts';
import { parseJson } from './client.ts';
import { redact } from './redact.ts';

export type FixtureMode = 'record' | 'replay' | 'off';

export const FIXTURES_DIR = fileURLToPath(
  new URL('../../test/fixtures', import.meta.url),
);

export function fixtureMode(env: Env): FixtureMode {
  return env.ENSMAP_FIXTURES ?? (process.env['VITEST'] ? 'replay' : 'off');
}

// The Response constructor rejects any body, even '', for these statuses
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const StoredFixture = z.object({
  response: z.object({
    status: z.number().int(),
    statusText: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.json().optional(),
    text: z.string().optional(),
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonRpc(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && 'jsonrpc' in value;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  }
  return value;
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    return redact(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets),
        redactDeep(item, secrets),
      ]),
    );
  }
  return value;
}

function savedHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers].filter(([name]) => name !== 'authorization'),
  );
}

// JSON-RPC ids are per-call counters, so they stay out of the key
function keyBody(text: string): string {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return text;
  }
  const keyed = isJsonRpc(parsed.value)
    ? Object.fromEntries(
        Object.entries(parsed.value).filter(([name]) => name !== 'id'),
      )
    : parsed.value;
  return JSON.stringify(sortKeys(keyed));
}

function requestId(text: string): { id: unknown } | null {
  const parsed = parseJson(text);
  return parsed.ok && isJsonRpc(parsed.value) && 'id' in parsed.value
    ? { id: parsed.value['id'] }
    : null;
}

export function createFixtureFetch(opts: {
  dir: string;
  mode: FixtureMode;
  secrets: readonly string[];
  inner?: typeof fetch;
}): typeof fetch {
  const { dir, mode, secrets } = opts;
  // Captured now so a global fetch stubbed with this function cannot recurse
  const inner = opts.inner ?? globalThis.fetch;
  if (mode === 'off') {
    return inner;
  }

  async function replay(
    file: string,
    label: string,
    rpc: { id: unknown } | null,
  ): Promise<Response> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(
          `Fixture missing for ${label}; record with ENSMAP_FIXTURES=record`,
        );
      }
      throw error;
    }
    const { response } = StoredFixture.parse(JSON.parse(raw));
    let body: unknown = response.body;
    if (rpc !== null && isRecord(body) && 'id' in body) {
      body = { ...body, id: rpc.id };
    }
    const text =
      response.text ?? (body === undefined ? '' : JSON.stringify(body));
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async function record(
    file: string,
    request: Request,
    requestText: string,
  ): Promise<Response> {
    const response = await inner(request);
    const text = await response.text();
    const requestBody = parseJson(requestText);
    const responseBody = parseJson(text);
    const fixture = {
      request: {
        method: request.method,
        url: request.url,
        headers: savedHeaders(request.headers),
        ...(requestText === ''
          ? {}
          : { body: requestBody.ok ? requestBody.value : requestText }),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: savedHeaders(response.headers),
        ...(responseBody.ok ? { body: responseBody.value } : { text }),
      },
    };
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify(redactDeep(fixture, secrets), null, 2)}\n`,
    );
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const requestText = await request.clone().text();
    const url = redact(request.url, secrets);
    const key = createHash('sha256')
      .update(`${request.method}\n${url}\n${keyBody(requestText)}`)
      .digest('hex');
    const host = redact(new URL(request.url).hostname, secrets);
    const file = join(dir, host, `${key}.json`);

    return mode === 'replay'
      ? replay(file, `${request.method} ${url}`, requestId(requestText))
      : record(file, request, requestText);
  };
  return fixtureFetch;
}
