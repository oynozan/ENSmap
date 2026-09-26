import {
  loadEnv,
  resolveNamespace,
  type NamespaceId,
} from '@ensmap/core/config';
import { parseNameInput, type NameLabelError } from '@ensmap/core/ens';
import { CallCounter } from '@ensmap/core/http';
import { NameNotFoundError, toNameMapJson } from '@ensmap/core/names';
import { loadNameMap } from '@ensmap/core/pipeline';
import { InvalidArgumentError, Option, type Command } from 'commander';

import { CliError } from '../errors.ts';
import { formatTree } from '../format/tree.ts';
import type { CliDeps, CliIO } from '../program.ts';

interface TreeOptions {
  namespace: NamespaceId;
  json?: boolean;
  maxNames?: number;
}

const NAMESPACES: NamespaceId[] = ['mainnet', 'sepolia-v2'];

function positiveInteger(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError('expected a positive integer');
  }
  return Number(value);
}

function invalidNameMessage(raw: string, errors: NameLabelError[]): string {
  const lines = errors.map(
    (error) =>
      `  label ${error.index + 1} ${JSON.stringify(error.label)}: ${error.reason}`,
  );
  return [`Invalid name ${JSON.stringify(raw)}:`, ...lines].join('\n');
}

async function runTree(
  rawName: string,
  options: TreeOptions,
  io: CliIO,
  deps: Partial<CliDeps>,
  counter: CallCounter,
): Promise<void> {
  const parsed = parseNameInput(rawName);
  if (!parsed.ok) {
    throw new CliError(invalidNameMessage(rawName, parsed.errors), 1);
  }
  const env = deps.env ?? loadEnv();
  const cfg = resolveNamespace(options.namespace, env);
  const fetchCap = options.maxNames ?? cfg.fetchCap;
  if (fetchCap > cfg.fetchCap) {
    throw new CliError(
      `--max-names must be at most ${cfg.fetchCap}, the per-map fetch cap`,
      1,
    );
  }

  let result;
  try {
    result = await loadNameMap(cfg, parsed.name, {
      env,
      counter,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.now,
      fetchCap,
    });
  } catch (error) {
    if (error instanceof NameNotFoundError) {
      throw new CliError(
        `Name not found in ${cfg.id} via ${cfg.nameSource.kind} (alias paths of shared registries are not indexed by name)`,
        2,
      );
    }
    throw error;
  }

  io.stdout(
    options.json === true
      ? `${JSON.stringify(toNameMapJson(result), null, 2)}\n`
      : formatTree(result),
  );
}

export function registerTree(
  program: Command,
  io: CliIO,
  deps: Partial<CliDeps>,
): void {
  program
    .command('tree')
    .description("print a name's subname tree with each name's wallet")
    .argument('<name>', 'ENS name, normalized with ENSIP-15')
    .addOption(
      new Option('-n, --namespace <namespace>', 'ENS namespace')
        .choices(NAMESPACES)
        .default('mainnet'),
    )
    .option('--json', 'print the name map as JSON')
    .option(
      '--max-names <n>',
      'stop the walk after this many names (default: the fetch cap)',
      positiveInteger,
    )
    .action(async (rawName: string, options: TreeOptions) => {
      const counter = new CallCounter();
      try {
        await runTree(rawName, options, io, deps, counter);
      } finally {
        io.stderr(`${counter.format()}\n`);
      }
    });
}
