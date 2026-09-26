import pLimit from 'p-limit';
import {
  BaseError,
  BlockNotFoundError,
  RpcRequestError,
  type PublicClient,
} from 'viem';

import { findProviderError } from './client.ts';

export interface ChainReader {
  // Blocks the RPC cannot serve, such as pruned history, are left out
  blockTimestamps(blocks: readonly bigint[]): Promise<Map<bigint, Date>>;
}

function isMissingBlock(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk(
      (cause) =>
        cause instanceof RpcRequestError || cause instanceof BlockNotFoundError,
    ) !== null
  );
}

export function createChainReader(
  client: PublicClient,
  opts: { concurrency: number },
): ChainReader {
  const limit = pLimit(opts.concurrency);

  async function timestampOf(blockNumber: bigint): Promise<Date | null> {
    try {
      const block = await limit(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000);
    } catch (error) {
      const providerError = findProviderError(error);
      if (providerError !== null) {
        throw providerError;
      }
      if (isMissingBlock(error)) {
        return null;
      }
      throw error;
    }
  }

  return {
    async blockTimestamps(blocks) {
      const entries = await Promise.all(
        [...new Set(blocks)].map(
          async (block) => [block, await timestampOf(block)] as const,
        ),
      );
      return new Map(
        entries.flatMap(([block, time]) =>
          time === null ? [] : [[block, time] as const],
        ),
      );
    },
  };
}
