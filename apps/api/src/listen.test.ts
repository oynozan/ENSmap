import { loadEnv } from '@ensmap/core/config';
import { describe, expect, it } from 'vitest';

import { listenOptions } from './listen.ts';

describe('listenOptions', () => {
  it('binds loopback on port 3002 by default', () => {
    expect(listenOptions(loadEnv({}))).toEqual({
      hostname: 'localhost',
      port: 3002,
    });
  });

  it('takes the port from ENSMAP_API_PORT', () => {
    expect(listenOptions(loadEnv({ ENSMAP_API_PORT: '4100' }))).toEqual({
      hostname: 'localhost',
      port: 4100,
    });
  });
});
