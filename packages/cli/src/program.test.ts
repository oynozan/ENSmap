import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { CliError, runCli, type CliIO } from './program.ts';

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

  it('writes the CliError message to stderr and returns its exit code', async () => {
    const io = createIO();
    const spy = vi
      .spyOn(Command.prototype, 'parseAsync')
      .mockRejectedValueOnce(new CliError('boom', 2));

    const code = await runCli([], io);

    spy.mockRestore();
    expect(code).toBe(2);
    expect(io.errors.join('')).toContain('boom');
  });

  it('returns 1 and prints the unknown option message for an unrecognized flag', async () => {
    const io = createIO();

    const code = await runCli(['--bogus'], io);

    expect(code).toBe(1);
    expect(io.errors.join('')).toContain('unknown option');
  });
});
