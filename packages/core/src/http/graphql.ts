import { z } from 'zod';

import { ProviderError, type Classifier, type HttpClient } from './client.ts';

const RATE_LIMIT = /rate-limit/i;
const BAD_INDEXERS = 'bad indexers:';
const STORE_ERROR = 'Store error';
// Query mistakes reported through `bad indexers`, which no retry can fix
const VALIDATION_PHRASE =
  /validation|has no field|cannot query field|unknown argument|unknown type|invalid value|syntax error|failed to parse/i;

const TopLevelMessage = z.object({ message: z.string() });
const GraphqlErrors = z.object({
  errors: z.array(z.object({ message: z.string() })).min(1),
});

function isTransient(message: string): boolean {
  return (
    message.startsWith(BAD_INDEXERS) &&
    !message.includes(STORE_ERROR) &&
    !VALIDATION_PHRASE.test(message)
  );
}

const graphqlClassifier: Classifier = (status, body) => {
  const topLevel = TopLevelMessage.safeParse(body);
  if (topLevel.success && RATE_LIMIT.test(topLevel.data.message)) {
    return new ProviderError(`rate limited: ${topLevel.data.message}`, {
      provider: '',
      status,
      retryable: true,
    });
  }
  const parsed = GraphqlErrors.safeParse(body);
  if (!parsed.success) {
    return null;
  }
  const messages = parsed.data.errors.map((error) => error.message);
  return new ProviderError(`GraphQL errors: ${messages.join('; ')}`, {
    provider: '',
    status,
    retryable: messages.every(isTransient),
  });
};

export async function graphqlRequest<T>(
  http: HttpClient,
  url: string,
  doc: string,
  variables: Record<string, unknown>,
  data: z.ZodType<T>,
  headers?: Record<string, string>,
): Promise<T> {
  const envelope = await http.json(
    {
      method: 'POST',
      url,
      headers,
      body: { query: doc, variables },
      classify: graphqlClassifier,
    },
    z.object({ data }),
  );
  return envelope.data;
}
