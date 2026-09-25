import { describe, expect, it } from 'vitest';

describe('fixtures mode', () => {
  it('defaults ENSMAP_FIXTURES to replay via the shared vitest.setup.ts', () => {
    expect(process.env['ENSMAP_FIXTURES']).toBe('replay');
  });
});
