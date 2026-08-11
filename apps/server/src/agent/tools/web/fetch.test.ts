// @effect-diagnostics nodeBuiltinImport:off
/**
 * Fetching a page for the agent to read.
 *
 * Runs against a real local HTTP server rather than a stubbed client: what the
 * tool promises — readable text out of whatever a server actually sends — is
 * exactly the part a stub would skip.
 */
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

import type { AgentToolContext } from "../registry.ts";
import { htmlToText, makeWebFetchTool } from "./fetch.ts";

interface FetchResult {
  readonly content: string;
  readonly contentType: string;
  readonly status: number;
  readonly truncated: boolean;
}

type Route = (response: NodeHttp.ServerResponse) => void;

function startServer(routes: Record<string, Route>): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const server = NodeHttp.createServer((request, response) => {
    const route = routes[request.url ?? "/"];
    if (route === undefined) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("no such route");
      return;
    }
    route(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as NodeNet.AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

const runFetch = (url: string, params: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const context = {
      workspaceRoot: "/",
      fileSystem: {} as AgentToolContext["fileSystem"],
      spawner: {} as AgentToolContext["spawner"],
      httpClient,
      commandEnv: {},
      requestApproval: () => Effect.succeed({ _tag: "Allowed" as const }),
    } satisfies AgentToolContext;

    const handler = makeWebFetchTool(context).handler as unknown as (
      params: Record<string, unknown>,
      handlerContext: Record<string, unknown>,
    ) => Effect.Effect<FetchResult, { readonly message: string }>;

    return yield* Effect.result(handler({ url, ...params }, {}));
  }).pipe(Effect.provide(FetchHttpClient.layer));

describe("webfetch", () => {
  it.effect("returns plain text as it came", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() =>
        startServer({
          "/readme": (response) => {
            response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            response.end("Install with `npm i thing`.");
          },
        }),
      );
      const outcome = yield* runFetch(`${server.baseUrl}/readme`);
      yield* Effect.promise(server.close);

      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") return;
      assert.strictEqual(outcome.success.content, "Install with `npm i thing`.");
      assert.strictEqual(outcome.success.contentType, "text/plain");
      assert.strictEqual(outcome.success.status, 200);
      assert.isFalse(outcome.success.truncated);
    }),
  );

  it.effect("strips HTML to readable text", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() =>
        startServer({
          "/docs": (response) => {
            response.writeHead(200, { "content-type": "text/html" });
            response.end(
              "<html><head><title>ignored</title></head><body>" +
                "<script>alert('never this')</script>" +
                "<h1>Getting started</h1><p>Use &quot;quotes&quot; &amp; entities.</p>" +
                "</body></html>",
            );
          },
        }),
      );
      const outcome = yield* runFetch(`${server.baseUrl}/docs`);
      yield* Effect.promise(server.close);

      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") return;
      assert.include(outcome.success.content, "Getting started");
      assert.include(outcome.success.content, 'Use "quotes" & entities.');
      assert.notInclude(outcome.success.content, "alert");
      assert.notInclude(outcome.success.content, "<h1>");
    }),
  );

  it.effect("hands back an error page instead of hiding it behind a failure", () =>
    Effect.gen(function* () {
      // A 404 body usually says what went wrong; the agent should see it.
      const server = yield* Effect.promise(() => startServer({}));
      const outcome = yield* runFetch(`${server.baseUrl}/missing`);
      yield* Effect.promise(server.close);

      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") return;
      assert.strictEqual(outcome.success.status, 404);
      assert.include(outcome.success.content, "no such route");
    }),
  );

  it.effect("refuses anything that is not http", () =>
    Effect.gen(function* () {
      const outcome = yield* runFetch("file:///etc/passwd");
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );

  it.effect("caps what reaches the model and says it did", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() =>
        startServer({
          "/huge": (response) => {
            response.writeHead(200, { "content-type": "text/plain" });
            response.end("x".repeat(200_000));
          },
        }),
      );
      const outcome = yield* runFetch(`${server.baseUrl}/huge`);
      yield* Effect.promise(server.close);

      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") return;
      assert.isTrue(outcome.success.truncated);
      assert.isBelow(outcome.success.content.length, 60_000);
    }),
  );

  it.live("gives up on a server that never answers", () =>
    Effect.gen(function* () {
      const server = yield* Effect.promise(() =>
        startServer({
          "/stuck": () => {
            // Accept the request and say nothing, forever.
          },
        }),
      );
      const outcome = yield* runFetch(`${server.baseUrl}/stuck`, { timeoutMs: 200 });
      yield* Effect.promise(server.close);

      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      assert.match(outcome.failure.message, /No response/);
    }),
  );
});

describe("htmlToText", () => {
  it("turns block boundaries into line breaks", () => {
    assert.strictEqual(
      htmlToText("<p>First.</p><p>Second.</p><ul><li>One</li><li>Two</li></ul>"),
      "First.\nSecond.\nOne\nTwo",
    );
  });

  it("removes style blocks and comments whole", () => {
    assert.strictEqual(
      htmlToText("<style>body { color: red }</style><!-- hidden -->Visible."),
      "Visible.",
    );
  });

  it("decodes numeric entities and leaves invalid ones alone", () => {
    assert.strictEqual(htmlToText("&#65;&#x42; &#xD800; &bogus;"), "AB &#xD800; &bogus;");
  });
});
