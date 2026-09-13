import { logger } from "../../lib/logger.js";
import type {
  UpstoxMarketDataFeedAuthorizeResponse,
  UpstoxQuote,
  UpstoxQuoteResponse,
} from "./types.js";

/** Single source of truth for the REST base URL (Bug #15). Paths are absolute (/v2/..., /v3/...). */
export const DEFAULT_UPSTOX_BASE_URL = "https://api.upstox.com";

export interface UpstoxClientOptions {
  /** Total attempts, including the first. Default 3. */
  maxRetries?: number;
  /** First retry delay in ms; doubles each attempt. Default 1000. */
  baseDelayMs?: number;
}

export class UpstoxClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly baseDelay: number;

  constructor(
    accessToken: string,
    baseUrl: string = DEFAULT_UPSTOX_BASE_URL,
    options: UpstoxClientOptions = {},
  ) {
    this.accessToken = accessToken;
    this.baseUrl = baseUrl;
    this.maxRetries = Math.max(1, options.maxRetries ?? 3);
    this.baseDelay = options.baseDelayMs ?? 1000;
  }

  /** Runs `operation` up to `maxRetries` times in total (Bug #16: was maxRetries + 1). */
  private async retryWithBackoff<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: Error = new Error(
      `${operationName} failed without error details`,
    );

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxRetries) {
          const delay = this.baseDelay * Math.pow(2, attempt - 1);
          logger.warn(`${operationName} failed, retrying in ${delay}ms`, {
            attempt,
            maxRetries: this.maxRetries,
            error: lastError.message,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    logger.error(`${operationName} failed after all retries`, {
      attempts: this.maxRetries,
      error: lastError.message,
    });
    throw lastError;
  }

  private authHeaders(
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      ...extra,
    };
  }

  async fetchQuote(instrumentKey: string): Promise<UpstoxQuote> {
    return this.retryWithBackoff(async () => {
      const url = new URL("/v2/market-quote/quotes", this.baseUrl);
      url.searchParams.set("instrument_key", instrumentKey);

      logger.info("Calling Upstox Full Market Quote API", {
        instrumentKey,
        url: url.toString(),
      });

      const response = await fetch(url, {
        headers: this.authHeaders({ "Content-Type": "application/json" }),
      });

      if (!response.ok) {
        throw new Error(
          `Upstox quote request failed with ${response.status} ${response.statusText}`,
        );
      }

      const payload = (await response.json()) as UpstoxQuoteResponse;
      if (payload.status !== "success") {
        throw new Error(
          `Upstox API returned non-success status: ${payload.status}`,
        );
      }

      // Upstox may key the response as "NSE_EQ|ISIN" or "NSE_EQ:ISIN"; fall back to instrument_token.
      const possibleKeys = [instrumentKey, instrumentKey.replace("|", ":")];
      let quote: UpstoxQuote | undefined;
      let foundKey: string | undefined;

      for (const key of possibleKeys) {
        if (payload.data?.[key]) {
          quote = payload.data[key];
          foundKey = key;
          break;
        }
      }
      if (!quote) {
        for (const [key, data] of Object.entries(payload.data ?? {})) {
          if (data.instrument_token === instrumentKey) {
            quote = data;
            foundKey = key;
            break;
          }
        }
      }
      if (!quote) {
        logger.error("No quote found in Upstox response", {
          instrumentKey,
          availableKeys: Object.keys(payload.data ?? {}),
          triedKeys: possibleKeys,
        });
        throw new Error(
          `No Upstox quote found for instrument ${instrumentKey}`,
        );
      }

      logger.info("Upstox quote received successfully", {
        instrumentKey,
        foundKey,
        symbol: quote.symbol,
        lastPrice: quote.last_price,
        volume: quote.volume,
      });
      return quote;
    }, `Upstox fetchQuote for ${instrumentKey}`);
  }

  async authorizeMarketDataFeed(): Promise<string> {
    return this.retryWithBackoff(async () => {
      const url = new URL("/v3/feed/market-data-feed/authorize", this.baseUrl);
      logger.info("Authorizing Upstox V3 market data feed", {
        url: url.toString(),
      });

      const response = await fetch(url, { headers: this.authHeaders() });
      if (!response.ok) {
        throw new Error(
          `Upstox feed authorize request failed with ${response.status} ${response.statusText}`,
        );
      }

      const payload =
        (await response.json()) as UpstoxMarketDataFeedAuthorizeResponse;
      if (payload.status !== "success") {
        throw new Error(
          `Upstox feed authorize returned non-success status: ${payload.status}`,
        );
      }

      const authorizedRedirectUri =
        payload.data?.authorized_redirect_uri?.trim();
      if (!authorizedRedirectUri) {
        throw new Error(
          "Upstox feed authorize response did not include authorized_redirect_uri",
        );
      }

      logger.info("Upstox V3 market data feed authorized successfully");
      return authorizedRedirectUri;
    }, "Upstox market data feed authorize");
  }
}

export function createUpstoxClientFromEnv(
  accessToken?: string | null,
  baseUrl?: string | null,
  options?: UpstoxClientOptions,
): UpstoxClient {
  const token = accessToken || process.env.UPSTOX_ACCESS_TOKEN;
  const url = baseUrl || process.env.UPSTOX_BASE_URL || DEFAULT_UPSTOX_BASE_URL;

  if (!token) {
    logger.error("Failed to create Upstox client", {
      reason: "Missing UPSTOX_ACCESS_TOKEN",
    });
    throw new Error("Missing UPSTOX_ACCESS_TOKEN");
  }

  logger.info("Upstox client created", { baseUrl: url });
  return new UpstoxClient(token, url, options);
}
