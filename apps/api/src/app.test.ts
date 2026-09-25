import { describe, expect, it } from 'vitest';

import { createApp } from './app.ts';

describe('createApp', () => {
  it('returns { ok: true } from GET /health', async () => {
    const app = createApp({});

    const res = await app.request('/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
