import pLimit from 'p-limit';
import {
  BaseError,
  BlockNotFoundError,
  RpcRequestError,
  type PublicClient,
} from 'viem';

import { findProviderError } from './client.ts';

export interface BlockTimes {
  times: Map<bigint, Date>;
  // Why each block left out of times was skipped
  skipped: Map<bigint, string>;
}

export interface ChainReader {
  // Blocks the RPC cannot serve, such as pruned history, are skipped
  blockTimestamps(blocks: readonly bigint[]): Promise<BlockTimes>;
}

// Clients word expired history differently under the generic server error code
const PRUNED_MESSAGE = /prun|history (is )?(unavailable|expired)/i;

function skipReason(error: unknown): string | null {
  if (!(error instanceof BaseError)) {
    return null;
  }
  const found = error.walk(
    (cause) =>
      cause instanceof RpcRequestError || cause instanceof BlockNotFoundError,
  );
  if (found instanceof BlockNotFoundError) {
    return 'block not found';
  }
  if (
    found instanceof RpcRequestError &&
    (found.code === 4444 ||
      (found.code === -32000 && PRUNED_MESSAGE.test(found.details)))
  ) {
    return `RPC error ${found.code}: ${found.details}`;
  }
  return null;
}

export function createChainReader(
  client: PublicClient,
  opts: { concurrency: number },
): ChainReader {
  const limit = pLimit(opts.concurrency);

  async function timestampOf(blockNumber: bigint): Promise<Date | string> {
    try {
      const block = await limit(() => client.getBlock({ blockNumber }));
      return new Date(Number(block.timestamp) * 1000);
    } catch (error) {
      const providerError = findProviderError(error);
      if (providerError !== null) {
        throw providerError;
      }
      const reason = skipReason(error);
      if (reason === null) {
        throw error;
      }
      return reason;
    }
  }

  return {
    async blockTimestamps(blocks) {
      const entries = await Promise.all(
        [...new Set(blocks)].map(
          async (block) => [block, await timestampOf(block)] as const,
        ),
      );
      const times = new Map<bigint, Date>();
      const skipped = new Map<bigint, string>();
      for (const [block, outcome] of entries) {
        if (outcome instanceof Date) {
          times.set(block, outcome);
        } else {
          skipped.set(block, outcome);
        }
      }
      return { times, skipped };
    },
  };
}
