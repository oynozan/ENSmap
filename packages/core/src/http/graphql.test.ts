import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createHttpClient, ProviderError } from './client.ts';
import { CallCounter } from './counter.ts';
import { graphqlRequest } from './graphql.ts';

const ENDPOINT = 'https://api.example/subgraphs/name/ensdomains/ens';
const DOC = 'query Q($id: ID!) { domain(id: $id) { name } }';
const DATA = z.object({ domain: z.object({ name: z.string() }) });
const GOOD = { data: { domain: { name: 'ens.eth' } } };

function setup(bodies: unknown[]) {
  const calls: RequestInit[] = [];
  const fetch: typeof globalThis.fetch = (_input, init) => {
    calls.push(init ?? {});
    const body = bodies[Math.min(calls.length, bodies.length) - 1];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const http = createHttpClient({
    provider: 'ens-subgraph',
    limits: {
      concurrency: 1,
      minIntervalMs: 0,
      retries: 3,
      baseDelayMs: 1,
      maxDelayMs: 1,
      timeoutMs: 1000,
    },
    counter: new CallCounter(),
    secrets: [],
    fetch,
    sleep: () => Promise.resolve(),
  });
  return { http, calls };
}

function run(http: ReturnType<typeof setup>['http']) {
  return graphqlRequest(http, ENDPOINT, DOC, { id: '0x1' }, DATA);
}

async function rejectionOf(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('graphqlRequest', () => {
  it('posts the query and variables and returns the parsed data', async () => {
    const { http, calls } = setup([GOOD]);

    const data = await graphqlRequest(
      http,
      ENDPOINT,
      DOC,
      { id: '0x1' },
      DATA,
      { authorization: 'Bearer k' },
    );

    expect(data).toEqual({ domain: { name: 'ens.eth' } });
    expect(calls[0]?.method).toBe('POST');
    const sent = calls[0]?.body;
    expect(typeof sent).toBe('string');
    expect(JSON.parse(typeof sent === 'string' ? sent : '')).toEqual({
      query: DOC,
      variables: { id: '0x1' },
    });
    expect(new Headers(calls[0]?.headers).get('authorization')).toBe(
      'Bearer k',
    );
  });

  it('retries a 200 rate-limit message body', async () => {
    const { http, calls } = setup([
      { message: 'Rate-limit on ensdomains/ens community key exceeded' },
      GOOD,
    ]);

    await expect(run(http)).resolves.toEqual(GOOD.data);
    expect(calls).toHaveLength(2);
  });

  it('retries a transient bad indexers error', async () => {
    const { http, calls } = setup([
      { errors: [{ message: 'bad indexers: {0x1: Timeout}' }] },
      GOOD,
    ]);

    await expect(run(http)).resolves.toEqual(GOOD.data);
    expect(calls).toHaveLength(2);
  });

  it('treats a bad indexers Store error as fatal', async () => {
    const { http, calls } = setup([
      {
        errors: [
          {
            message:
              'bad indexers: {0x1: BadResponse(Store error: database unavailable)}',
          },
        ],
      },
    ]);

    const error = await rejectionOf(run(http));

    expect(error).toMatchObject({ provider: 'ens-subgraph', retryable: false });
    expect(error.message).toContain('Store error');
    expect(calls).toHaveLength(1);
  });

  it('treats a bad indexers query validation error as fatal', async () => {
    const { http, calls } = setup([
      {
        errors: [
          {
            message:
              'bad indexers: {0x1: BadResponse(Type `Query` has no field `nope`)}',
          },
        ],
      },
    ]);

    await rejectionOf(run(http));

    expect(calls).toHaveLength(1);
  });

  it('treats any other GraphQL error as fatal', async () => {
    const { http, calls } = setup([{ errors: [{ message: 'x' }] }]);

    const error = await rejectionOf(run(http));

    expect(error).toMatchObject({ retryable: false });
    expect(calls).toHaveLength(1);
  });

  it('treats a mix of bad indexers and other errors as fatal', async () => {
    const { http, calls } = setup([
      {
        errors: [
          { message: 'bad indexers: {0x1: Timeout}' },
          { message: 'something else' },
        ],
      },
    ]);

    await rejectionOf(run(http));

    expect(calls).toHaveLength(1);
  });

  it('ignores an empty errors array', async () => {
    const { http } = setup([{ ...GOOD, errors: [] }]);

    await expect(run(http)).resolves.toEqual(GOOD.data);
  });
});
