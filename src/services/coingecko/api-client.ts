/**
 * @fileoverview Low-level HTTP client for the CoinGecko REST API v3. Builds URLs,
 * attaches the optional Demo-tier API key header, and exposes single-attempt
 * fetch calls. Retry logic lives in `CoinGeckoService`.
 *
 * `fetchWithTimeout` throws a classified `McpError` on any non-OK status (it only
 * returns the `Response` when `response.ok`), so this client keys off the THROWN
 * error's code, not a status check on a response it never receives. It preserves
 * framework status/retry decisions and adds code-specific recovery. Examples:
 *   - 404 `{"error":"coin not found"}` → NotFound. `getJsonOrNull` swallows this to
 *     `null` so the calling tool can throw a typed `coin_not_found` /
 *     `unknown_category`; `getJson` rethrows it enriched.
 *   - 429 `{"status":{"error_code":429,...}}` → RateLimited (retryable). Enriched
 *     with the `rate_limited` reason + recovery hint so the contract reaches the wire.
 *   - 200 `{}` silent miss on /simple/price → NOT an error; passed through for the
 *     tool to diff requested-vs-returned ids.
 * @module src/services/coingecko/api-client
 */

import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  defaultIsTransient,
  fetchWithTimeout,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';

import { COINGECKO_SERVICE_ERRORS, recoveryFor } from './error-contracts.js';
import { COINGECKO_API_BASE } from './types.js';

const USER_AGENT = 'coingecko-mcp-server (+https://github.com/cyanheads/coingecko-mcp-server)';

export interface CoinGeckoApiClientConfig {
  /** Optional Demo API key → sent as x-cg-demo-api-key. */
  apiKey?: string;
  timeoutMs: number;
}

/** Query param values accepted by the client (joined/encoded internally). */
export type QueryValue = string | number | boolean | undefined;

/** Low-level HTTP client for CoinGecko. Single-attempt — retries live upstream. */
export class CoinGeckoApiClient {
  constructor(private readonly config: CoinGeckoApiClientConfig) {}

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const params = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
    }
    const qs = params.toString();
    return `${COINGECKO_API_BASE}${path}${qs ? `?${qs}` : ''}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (this.config.apiKey) headers['x-cg-demo-api-key'] = this.config.apiKey;
    return headers;
  }

  /**
   * GET a JSON endpoint. A non-OK status throws (via `fetchWithTimeout`) and is
   * rethrown here enriched with a contract `reason` + recovery hint. Use for
   * endpoints where any non-2xx is a genuine failure to surface.
   */
  async getJson<T>(
    operation: string,
    path: string,
    query: Record<string, QueryValue> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const response = await this.fetch(operation, path, query, signal);
    return this.parseJson<T>(response, path);
  }

  /**
   * GET a JSON endpoint, returning `null` on HTTP 404 instead of throwing. Used by
   * coin-detail, market-chart, and the category-filtered markets path so the tool
   * can throw its own typed reason (`coin_not_found` / `unknown_category`) with
   * slug-resolution recovery rather than a generic NotFound. Other non-OK statuses
   * still throw (enriched).
   */
  async getJsonOrNull<T>(
    operation: string,
    path: string,
    query: Record<string, QueryValue> | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T | null> {
    try {
      const response = await this.fetch(operation, path, query, signal, [404]);
      return await this.parseJson<T>(response, path);
    } catch (error: unknown) {
      if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound) return null;
      throw error;
    }
  }

  /**
   * Single fetch attempt. `fetchWithTimeout` throws a classified `McpError` on any
   * non-OK status; we enrich it with the contract `reason` + recovery so clients
   * get the same actionable hint a handler-level `ctx.fail` would carry. Raw
   * network failures map to `upstream_unreachable`; timeouts stay distinct.
   * `expectedStatuses` lists statuses the caller treats as an expected outcome —
   * they still throw unchanged but log at debug instead of error.
   */
  private async fetch(
    operation: string,
    path: string,
    query: Record<string, QueryValue> | undefined,
    signal: AbortSignal | undefined,
    expectedStatuses?: number[],
  ): Promise<Response> {
    const url = this.buildUrl(path, query);
    const ctx = requestContextService.createRequestContext({
      operation,
      additionalContext: { path },
    });
    try {
      return await fetchWithTimeout(url, this.config.timeoutMs, ctx, {
        headers: this.headers(),
        ...(signal && { signal }),
        ...(expectedStatuses && { expectedStatuses }),
      });
    } catch (error: unknown) {
      if (error instanceof McpError) throw this.enrich(error, path);
      const msg = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `CoinGecko request failed: ${msg}`,
        { reason: 'upstream_unreachable', path, ...recoveryFor('upstream_unreachable') },
        { cause: error },
      );
    }
  }

  /**
   * Attach a contract `reason` + recovery hint to a `fetchWithTimeout` error,
   * preserving its framework code, retry decision, captured body, and Retry-After.
   * Only confirmed JSON envelope messages become a bounded plain-text explanation.
   */
  private enrich(error: McpError, path: string): McpError {
    if (error.code === JsonRpcErrorCode.RequestCancelled) return error;
    const retryable = defaultIsTransient(error);
    const reason =
      error.data?.errorSource === 'FetchSignalTimeout'
        ? 'upstream_deadline'
        : error.code === JsonRpcErrorCode.ServiceUnavailable
          ? retryable
            ? 'upstream_unreachable'
            : 'upstream_http_error'
          : COINGECKO_SERVICE_ERRORS.find((entry) => entry.code === error.code)?.reason;
    if (!reason) return error;
    const body = error.data?.responseBody ?? error.data?.body;
    let explanation: string | undefined;
    let historyLimit = false;
    if (typeof body === 'string' && body.length <= 4096) {
      try {
        const envelope = JSON.parse(body);
        const status = envelope?.status ?? envelope?.error?.status;
        historyLimit = status?.error_code === 10012;
        const message =
          typeof envelope?.error === 'string' ? envelope.error : status?.error_message;
        if (typeof message === 'string') {
          // Bound first: sanitizing a diagnostic never scans an unbounded body.
          explanation = Array.from(message.slice(0, 300).replace(/<[^>]*>/g, ''))
            .map((char) =>
              char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '<' || char === '>'
                ? ' '
                : char,
            )
            .join('')
            .trim();
        }
      } catch {
        /* Opaque/HTML bodies remain diagnostics, never promoted as advice. */
      }
    }
    const data = {
      ...(error.data as Record<string, unknown> | undefined),
      path,
      reason,
      retryable,
      ...recoveryFor(reason),
      ...(historyLimit && {
        recovery: {
          hint: 'Request only the most recent 365 days; move the start date inside that window and retry the narrower range.',
        },
      }),
    };
    return new McpError(
      error.code,
      explanation ? `${error.message}. CoinGecko: ${explanation}` : error.message,
      data,
      { cause: error },
    );
  }

  /**
   * Parse a 2xx body as JSON. An HTML body on a 200 (an edge form of throttling /
   * an upstream error page) is reclassified as transient rather than a
   * non-retryable SerializationError.
   */
  private async parseJson<T>(response: Response, path: string): Promise<T> {
    const text = await response.text().catch((error: unknown) => {
      if (error instanceof McpError) throw this.enrich(error, path);
      throw error;
    });
    if (/^\s*<(!doctype\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'CoinGecko returned an HTML body instead of JSON — likely rate-limited.',
        { reason: 'upstream_unreachable', path, ...recoveryFor('upstream_unreachable') },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (error: unknown) {
      throw serviceUnavailable(
        'CoinGecko returned a non-JSON body.',
        { reason: 'invalid_response', path, ...recoveryFor('invalid_response') },
        { cause: error },
      );
    }
  }
}
