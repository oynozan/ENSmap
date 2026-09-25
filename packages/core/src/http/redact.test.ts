import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createHttpClient, ProviderError } from './client.ts';
import { CallCounter } from './counter.ts';
import { redact } from './redact.ts';

const SECRET_URL = 'https://mainnet.infura.io/v3/abc123?apikey=abc123';

function clientReturning(reply: () => Promise<Response>) {
  return createHttpClient({
    provider: 'rpc',
    limits: {
      concurrency: 1,
      minIntervalMs: 0,
      retries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      timeoutMs: 1000,
    },
    counter: new CallCounter(),
    secrets: ['abc123'],
    fetch: reply,
    sleep: () => Promise.resolve(),
  });
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

describe('redact', () => {
  it('removes every occurrence of a secret value', () => {
    const text = redact(
      'https://mainnet.infura.io/v3/abc123 and ?apikey=abc123',
      ['abc123'],
    );

    expect(text).not.toContain('abc123');
    expect(text).toBe(
      'https://mainnet.infura.io/v3/[redacted] and ?apikey=[redacted]',
    );
  });

  it('prefers the longest secret when secrets overlap', () => {
    expect(redact('key=abc123!', ['abc', 'abc123'])).toBe('key=[redacted]!');
  });

  it('ignores empty secrets', () => {
    expect(redact('hello', [''])).toBe('hello');
  });

  it('matches secrets literally, not as patterns', () => {
    expect(redact('axb a.b', ['a.b'])).toBe('axb [redacted]');
  });

  it('does not redact inside the replacement marker', () => {
    expect(redact('abc123', ['abc123', 'd'])).toBe('[redacted]');
  });
});

describe('ProviderError redaction', () => {
  it('keeps secrets in the request URL out of an HTTP error message', async () => {
    const http = clientReturning(() =>
      Promise.resolve(new Response('{"error":"abc123 bad"}', { status: 400 })),
    );

    const error = await rejectionOf(
      http.json({ method: 'GET', url: SECRET_URL }, z.unknown()),
    );

    expect(error.message).not.toContain('abc123');
    expect(error.message).toContain('mainnet.infura.io');
  });

  it('keeps secrets out of a network error message', async () => {
    const http = clientReturning(() =>
      Promise.reject(new TypeError(`fetch failed for ${SECRET_URL}`)),
    );

    const error = await rejectionOf(
      http.json({ method: 'GET', url: SECRET_URL }, z.unknown()),
    );

    expect(error.message).not.toContain('abc123');
  });
});
