/**
 * One conversation with the built-in agent.
 *
 * A session owns the per-thread state a turn needs: the wire-visible
 * `ProviderSession` record, the resolved language-model layer, and the running
 * conversation. It deliberately knows nothing about the provider adapter that
 * holds it — the adapter maps sessions to the T3 Code contract, this maps them
 * to a model.
 *
 * Turns are non-streaming for now. `runTurn` returns the assistant text and the
 * adapter decides which events that becomes, which keeps the event vocabulary
 * in one tested place instead of spread through the loop.
 *
 * @module agent/loop/AgentSession
 */
import type { ProviderSession, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";

export interface AgentSessionContext {
  /** The wire-visible record. Mutated in place as status changes. */
  session: ProviderSession;
  readonly model: string;
  /**
   * A ready-to-use model. `HttpClient` is provided once when the session is
   * created, not per turn, so running a turn requires nothing further — which
   * is what lets the loop be tested against a stub with no transport at all.
   */
  readonly modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  /** Conversation so far. Replaced wholesale each turn; never mutated. */
  prompt: Prompt.Prompt;
  /**
   * Completed turns, oldest first. We own this rather than asking a provider
   * for it, which is what makes rollback exact instead of approximate.
   */
  turns: Array<{ readonly id: TurnId; readonly items: ReadonlyArray<unknown> }>;
  /** One-shot teardown latch, so stopping twice is a no-op. */
  stopped: boolean;
}

export interface AgentTurnResult {
  readonly text: string;
  readonly finishReason: string;
}

/**
 * Run one turn against the model.
 *
 * The user message is appended before the request and the assistant reply after
 * it, so a follow-up turn sees the full conversation. On failure the prompt is
 * left holding the user message: the exchange happened, and dropping it would
 * silently rewrite history the user watched arrive.
 */
export const runTurn = Effect.fn("t3agent/runTurn")(function* (
  context: AgentSessionContext,
  input: { readonly text: string },
) {
  context.prompt = Prompt.concat(
    context.prompt,
    Prompt.make([{ role: "user", content: [{ type: "text", text: input.text }] }]),
  );

  const response = yield* LanguageModel.generateText({ prompt: context.prompt }).pipe(
    Effect.provide(context.modelLayer),
  );

  const text = response.text;
  if (text !== "") {
    context.prompt = Prompt.concat(
      context.prompt,
      Prompt.make([{ role: "assistant", content: [{ type: "text", text }] }]),
    );
  }

  return { text, finishReason: response.finishReason } satisfies AgentTurnResult;
});

/** Mark a session closed. Idempotent: the second call is a no-op. */
export function closeSession(context: AgentSessionContext, updatedAt: string): boolean {
  if (context.stopped) {
    return false;
  }
  context.stopped = true;
  context.session = { ...context.session, status: "closed", updatedAt };
  return true;
}

/** Update a session's status without disturbing the rest of the record. */
export function setSessionStatus(
  context: AgentSessionContext,
  status: ProviderSession["status"],
  updatedAt: string,
): void {
  context.session = { ...context.session, status, updatedAt };
}

/** Sessions are keyed by thread: one live conversation per thread. */
export type AgentSessionMap = Map<ThreadId, AgentSessionContext>;
