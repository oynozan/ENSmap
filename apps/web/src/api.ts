import { ApiError, Graph } from '@ensmap/core/schema';

export type FetchGraphResult =
  { ok: true; graph: Graph } | { ok: false; message: string };

const LOOKUP_TIMEOUT_MS = 90_000;
// URL parsing drops "." and ".." as path segments, so they never reach the name route
const DOT_SEGMENT = /^\.{1,2}$/;

export const MESSAGES = {
  notFound: 'Name not found on the Sepolia ENSv2 Beta',
  providerError: 'A data source is unavailable. Try again shortly.',
  timeout: 'The lookup took too long. Try again.',
  unreachable: "Can't reach the ENSmap API",
  unexpected: 'Unexpected response from the ENSmap API',
  generic: 'Something went wrong',
} as const;

function graphUrl(name: string): string {
  return `/api/map/name/${encodeURIComponent(name)}?namespace=sepolia-v2`;
}

function failure(message: string): FetchGraphResult {
  return { ok: false, message };
}

function invalidName(label: { label: string; reason: string }): string {
  return `Invalid name: ${label.reason} (label "${label.label}")`;
}

// AbortSignal.any arrived in Safari 17.4, after the build target
function anySignal(signals: AbortSignal[]): AbortSignal {
  const native = (AbortSignal as { any?: typeof AbortSignal.any }).any;
  if (native !== undefined) return native.call(AbortSignal, signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener(
      'abort',
      () => {
        controller.abort(signal.reason);
      },
      { once: true, signal: controller.signal },
    );
  }
  return controller.signal;
}

// Read errors, aborts included, propagate while a non-JSON body becomes undefined
async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(status: number, body: unknown): string {
  const parsed = ApiError.safeParse(body);
  const error = parsed.success ? parsed.data.error : null;
  if (status === 404) {
    return MESSAGES.notFound;
  }
  const label = error?.code === 'invalid-name' ? error.labels?.[0] : undefined;
  if (status === 400 && label !== undefined) {
    return invalidName(label);
  }
  if (status === 502) {
    // A 502 without an API error body comes from a proxy whose API is down
    return error === null ? MESSAGES.unreachable : MESSAGES.providerError;
  }
  return MESSAGES.generic;
}

export async function fetchGraph(
  name: string,
  opts: { signal?: AbortSignal; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<FetchGraphResult> {
  if (DOT_SEGMENT.test(name)) {
    return failure(invalidName({ label: '', reason: 'empty label' }));
  }
  const fetchImpl = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? LOOKUP_TIMEOUT_MS);
  const signal =
    opts.signal === undefined ? timeout : anySignal([opts.signal, timeout]);

  try {
    const response = await fetchImpl(graphUrl(name), { signal });
    const body = await readJson(response);
    if (!response.ok) {
      return failure(errorMessage(response.status, body));
    }
    const graph = Graph.safeParse(body);
    return graph.success
      ? { ok: true, graph: graph.data }
      : failure(MESSAGES.unexpected);
  } catch (error) {
    if (opts.signal?.aborted === true) {
      throw error;
    }
    return failure(timeout.aborted ? MESSAGES.timeout : MESSAGES.unreachable);
  }
}
