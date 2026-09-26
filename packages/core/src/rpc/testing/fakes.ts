import { isResolvable, type InterpretedName } from '../../ens/names.ts';
import type { Address } from '../../names/types.ts';
import type { ChainReader } from '../chainReader.ts';
import type { EnsResolver, Resolution } from '../ensResolver.ts';

export interface FakeEnsResolverOptions {
  // Keyed by name, a missing name resolves to no address, resolver or error
  resolutions?: Readonly<Record<string, Partial<Resolution>>>;
  // Keyed by lowercase address, a missing address has no primary name
  primaryNames?: Readonly<Record<string, string | null>>;
}

export type FakeEnsCall =
  | { method: 'resolve'; names: InterpretedName[]; coinType: bigint }
  | { method: 'primaryNames'; addresses: Address[] };

export interface FakeEnsResolver extends EnsResolver {
  readonly calls: FakeEnsCall[];
}

export function createFakeEnsResolver(
  options: FakeEnsResolverOptions = {},
): FakeEnsResolver {
  const calls: FakeEnsCall[] = [];

  function resolveOne(name: InterpretedName): Resolution {
    if (!isResolvable(name)) {
      return { address: null, resolver: null, error: 'unresolvable' };
    }
    const found = options.resolutions?.[name] ?? {};
    return {
      address: found.address ?? null,
      resolver: found.resolver ?? null,
      error: found.error ?? null,
    };
  }

  return {
    calls,

    resolve(names, coinType = 60n) {
      calls.push({ method: 'resolve', names: [...names], coinType });
      return Promise.resolve(
        new Map(names.map((name) => [name, resolveOne(name)])),
      );
    },

    primaryNames(addresses) {
      calls.push({ method: 'primaryNames', addresses: [...addresses] });
      return Promise.resolve(
        new Map(
          addresses.map((address) => [
            address,
            (options.primaryNames?.[address] ?? null) as InterpretedName | null,
          ]),
        ),
      );
    },
  };
}

export interface FakeChainReaderOptions {
  blockTimes?: ReadonlyMap<bigint, Date>;
  // Blocks left out of the times, with their skip reason
  skipped?: ReadonlyMap<bigint, string>;
}

export interface FakeChainCall {
  method: 'blockTimestamps';
  blocks: bigint[];
}

export interface FakeChainReader extends ChainReader {
  readonly calls: FakeChainCall[];
}

export function createFakeChainReader(
  options: FakeChainReaderOptions = {},
): FakeChainReader {
  const calls: FakeChainCall[] = [];

  return {
    calls,

    blockTimestamps(blocks) {
      calls.push({ method: 'blockTimestamps', blocks: [...blocks] });
      const times = new Map<bigint, Date>();
      const skipped = new Map<bigint, string>();
      for (const block of blocks) {
        const time = options.blockTimes?.get(block);
        const reason = options.skipped?.get(block);
        if (time !== undefined) {
          times.set(block, time);
        } else if (reason !== undefined) {
          skipped.set(block, reason);
        } else {
          return Promise.reject(new Error(`fake chain has no block ${block}`));
        }
      }
      return Promise.resolve({ times, skipped });
    },
  };
}
