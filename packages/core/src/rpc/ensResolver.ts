import pLimit from 'p-limit';
import {
  BaseError,
  ContractFunctionRevertedError,
  zeroAddress,
  type PublicClient,
} from 'viem';

import {
  isResolvable,
  parseNameInput,
  type InterpretedName,
} from '../ens/names.ts';
import type { Address } from '../names/types.ts';
import { findProviderError } from './client.ts';

export interface Resolution {
  address: Address | null;
  resolver: Address | null;
  error: string | null;
}

export interface EnsResolver {
  resolve(
    names: readonly InterpretedName[],
    coinType?: bigint,
  ): Promise<Map<InterpretedName, Resolution>>;
  primaryNames(
    addresses: readonly Address[],
  ): Promise<Map<Address, InterpretedName | null>>;
}

// Universal Resolver reverts that mean "no value" rather than a failure
const NO_VALUE_REVERTS = new Set([
  'ResolverNotFound',
  'UnsupportedResolverProfile',
]);
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

type Outcome<T> = { value: T | null; error: string | null };

// A revert becomes an error string, a provider failure or anything else propagates
function revertOutcome(error: unknown): Outcome<never> {
  const providerError = findProviderError(error);
  if (providerError !== null) {
    throw providerError;
  }
  const revert =
    error instanceof BaseError
      ? error.walk((cause) => cause instanceof ContractFunctionRevertedError)
      : null;
  if (!(revert instanceof ContractFunctionRevertedError)) {
    throw error;
  }
  const errorName = revert.data?.errorName;
  if (errorName !== undefined && NO_VALUE_REVERTS.has(errorName)) {
    return { value: null, error: null };
  }
  return { value: null, error: errorName ?? 'reverted' };
}

function toAddress(raw: string): Address | null {
  const address = raw.toLowerCase();
  return address === zeroAddress ? null : (address as Address);
}

// Primary names must already be in normalized form, as ENSIP-15 clients require
function normalizedName(raw: string): InterpretedName | null {
  const parsed = parseNameInput(raw);
  return parsed.ok && parsed.name === raw && isResolvable(parsed.name)
    ? parsed.name
    : null;
}

export function createEnsResolver(
  client: PublicClient,
  opts: { concurrency: number },
): EnsResolver {
  const limit = pLimit(opts.concurrency);

  async function resolverOf(name: InterpretedName): Promise<Outcome<Address>> {
    try {
      const resolver = await client.getEnsResolver({ name });
      return { value: toAddress(resolver), error: null };
    } catch (error) {
      return revertOutcome(error);
    }
  }

  async function addressOf(
    name: InterpretedName,
    coinType: bigint,
  ): Promise<Outcome<Address>> {
    try {
      const raw = await client.getEnsAddress({ name, coinType, strict: true });
      if (raw === null) {
        return { value: null, error: null };
      }
      const address = toAddress(raw);
      // Offchain resolvers can return any bytes for an EVM coin type
      if (address !== null && !ADDRESS_PATTERN.test(address)) {
        return { value: null, error: 'invalid address' };
      }
      return { value: address, error: null };
    } catch (error) {
      return revertOutcome(error);
    }
  }

  async function resolveOne(
    name: InterpretedName,
    coinType: bigint,
  ): Promise<Resolution> {
    if (!isResolvable(name)) {
      return { address: null, resolver: null, error: 'unresolvable' };
    }
    const [resolver, address] = await limit(() =>
      Promise.all([resolverOf(name), addressOf(name, coinType)]),
    );
    return {
      address: address.value,
      resolver: resolver.value,
      error: address.error ?? resolver.error,
    };
  }

  async function primaryNameOf(
    address: Address,
  ): Promise<InterpretedName | null> {
    try {
      const raw = await limit(() =>
        client.getEnsName({ address, strict: true }),
      );
      return raw === null ? null : normalizedName(raw);
    } catch (error) {
      return revertOutcome(error).value;
    }
  }

  return {
    async resolve(names, coinType = 60n) {
      const entries = await Promise.all(
        [...new Set(names)].map(
          async (name) => [name, await resolveOne(name, coinType)] as const,
        ),
      );
      return new Map(entries);
    },

    async primaryNames(addresses) {
      const entries = await Promise.all(
        [...new Set(addresses)].map(
          async (address) => [address, await primaryNameOf(address)] as const,
        ),
      );
      return new Map(entries);
    },
  };
}
