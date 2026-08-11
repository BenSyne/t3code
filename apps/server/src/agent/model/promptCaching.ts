/**
 * Cache breakpoints on the outgoing prompt.
 *
 * Some providers bill the whole conversation as fresh input on every request
 * unless the prompt marks where the reusable prefix ends — with the marks,
 * repeated context bills at roughly a tenth of the price. Two marks: the system
 * message covers the tools-and-instructions prefix, and the last message moves
 * forward each request so the cache grows with the conversation.
 *
 * The mark is written under both provider keys because each client reads its
 * own. Anthropic needs it because explicit breakpoints are the only way it
 * caches at all; OpenRouter needs it because it fronts Anthropic — and it
 * translates the marker for whatever it routes to, so a block marked here
 * becomes a `prompt_cache_breakpoint` on a supporting OpenAI model. Backends
 * that cache on their own (OpenAI direct, DeepSeek, Moonshot, Grok) read
 * neither key, and lose nothing: their caching needs no marks.
 *
 * Applied at request time only, never persisted: the loop rebuilds the next
 * prompt from the un-annotated one, so the moving mark cannot accumulate into
 * more breakpoints than Anthropic's limit of four.
 *
 * @module agent/model/promptCaching
 */
import * as Prompt from "effect/unstable/ai/Prompt";
import type {} from "@effect/ai-anthropic/AnthropicLanguageModel";
import type {} from "@effect/ai-openrouter/OpenRouterLanguageModel";

/** Both dialects spell the value the same way: `{ type: "ephemeral" }`. */
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
  const options = {
    ...message.options,
    anthropic: CACHE_BREAKPOINT,
    openrouter: CACHE_BREAKPOINT,
  };
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
