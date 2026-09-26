import { loadEnv } from '@ensmap/core/config';
import { describe, expect, it } from 'vitest';

import { listenOptions } from './listen.ts';

describe('listenOptions', () => {
  it('binds loopback on port 3100 by default', () => {
    expect(listenOptions(loadEnv({}))).toEqual({
      hostname: 'localhost',
      port: 3100,
    });
  });

  it('takes the port from ENSMAP_API_PORT', () => {
    expect(listenOptions(loadEnv({ ENSMAP_API_PORT: '4100' }))).toEqual({
      hostname: 'localhost',
      port: 4100,
    });
  });
});
