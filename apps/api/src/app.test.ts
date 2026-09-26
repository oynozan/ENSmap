import { loadEnv, type NamespaceId } from '@ensmap/core/config';
import { parseNameInput, type InterpretedName } from '@ensmap/core/ens';
import { ProviderError } from '@ensmap/core/http';
import { NameNotFoundError } from '@ensmap/core/names';
import { ApiError, Graph } from '@ensmap/core/schema';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';
import type { MapService } from './mapService.ts';

describe('createApp', () => {
  it('returns { ok: true } from GET /health', async () => {
    const app = createApp({});

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

/* GET /map/name/:name */

const ENV = loadEnv({ ALCHEMY_API_KEY: 's3cretkey' });

function name(raw: string): InterpretedName {
  const parsed = parseNameInput(raw);
  if (!parsed.ok) {
    throw new Error(`invalid test name ${raw}`);
  }
  return parsed.name;
}

function graphFor(namespace: NamespaceId, root: string): Graph {
  return {
    version: 1,
    nodes: [
      {
        id: '0xroot',
        kind: 'name',
        label: root,
        tags: [],
        size: { metric: 'subnamesHeld', value: 0 },
      },
    ],
    edges: [],
    meta: {
      namespace,
      root: '0xroot',
      computedAt: '2026-09-26T00:00:00.000Z',
      caps: { fetch: 1000 },
      filters: {},
      totals: { names: 1, indexed: { value: 1, exact: true }, wallets: 0 },
      truncated: [],
      warnings: [],
    },
  };
}

function setup(failure?: Error) {
  const calls: [NamespaceId, string][] = [];
  const lines: string[] = [];
  const maps: MapService = {
    nameMap(namespace, root) {
      calls.push([namespace, root]);
      return failure === undefined
        ? Promise.resolve(graphFor(namespace, root))
        : Promise.reject(failure);
    },
  };
  const app = createApp({
    env: ENV,
    maps,
    log: (line) => lines.push(line),
  });
  return { app, calls, lines };
}

async function errorOf(res: Response) {
  const text = await res.text();
  return { text, body: ApiError.parse(JSON.parse(text)) };
}

describe('GET /map/name/:name', () => {
  it('normalizes the name and returns the graph', async () => {
    const { app, calls } = setup();

    const res = await app.request(
      '/map/name/Seller-A.eth?namespace=sepolia-v2',
    );

    expect(res.status).toBe(200);
    const graph = Graph.parse(await res.json());
    expect(graph.nodes[0]?.label).toBe('seller-a.eth');
    expect(calls).toEqual([['sepolia-v2', 'seller-a.eth']]);
  });

  it('decodes a percent-encoded name', async () => {
    const { app, calls } = setup();

    const res = await app.request(
      '/map/name/%E2%9D%A4.eth?namespace=sepolia-v2',
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([['sepolia-v2', '❤.eth']]);
  });

  it('defaults to mainnet', async () => {
    const { app, calls } = setup();

    const res = await app.request('/map/name/gloomy.eth');

    expect(res.status).toBe(200);
    expect(calls).toEqual([['mainnet', 'gloomy.eth']]);
  });

  it('rejects an unknown namespace without echoing it', async () => {
    const { app, calls } = setup();

    const res = await app.request('/map/name/gloomy.eth?namespace=holesky');

    expect(res.status).toBe(400);
    const { text, body } = await errorOf(res);
    expect(body.error.code).toBe('invalid-namespace');
    expect(body.error.message).toBe(
      'Unknown namespace; use mainnet or sepolia-v2',
    );
    expect(text).not.toContain('holesky');
    expect(calls).toEqual([]);
  });

  it('rejects an invalid name with its per-label reasons', async () => {
    const { app, calls } = setup();

    const res = await app.request('/map/name/a_b.eth');

    expect(res.status).toBe(400);
    const { body } = await errorOf(res);
    expect(body.error.code).toBe('invalid-name');
    expect(body.error.message).toBe('Invalid name');
    expect(body.error.labels).toEqual([
      { index: 0, label: 'a_b', reason: 'underscore allowed only at start' },
    ]);
    expect(calls).toEqual([]);
  });

  it('maps NameNotFoundError to 404 not-found', async () => {
    const { app } = setup(new NameNotFoundError(name('nope.eth')));

    const res = await app.request('/map/name/nope.eth?namespace=sepolia-v2');

    expect(res.status).toBe(404);
    const { body } = await errorOf(res);
    expect(body.error.code).toBe('not-found');
    expect(body.error.message).toBe(
      'Name not found (alias paths of shared registries are not indexed by name)',
    );
  });

  it('maps ProviderError to 502 and redacts the secret', async () => {
    const { app } = setup(
      new ProviderError('rpc down at https://x/v2/s3cretkey', {
        provider: 'rpc',
        status: 500,
        retryable: true,
      }),
    );

    const res = await app.request('/map/name/gloomy.eth?namespace=sepolia-v2');

    expect(res.status).toBe(502);
    const { text, body } = await errorOf(res);
    expect(body.error.code).toBe('provider-error');
    expect(body.error.message).toBe(
      'Provider rpc failed: rpc down at https://x/v2/[redacted]',
    );
    expect(text).not.toContain('s3cretkey');
  });

  it('maps any other error to a generic 500 and logs it redacted', async () => {
    const { app, lines } = setup(new Error('boom s3cretkey'));

    const res = await app.request('/map/name/gloomy.eth?namespace=sepolia-v2');

    expect(res.status).toBe(500);
    const { text, body } = await errorOf(res);
    expect(body.error).toEqual({ code: 'internal', message: 'Internal error' });
    expect(text).not.toContain('boom');
    expect(text).not.toContain('s3cretkey');
    expect(lines.join('\n')).toContain('boom [redacted]');
    expect(lines.join('\n')).not.toContain('s3cretkey');
  });
});
