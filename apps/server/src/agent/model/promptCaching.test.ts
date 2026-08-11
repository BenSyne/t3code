/**
 * Cache breakpoints.
 *
 * What matters is where the marks land: Anthropic allows four breakpoints per
 * request, so a function that marked too many messages would not degrade —
 * every request would be rejected outright.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Prompt from "effect/unstable/ai/Prompt";

import { withCacheBreakpoints } from "./promptCaching.ts";

const conversation = Prompt.make([
  { role: "system", content: "You are an agent." },
  { role: "user", content: [{ type: "text", text: "Fix the bug." }] },
  { role: "assistant", content: [{ type: "text", text: "Looking." }] },
  { role: "user", content: [{ type: "text", text: "Any luck?" }] },
]);

const breakpointOf = (message: Prompt.Message) =>
  (message.options as { anthropic?: { cacheControl?: { type?: string } } }).anthropic?.cacheControl;

describe("withCacheBreakpoints", () => {
  it("marks exactly the system message and the last message", () => {
    const marks = withCacheBreakpoints(conversation).content.map(
      (message) => breakpointOf(message)?.type,
    );
    assert.deepStrictEqual(marks, ["ephemeral", undefined, undefined, "ephemeral"]);
  });

  it("leaves the original prompt untouched", () => {
    // The loop rebuilds the next request from this prompt; a mutation here
    // would accumulate a mark per step until Anthropic rejects the request.
    withCacheBreakpoints(conversation);
    assert.isTrue(conversation.content.every((message) => breakpointOf(message) === undefined));
  });

  it("keeps the other options a message already carries", () => {
    const withOptions = Prompt.make([
      { role: "system", content: "Prompt.", options: { openai: { something: true } } },
    ]);
    const annotated = withCacheBreakpoints(withOptions).content[0];
    assert.deepStrictEqual((annotated?.options as { openai?: unknown }).openai, {
      something: true,
    });
    assert.strictEqual(breakpointOf(annotated!)?.type, "ephemeral");
  });

  it("spends one mark, not two, on a prompt that is only a system message", () => {
    const single = withCacheBreakpoints(
      Prompt.make([{ role: "system", content: "Prompt." }]),
    ).content;
    assert.strictEqual(single.length, 1);
    assert.strictEqual(breakpointOf(single[0]!)?.type, "ephemeral");
  });

  it("does nothing to an empty prompt", () => {
    assert.strictEqual(withCacheBreakpoints(Prompt.empty).content.length, 0);
  });
});
