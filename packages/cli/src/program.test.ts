import { describe, expect, it } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { runCli, type CliIO } from './program.ts';

function createIO(): CliIO & { output: string[]; errors: string[] } {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    stdout: (s: string) => output.push(s),
    stderr: (s: string) => errors.push(s),
  };
}

describe('runCli', () => {
  it('returns 0 and prints the package version for --version', async () => {
    const io = createIO();

    const code = await runCli(['--version'], io);

    expect(code).toBe(0);
    expect(io.output.join('')).toContain(pkg.version);
  });

  it('returns 0 and prints usage for --help', async () => {
    const io = createIO();

    const code = await runCli(['--help'], io);

    expect(code).toBe(0);
    expect(io.output.join('')).toContain('ensmap');
  });
});
