import { z } from 'zod';

import { ProviderError, type Classifier } from './client.ts';

// EIP-1474 "limit exceeded" plus the rate-limit codes RPC providers send
const RETRYABLE_CODES = new Set([-32005, 429, -32007]);

const JsonRpcErrorBody = z.object({
  error: z.object({ code: z.number(), message: z.string().optional() }),
});

export const jsonRpcClassifier: Classifier = (status, body) => {
  const parsed = JsonRpcErrorBody.safeParse(body);
  if (!parsed.success || !RETRYABLE_CODES.has(parsed.data.error.code)) {
    return null;
  }
  const { code, message } = parsed.data.error;
  return new ProviderError(
    `JSON-RPC error ${code}: ${message ?? 'no message'}`,
    {
      provider: '',
      status,
      retryable: true,
    },
  );
};
