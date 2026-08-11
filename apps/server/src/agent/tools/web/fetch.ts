/**
 * Fetch a URL for the agent to read.
 *
 * Documentation, error pages, changelogs — the things a task points at that
 * are not in the repository. HTML comes back stripped to readable text, since
 * markup is token spend the model gains nothing from. The tool is gated behind
 * the same approval flow as `bash`: what the user is asked about is the URL.
 *
 * @module agent/tools/web/fetch
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { toolFailure, ToolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { optionalParam } from "../optionalParam.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
/** Refused outright above this, before the body is decoded. */
const MAX_RESPONSE_BYTES = 5_000_000;
/** What actually reaches the model. Same discipline as bash output. */
const MAX_CONTENT_BYTES = 50_000;

const WebFetchTool = Tool.make("webfetch", {
  description:
    "Fetch a URL and return its content as readable text. HTML is stripped to text; " +
    "everything else comes back as-is. A non-2xx response still returns its body — " +
    "an error page usually says what went wrong.",
  parameters: Schema.Struct({
    url: Schema.String.annotate({ description: "Must start with http:// or https://." }),
    timeoutMs: optionalParam(
      Schema.Number.annotate({
        description: `Defaults to ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    content: Schema.String,
    contentType: Schema.String,
    status: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeWebFetchTool(context: AgentToolContext): AgentTool {
  return defineTool(
    WebFetchTool,
    Effect.fnUntraced(function* (params) {
      if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
        return yield* toolFailure(`Not an http(s) URL: ${params.url}`);
      }
      const timeout = clampTimeout(params.timeoutMs);

      const response = yield* context.httpClient
        .get(params.url, {
          headers: {
            // A few sites answer bare bot agents with a block page; a browser
            // string gets the content the user could see themselves.
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
          },
        })
        .pipe(
          Effect.timeout(Duration.millis(timeout)),
          Effect.catchTag("TimeoutError", () =>
            toolFailure(`No response from ${params.url} within ${timeout} ms.`),
          ),
          Effect.catchTag("HttpClientError", (error) =>
            toolFailure(`Could not fetch ${params.url}: ${error.reason._tag}`),
          ),
        );

      const declaredLength = Number(response.headers["content-length"] ?? "0");
      if (declaredLength > MAX_RESPONSE_BYTES) {
        return yield* toolFailure(
          `${params.url} is ${declaredLength} bytes — over the ${MAX_RESPONSE_BYTES} byte limit.`,
        );
      }

      const body = yield* response.text.pipe(
        Effect.catchTag("HttpClientError", (error) =>
          toolFailure(`Could not read the response body: ${error.reason._tag}`),
        ),
      );
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        return yield* toolFailure(
          `${params.url} sent more than ${MAX_RESPONSE_BYTES} bytes — refusing to process it.`,
        );
      }

      const contentType = (response.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      const readable = contentType === "text/html" ? htmlToText(body) : body;
      const capped = capBytes(readable, MAX_CONTENT_BYTES);

      return {
        content: capped.text,
        contentType,
        status: response.status,
        truncated: capped.truncated,
      };
    }),
  );
}

function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), MAX_TIMEOUT_MS);
}

function capBytes(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }
  let cut = text.slice(0, limit);
  while (Buffer.byteLength(cut, "utf8") > limit) {
    cut = cut.slice(0, -1_000);
  }
  return { text: `${cut}\n… content truncated …`, truncated: true };
}

/**
 * HTML to readable text, without an HTML parser.
 *
 * A real parser handles adversarial markup; this handles documentation pages,
 * which is what the tool is for. Scripts, styles and comments are removed
 * whole, block boundaries become line breaks, and the common entities are
 * decoded. What survives of a broken page is still text, just messier.
 */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|template)[\s\S]*?<\/\1\s*>/gi, " ");
  const withBreaks = withoutBlocks
    .replace(/<\/(p|div|section|article|main|li|tr|h[1-6]|blockquote|pre|table|ul|ol)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?\s*>/gi, "\n");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return decodeEntities(stripped)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1]?.toLowerCase() === "x";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid =
        Number.isFinite(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}
