import {
  BaseError,
  ccipRequest,
  createPublicClient,
  custom,
  RpcRequestError,
  type Chain,
  type PublicClient,
} from 'viem';
import { mainnet, sepolia } from 'viem/chains';
import { z } from 'zod';

import type { NamespaceConfig } from '../config/namespaces.ts';
import { ProviderError, type HttpClient } from '../http/client.ts';
import type { CallCounter } from '../http/counter.ts';
import { jsonRpcClassifier } from '../http/jsonrpc.ts';
import { redact } from '../http/redact.ts';

export interface RpcClientDeps {
  rpc: HttpClient;
  ccipLimit: <T>(fn: () => Promise<T>) => Promise<T>;
  counter: CallCounter;
}

const JsonRpcResponse = z
  .looseObject({
    error: z
      .object({
        code: z.number(),
        message: z.string().optional(),
        data: z.unknown().optional(),
      })
      .optional(),
  })
  .refine((body) => body.error !== undefined || 'result' in body, {
    message: 'JSON-RPC response has neither result nor error',
  });

export function createRpcClient(
  cfg: NamespaceConfig,
  deps: RpcClientDeps,
): PublicClient {
  const chain: Chain = cfg.chainId === 1 ? mainnet : sepolia;
  const { url, headers } = cfg.rpc;
  const redactedUrl = redact(url, cfg.secrets);
  let nextId = 0;

  async function request({
    method,
    params,
  }: {
    method: string;
    params?: unknown;
  }): Promise<unknown> {
    nextId += 1;
    const body = { jsonrpc: '2.0', id: nextId, method, params };
    const response = await deps.rpc.json(
      { method: 'POST', url, headers, body, classify: jsonRpcClassifier },
      JsonRpcResponse,
    );
    if (response.error !== undefined) {
      const { code, message, data } = response.error;
      throw new RpcRequestError({
        body,
        error: { code, message: message ?? 'no message', data },
        url: redactedUrl,
      });
    }
    return response['result'];
  }

  return createPublicClient({
    chain,
    // The shared HTTP client owns retries, viem would retry its wrapped errors 3 times
    transport: custom({ request }, { retryCount: 0 }),
    // Multicall batches depend on timing, which would break fixture keys
    batch: { multicall: false },
    ccipRead: {
      request: (parameters) =>
        deps.ccipLimit(() => {
          deps.counter.inc('ccip-gateway');
          const outer = parameters.requestOptions?.signal;
          const signal = AbortSignal.any([
            ...(outer ? [outer] : []),
            AbortSignal.timeout(cfg.ccipLimits.timeoutMs),
          ]);
          return ccipRequest({
            ...parameters,
            requestOptions: { ...parameters.requestOptions, signal },
          });
        }),
    },
  });
}

// viem wraps transport failures, so the ProviderError is found on the cause chain
export function findProviderError(error: unknown): ProviderError | null {
  if (error instanceof ProviderError) {
    return error;
  }
  if (!(error instanceof BaseError)) {
    return null;
  }
  const found = error.walk((cause) => cause instanceof ProviderError);
  return found instanceof ProviderError ? found : null;
}
