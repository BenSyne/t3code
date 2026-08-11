import { describe, expect, it } from "vite-plus/test";

import { describeTurnFailure } from "./failureMessage.ts";

/**
 * The real thing, copied from the server trace after Ben's Cerebras turn
 * failed. Written out verbatim so this test keeps describing what actually
 * reaches the UI rather than what we imagine reaches it.
 */
const CEREBRAS_CONTEXT_OVERFLOW = `Cause([Fail(effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Invalid request. HTTP 400 (POST https://api.cerebras.ai/v1/chat/completions) Response: {"message":"Please reduce the length of the messages or completion. Current length is 8530 while limit is 8192","type":"invalid_request_error","param":"messages","code":"context_length_exceeded","id":"abc"}
    at Module.make (file:///Users/x/node_modules/.pnpm/effect@4/dist/unstable/ai/AiError.js:1248:31)
    at t3agent/runTurn (file:///Users/x/apps/server/src/provider/Layers/T3AgentAdapter.ts:431:7))])`;

describe("what the user is shown when a turn fails", () => {
  it("never leaks the Cause wrapper, the URL, or a stack trace", () => {
    const message = describeTurnFailure(CEREBRAS_CONTEXT_OVERFLOW, 40);

    expect(message).not.toContain("Cause(");
    expect(message).not.toContain("node_modules");
    expect(message).not.toContain("createResponseStream");
    expect(message).not.toContain("https://");
    expect(message).not.toContain("    at ");
  });

  it("states both numbers, because the gap is the whole story", () => {
    const message = describeTurnFailure(CEREBRAS_CONTEXT_OVERFLOW, 40);

    expect(message).toContain("8,192");
    expect(message).toContain("8,530");
  });

  it("says the model is too small when the conversation cannot account for the gap", () => {
    // 338 tokens over, on a 40-token conversation: even deleting every message
    // leaves it over. Telling the user to start a new thread would send them
    // round a loop that cannot end.
    const message = describeTurnFailure(CEREBRAS_CONTEXT_OVERFLOW, 40);

    expect(message).toContain("too small to run the agent");
    expect(message).not.toContain("Start a new thread");
  });

  it("suggests a new thread when the conversation really is what overflowed", () => {
    const grown = CEREBRAS_CONTEXT_OVERFLOW.replace(
      "Current length is 8530",
      "Current length is 60000",
    );
    const message = describeTurnFailure(grown, 55_000);

    expect(message).toContain("Start a new thread");
    expect(message).not.toContain("too small to run the agent");
  });

  it("gives the vaguer but still correct advice when the size is unknown", () => {
    const message = describeTurnFailure(CEREBRAS_CONTEXT_OVERFLOW);

    expect(message).toContain("larger context window");
  });
});

describe("other provider failures", () => {
  it("prefers the provider's own sentence over our transport wrapper", () => {
    const cause = `Cause([Fail(effect/ai/AiError/AiError: OpenAiClient.createResponseStream: Invalid request. HTTP 404 (POST https://openrouter.ai/api/v1/chat/completions) Response: {"message":"No endpoints found for moonshotai/kimi-k99.","code":404})])`;

    expect(describeTurnFailure(cause)).toBe("No endpoints found for moonshotai/kimi-k99.");
  });

  it("says whose key was rejected, which the provider's wording leaves out", () => {
    const cause = `Cause([Fail(AiError: HTTP 401 (POST https://api.cerebras.ai/v1/chat/completions) Response: {"message":"Wrong API key provided."})])`;

    expect(describeTurnFailure(cause)).toBe(
      "The provider rejected the API key. Wrong API key provided.",
    );
  });

  it("unwraps a bare Effect error into its sentence", () => {
    const cause = "Cause([Fail(effect/ai/AiError/AiError: The request timed out.)])";

    expect(describeTurnFailure(cause)).toBe("The request timed out.");
  });

  it("decodes escapes rather than showing them raw", () => {
    const cause = `Cause([Fail(AiError: HTTP 400 Response: {"message":"Model \\"gpt-9\\" does not exist."})])`;

    expect(describeTurnFailure(cause)).toContain('Model "gpt-9" does not exist.');
  });

  it("keeps a plain Error's message", () => {
    expect(describeTurnFailure(new Error("Connection refused"))).toBe("Connection refused");
  });

  it("falls back rather than showing an empty box", () => {
    expect(describeTurnFailure("")).toBe("The agent turn failed.");
    expect(describeTurnFailure("   ")).toBe("The agent turn failed.");
  });

  it("caps a provider that answers with an essay", () => {
    const cause = `Cause([Fail(AiError: HTTP 400 Response: {"message":"${"x".repeat(900)}"})])`;
    const message = describeTurnFailure(cause);

    expect(message.length).toBeLessThanOrEqual(400);
    expect(message.endsWith("…")).toBe(true);
  });
});

describe("a model the provider no longer serves", () => {
  // The real message Ben hit: an old thread stored `qwen/qwen3.8`, the id was
  // withdrawn, and every resend replayed a 400. The provider's own sentence is
  // accurate and unhelpful — it never says the fix is one dropdown away.
  const cause =
    "OpenRouterClient.createChatCompletionStream: Invalid request. qwen/qwen3.8 is not a valid model ID (POST https://openrouter.ai/api/v1/chat/completions)";

  it("names the model and says what to do about it", () => {
    const message = describeTurnFailure(cause);

    expect(message).toContain("qwen/qwen3.8");
    expect(message).toContain("Pick another model for this thread.");
  });

  it("wins over the provider's own wording, which stops at the diagnosis", () => {
    expect(describeTurnFailure(cause)).not.toBe("Invalid request.");
  });

  it("leaves other rejections to the provider's message", () => {
    const other =
      'Cause([Fail(AiError: HTTP 400 Response: {"message":"temperature must be <= 2"})])';
    expect(describeTurnFailure(other)).toContain("temperature must be <= 2");
  });
});
