/**
 * Ask a provider whether a key is real, before anything is stored.
 *
 * Connecting used to fail at the worst possible moment: the key was saved, the
 * instance looked configured, and the first thing the user learned about a typo
 * was a dead turn. So the key is checked first and written only if it works.
 *
 * The check is a `GET` of the provider's model list — cheap, no tokens, and
 * meaningful, because listing models is exactly the authorisation this key needs
 * to have. A completion would cost money to learn the same thing.
 *
 * Three outcomes rather than a boolean. "That key was refused" and "nothing
 * answered at that address" send the user to completely different places, and a
 * local-server user will hit the second one constantly.
 *
 * @module agent/model/verifyCredential
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  CEREBRAS_BASE_URL,
  DEFAULT_LOCAL_BASE_URL,
  type BackendKind,
} from "./resolveLanguageModel.ts";

/** What a verification attempt concluded. */
export type ConnectOutcome =
  | { readonly _tag: "Ok"; readonly modelCount: number }
  | { readonly _tag: "Rejected"; readonly detail: string }
  | { readonly _tag: "Unreachable"; readonly detail: string };

/** Where to ask, and with which header. */
export interface CredentialProbe {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Build the probe for a backend.
 *
 * Anthropic is the odd one out — its own header and a required API version —
 * which is exactly why this is a function and not a base-URL string.
 */
export function probeFor(input: {
  readonly backend: BackendKind;
  readonly credential: Redacted.Redacted<string> | undefined;
  readonly baseUrl?: string | undefined;
}): CredentialProbe {
  const key = input.credential === undefined ? undefined : Redacted.value(input.credential);
  const bearer = key === undefined ? {} : { Authorization: `Bearer ${key}` };

  switch (input.backend) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/models",
        headers: {
          ...(key === undefined ? {} : { "x-api-key": key }),
          "anthropic-version": "2023-06-01",
        },
      };
    case "openai":
      return { url: "https://api.openai.com/v1/models", headers: bearer };
    case "openrouter":
      // NOT /models. OpenRouter serves its catalogue publicly — it answers 200
      // with no credential at all — so probing it accepts any string as a key
      // and the user only finds out on their first turn, which is the exact
      // failure this check exists to prevent. /key requires the credential.
      return { url: "https://openrouter.ai/api/v1/key", headers: bearer };
    case "cerebras":
      return { url: `${CEREBRAS_BASE_URL}/models`, headers: bearer };
    case "openai-compat": {
      // A local server authenticates nothing, so the key is genuinely optional
      // here and an absent one must not be sent as an empty bearer.
      const base = (input.baseUrl ?? DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
      return { url: `${base}/models`, headers: bearer };
    }
  }
}

/**
 * Turn an HTTP status into an outcome.
 *
 * 401 and 403 are the honest "your key is wrong". Everything else that is not a
 * success is still the provider talking, so it is reported as a rejection with
 * its status rather than pretending the network failed.
 */
export function outcomeForStatus(status: number, modelCount: number): ConnectOutcome {
  if (status >= 200 && status < 300) {
    return { _tag: "Ok", modelCount };
  }
  if (status === 401 || status === 403) {
    return { _tag: "Rejected", detail: "That key was refused. Check you copied all of it." };
  }
  if (status === 404) {
    return {
      _tag: "Unreachable",
      detail: "That address answered, but not with a model list. Check the server URL.",
    };
  }
  if (status === 429) {
    return { _tag: "Rejected", detail: "The provider is rate limiting this key right now." };
  }
  return { _tag: "Rejected", detail: `The provider answered with ${status}.` };
}

/** Count models leniently — the shape varies and a wrong count must not fail a good key. */
export function countModels(body: unknown): number {
  if (typeof body !== "object" || body === null) return 0;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Run the probe.
 *
 * Never fails: a transport error is an outcome, not an error channel, because
 * every caller has to render all three cases anyway.
 */
export const verifyCredential = Effect.fnUntraced(function* (input: {
  readonly backend: BackendKind;
  readonly credential: Redacted.Redacted<string> | undefined;
  readonly baseUrl?: string | undefined;
}) {
  const client = yield* HttpClient.HttpClient;
  const probe = probeFor(input);

  const attempt = yield* Effect.result(
    client
      .execute(HttpClientRequest.get(probe.url).pipe(HttpClientRequest.setHeaders(probe.headers)))
      .pipe(
        Effect.flatMap((response) => Effect.map(response.json, (body) => ({ response, body }))),
      ),
  );

  if (attempt._tag === "Failure") {
    return {
      _tag: "Unreachable",
      detail: "Could not reach that address. If this is a local server, check it is running.",
    } satisfies ConnectOutcome;
  }

  return outcomeForStatus(attempt.success.response.status, countModels(attempt.success.body));
});
