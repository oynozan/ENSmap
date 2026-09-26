import { ProviderError } from '@ensmap/core/http';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import pkg from '../package.json' with { type: 'json' };
import { CliError, runCli, runMain, type CliIO } from './program.ts';

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

  it('returns 3 for a ProviderError and suggests GRAPH_API_KEY only for the subgraph', async () => {
    const failure = (provider: string) =>
      new ProviderError(`${provider}: HTTP 500`, {
        provider,
        status: 500,
        retryable: true,
      });
    const subgraphIO = createIO();
    const rpcIO = createIO();
    const spy = vi
      .spyOn(Command.prototype, 'parseAsync')
      .mockRejectedValueOnce(failure('ens-subgraph'))
      .mockRejectedValueOnce(failure('rpc'));

    const subgraphCode = await runCli([], subgraphIO);
    const rpcCode = await runCli([], rpcIO);

    spy.mockRestore();
    expect([subgraphCode, rpcCode]).toEqual([3, 3]);
    expect(subgraphIO.errors.join('')).toContain(
      'Provider ens-subgraph failed: ens-subgraph: HTTP 500',
    );
    expect(subgraphIO.errors.join('')).toContain('GRAPH_API_KEY');
    expect(rpcIO.errors.join('')).toContain('Provider rpc failed');
    expect(rpcIO.errors.join('')).not.toContain('GRAPH_API_KEY');
  });
});

describe('runMain', () => {
  it('prints an unexpected error with env secrets redacted and returns 1', async () => {
    const io = createIO();
    const spy = vi
      .spyOn(Command.prototype, 'parseAsync')
      .mockRejectedValueOnce(
        new Error('socket hang up at https://rpc.example/v2/s3cret-key'),
      );

    const code = await runMain(['tree', 'ens.eth'], io, {
      RPC_URL_1: 'https://rpc.example/v2/s3cret-key',
    });

    spy.mockRestore();
    expect(code).toBe(1);
    expect(io.errors.join('')).toBe(
      'socket hang up at https://rpc.example[redacted]\n',
    );
  });

  it('returns 1 and names only the key of an invalid env var', async () => {
    const io = createIO();

    const code = await runMain(['--version'], io, {
      RPC_URL_1: 'not a url s3cret',
    });

    expect(code).toBe(1);
    expect(io.errors.join('')).toContain('RPC_URL_1');
    expect(io.errors.join('')).not.toContain('s3cret');
  });

  it('passes a clean run through', async () => {
    const io = createIO();

    const code = await runMain(['--version'], io, {});

    expect(code).toBe(0);
    expect(io.output.join('')).toContain(pkg.version);
  });
});
