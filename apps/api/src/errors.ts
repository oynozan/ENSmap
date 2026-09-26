import type { NameLabelError } from '@ensmap/core/ens';
import { ProviderError, redact } from '@ensmap/core/http';
import { NameNotFoundError } from '@ensmap/core/names';
import type { ApiError, ApiErrorCode } from '@ensmap/core/schema';

// The CLI's not-found text without its namespace and source, which the error does not carry
const NOT_FOUND_MESSAGE =
  'Name not found (alias paths of shared registries are not indexed by name)';

export function apiError(
  code: ApiErrorCode,
  message: string,
  secrets: readonly string[],
  labels?: readonly NameLabelError[],
): ApiError {
  return {
    error: {
      code,
      message: redact(message, secrets),
      ...(labels === undefined
        ? {}
        : {
            labels: labels.map((label) => ({
              index: label.index,
              label: redact(label.label, secrets),
              reason: redact(label.reason, secrets),
            })),
          }),
    },
  };
}

export function toErrorResponse(
  error: unknown,
  secrets: readonly string[],
): { status: 404 | 500 | 502; body: ApiError } {
  if (error instanceof NameNotFoundError) {
    return {
      status: 404,
      body: apiError('not-found', NOT_FOUND_MESSAGE, secrets),
    };
  }
  if (error instanceof ProviderError) {
    return {
      status: 502,
      body: apiError(
        'provider-error',
        `Provider ${error.provider} failed: ${error.message}`,
        secrets,
      ),
    };
  }
  return { status: 500, body: apiError('internal', 'Internal error', secrets) };
}
