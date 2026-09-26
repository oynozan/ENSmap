import pLimit from 'p-limit';
import type { PublicClient } from 'viem';

import { findProviderError } from './client.ts';

export interface ChainReader {
  blockTimestamps(blocks: readonly bigint[]): Promise<Map<bigint, Date>>;
}

export function createChainReader(
  client: PublicClient,
  opts: { concurrency: number },
): ChainReader {
  const limit = pLimit(opts.concurrency);

  async function timestampOf(blockNumber: bigint): Promise<Date> {
    try {
      const block = await limit(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000);
    } catch (error) {
      throw findProviderError(error) ?? error;
    }
  }

  return {
    async blockTimestamps(blocks) {
      const entries = await Promise.all(
        [...new Set(blocks)].map(
          async (block) => [block, await timestampOf(block)] as const,
        ),
      );
      return new Map(entries);
    },
  };
}
