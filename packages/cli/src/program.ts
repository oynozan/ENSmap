import { envSecrets, loadEnv, type Env } from '@ensmap/core/config';
import { ProviderError, redact } from '@ensmap/core/http';
import { Command, CommanderError } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { registerTree } from './commands/tree.ts';
import { CliError } from './errors.ts';

export { CliError };

export interface CliIO {
  stdout(s: string): void;
  stderr(s: string): void;
}

export interface CliDeps {
  env: Env;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

// ProviderError messages are redacted where the HTTP client builds them
function providerFailure(error: ProviderError): string {
  const lines = [`Provider ${error.provider} failed: ${error.message}`];
  if (error.provider === 'ens-subgraph') {
    lines.push(
      'Set GRAPH_API_KEY to query The Graph gateway with higher limits, or check the key if it is set.',
    );
  }
  return lines.join('\n');
}

export async function runCli(
  argv: string[],
  io: CliIO,
  deps: Partial<CliDeps> = {},
): Promise<number> {
  const program = new Command();
  program
    .name('ensmap')
    .version(pkg.version)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => {
        io.stdout(s);
      },
      writeErr: (s) => {
        io.stderr(s);
      },
    });
  // Subcommands copy exitOverride and configureOutput only when created
  registerTree(program, io, deps);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(`${error.message}\n`);
      return error.exitCode;
    }
    if (error instanceof ProviderError) {
      io.stderr(`${providerFailure(error)}\n`);
      return 3;
    }
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}

// Anything runCli does not map is unexpected, and its message may carry a secret
export async function runMain(
  argv: string[],
  io: CliIO,
  source: Record<string, string | undefined> = process.env,
): Promise<number> {
  let secrets: string[] = [];
  try {
    const env = loadEnv(source);
    secrets = envSecrets(env);
    return await runCli(argv, io, { env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`${redact(message, secrets)}\n`);
    return 1;
  }
}
