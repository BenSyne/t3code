/**
 * Cache breakpoints on the outgoing prompt.
 *
 * Anthropic bills the whole conversation as fresh input on every request unless
 * the prompt marks where the reusable prefix ends — with the marks, repeated
 * context bills at roughly a tenth of the price. Two marks: the system message
 * covers the tools-and-instructions prefix, and the last message moves forward
 * each request so the cache grows with the conversation.
 *
 * Applied at request time only, never persisted: the loop rebuilds the next
 * prompt from the un-annotated one, so the moving mark cannot accumulate into
 * more breakpoints than Anthropic's limit of four. Providers other than
 * Anthropic ignore `options.anthropic` entirely.
 *
 * @module agent/model/promptCaching
 */
import * as Prompt from "effect/unstable/ai/Prompt";
import type {} from "@effect/ai-anthropic/AnthropicLanguageModel";

const CACHE_BREAKPOINT = { cacheControl: { type: "ephemeral" as const } };

export function withCacheBreakpoints(prompt: Prompt.Prompt): Prompt.Prompt {
  const messages = prompt.content;
  if (messages.length === 0) {
    return prompt;
  }

  // Only the last system message: each mark is one of the four allowed
  // breakpoints, and marking every message of a long prefix would spend them
  // on positions that stopped mattering a step later.
  const lastSystem = messages.findLastIndex((message) => message.role === "system");
  const last = messages.length - 1;

  return Prompt.fromMessages(
    messages.map((message, index) =>
      index === lastSystem || index === last ? marked(message) : message,
    ),
  );
}

function marked(message: Prompt.Message): Prompt.Message {
  const options = { ...message.options, anthropic: CACHE_BREAKPOINT };
  switch (message.role) {
    case "system":
      return { ...message, options };
    case "user":
      return { ...message, options };
    case "assistant":
      return { ...message, options };
    case "tool":
      return { ...message, options };
  }
}
