import type { Env } from '@ensmap/core/config';
import { Command, CommanderError } from 'commander';

import pkg from '../package.json' with { type: 'json' };

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

export class CliError extends Error {
  readonly exitCode: 1 | 2 | 3;

  constructor(message: string, exitCode: 1 | 2 | 3) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export async function runCli(
  argv: string[],
  io: CliIO,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- reserved for the tree/bonds/labels/map subcommands registered in later phases
  deps?: Partial<CliDeps>,
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

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      return error.exitCode;
    }
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    throw error;
  }
}
