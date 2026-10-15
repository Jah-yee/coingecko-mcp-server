/**
 * @fileoverview Service-layer failure modes the CoinGecko service can surface,
 * plus a `recoveryFor` resolver. Service code can't reach `ctx.recoveryFor` (no
 * Context), so it spreads `recoveryFor(reason)` into the error factory's `data`
 * arg — the framework mirrors `data.recovery.hint` into the wire payload's
 * `content[]` text, so clients get the same actionable hint a handler-level
 * `ctx.fail` would carry.
 *
 * These reasons are upstream/transport failures shared across every tool
 * that calls the service. Domain-specific reasons (coin_not_found, all_missing,
 * unknown_category, invalid_range) are declared inline on the individual tools.
 * @module src/services/coingecko/error-contracts
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

/**
 * Failure modes the CoinGecko service layer surfaces. Tools spread these into
 * their own `errors[]` so the declared contract matches what reaches the wire.
 * Each entry is `thrownBy: 'service'` — no handler names these reasons in a
 * `ctx.fail`, so `error-contract-unthrown` skips them.
 */
export const COINGECKO_SERVICE_ERRORS = [
  {
    reason: 'rate_limited',
    code: JsonRpcErrorCode.RateLimited,
    when: 'CoinGecko returned HTTP 429 — the shared keyless pool is throttled, or the Demo-tier quota was hit.',
    recovery:
      'Honor CoinGecko Retry-After before retrying; if absent, wait before making another request.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_invalid_params',
    code: JsonRpcErrorCode.InvalidParams,
    when: 'CoinGecko rejected the request parameters with HTTP 400.',
    recovery:
      'Correct the named request parameter before calling again; verify currency codes and CoinGecko slugs.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_validation_failed',
    code: JsonRpcErrorCode.ValidationError,
    when: 'CoinGecko rejected request validation with HTTP 422.',
    recovery: 'Correct the rejected request values before calling again.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_unauthorized',
    code: JsonRpcErrorCode.Unauthorized,
    when: 'CoinGecko returned HTTP 401, including credential or historical-window restrictions.',
    recovery:
      'Check COINGECKO_API_KEY is a valid Demo key; for historical restrictions, narrow the requested window.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_forbidden',
    code: JsonRpcErrorCode.Forbidden,
    when: 'CoinGecko denied access with HTTP 402 or 403.',
    recovery:
      'Check the Demo key and account access; this public API endpoint cannot use a Pro key.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'CoinGecko returned HTTP 404 on an endpoint without a domain-specific missing result.',
    recovery: 'Verify the requested endpoint and identifiers before calling again.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_invalid_request',
    code: JsonRpcErrorCode.InvalidRequest,
    when: 'CoinGecko rejected the HTTP request with another permanent client status or redirect.',
    recovery: 'Check the request against CoinGecko endpoint requirements before calling again.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_conflict',
    code: JsonRpcErrorCode.Conflict,
    when: 'CoinGecko returned HTTP 409, 423, or 424.',
    recovery: 'Resolve the upstream request conflict before making another call.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_timeout',
    code: JsonRpcErrorCode.Timeout,
    when: 'A CoinGecko attempt timed out or returned HTTP 408, 425, or 504.',
    recovery:
      'Retry later or narrow the request; CoinGecko did not respond within the time budget.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'retry_deadline_exceeded',
    code: JsonRpcErrorCode.Timeout,
    when: 'The coin-detail request, conditional currency lookup, and their retries exceeded one 50-second deadline.',
    recovery: 'Retry later or request only the profile when market data is unnecessary.',
    thrownBy: 'service',
  },
  {
    reason: 'upstream_deadline',
    code: JsonRpcErrorCode.Timeout,
    when: 'An externally supplied deadline expired during the CoinGecko exchange.',
    recovery: 'Retry later with a fresh deadline or narrow the request.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_http_error',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CoinGecko returned permanent HTTP 501 Not Implemented.',
    recovery:
      'Use a supported CoinGecko endpoint; repeating this request cannot implement an unavailable operation.',
    retryable: false,
    thrownBy: 'service',
  },
  {
    reason: 'upstream_unreachable',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CoinGecko was unreachable or returned a transient 5xx/HTML error after all retry attempts.',
    recovery: 'Retry after a brief delay; CoinGecko was unreachable across all retry attempts.',
    retryable: true,
    thrownBy: 'service',
  },
  {
    reason: 'invalid_response',
    code: JsonRpcErrorCode.ServiceUnavailable,
    when: 'CoinGecko returned a body that could not be parsed as JSON.',
    recovery:
      'Retry the request; CoinGecko returned a malformed response that could not be parsed.',
    retryable: true,
    thrownBy: 'service',
  },
] as const;

export type CoinGeckoServiceReason = (typeof COINGECKO_SERVICE_ERRORS)[number]['reason'];

const REASON_TO_RECOVERY = new Map<CoinGeckoServiceReason, string>(
  COINGECKO_SERVICE_ERRORS.map((entry) => [entry.reason, entry.recovery]),
);

/**
 * Service-layer counterpart to `ctx.recoveryFor`. Returns `{ recovery: { hint } }`
 * for the contract reason, spread into the error factory's `data` so the wire
 * payload carries the same hint a handler-level `ctx.fail` would.
 *
 * @example
 *   throw serviceUnavailable(msg, { reason: 'upstream_unreachable', ...recoveryFor('upstream_unreachable') });
 */
export function recoveryFor(reason: CoinGeckoServiceReason): { recovery: { hint: string } } {
  const hint = REASON_TO_RECOVERY.get(reason);
  if (hint === undefined) {
    throw new Error(`recoveryFor: no recovery hint registered for reason "${reason}"`);
  }
  return { recovery: { hint } };
}
