/**
 * Which provider failures are worth a silent retry, and how to pace them.
 *
 * A dropped connection, a 429, or a provider 500 says nothing about the
 * request; failing the turn over one hands the user an error a resend fixes.
 * Everything else is excluded deliberately — an invalid request repeated is
 * the same invalid request, and an unreadable response has its own recovery
 * path in `runTurn` that tells the model what went wrong instead of paying to
 * hear it again.
 *
 * @module agent/loop/transientRetry
 */
import * as Duration from "effect/Duration";
import * as Schedule from "effect/Schedule";
import type * as AiError from "effect/unstable/ai/AiError";

/** Attempts after the first: delays of roughly 0.5s, 1s, 2s, then give up. */
export const MAX_TRANSIENT_RETRIES = 3;
export const DEFAULT_RETRY_BASE_MILLIS = 500;

export function isTransientProviderFailure(error: AiError.AiError): boolean {
  switch (error.cause._tag) {
    case "NetworkError":
    case "RateLimitError":
    case "InternalProviderError":
      return true;
    default:
      return false;
  }
}

/** Jittered so a fleet of threads rate-limited together does not return together. */
export const transientRetrySchedule = (baseDelayMillis: number) =>
  Schedule.jittered(Schedule.exponential(Duration.millis(baseDelayMillis), 2));
