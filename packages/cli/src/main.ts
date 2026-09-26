import process from 'node:process';

import { loadDotEnv } from '@ensmap/core/config';

import { runMain, type CliIO } from './program.ts';

const consoleIO: CliIO = {
  stdout: (s: string) => {
    process.stdout.write(s);
  },
  stderr: (s: string) => {
    process.stderr.write(s);
  },
};

loadDotEnv();
process.exitCode = await runMain(process.argv.slice(2), consoleIO);
