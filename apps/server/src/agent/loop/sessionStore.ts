/**
 * The live sessions an agent instance owns.
 *
 * Split from the adapter so that file stays what it should be — translation
 * between the T3 Code contract and the agent — while the rules about which
 * sessions exist, when one is usable, and how history is trimmed live here and
 * can be tested without a provider.
 *
 * @module agent/loop/sessionStore
 */
import type { ProviderSession, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";

import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../../provider/Errors.ts";
import { closeSession, type AgentSessionContext, type AgentSessionMap } from "./AgentSession.ts";

export type SessionLookupError =
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError;

export function createSessionStore(provider: string) {
  const sessions: AgentSessionMap = new Map();

  /**
   * Fetch a session that is safe to act on.
   *
   * "Missing" and "closed" are deliberately different failures: the first means
   * the caller is confused about which thread it holds, the second means the
   * work it wanted is genuinely over.
   */
  const require = (threadId: ThreadId): Effect.Effect<AgentSessionContext, SessionLookupError> => {
    const context = sessions.get(threadId);
    if (!context) {
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider, threadId }));
    }
    if (context.stopped || context.session.status === "closed") {
      return Effect.fail(new ProviderAdapterSessionClosedError({ provider, threadId }));
    }
    return Effect.succeed(context);
  };

  const create = (input: {
    readonly session: ProviderSession;
    readonly model: string;
    readonly modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  }): AgentSessionContext => {
    const context: AgentSessionContext = {
      session: input.session,
      model: input.model,
      modelLayer: input.modelLayer,
      prompt: Prompt.empty,
      turns: [],
      stopped: false,
    };
    sessions.set(input.session.threadId, context);
    return context;
  };

  /**
   * Close a session and drop it.
   *
   * Returns whether this call did the closing, so the caller emits exactly one
   * exit event no matter how many times it is asked to stop.
   */
  const close = (context: AgentSessionContext, updatedAt: string): boolean => {
    const closed = closeSession(context, updatedAt);
    if (closed) {
      sessions.delete(context.session.threadId);
    }
    return closed;
  };

  const get = (threadId: ThreadId): AgentSessionContext | undefined => sessions.get(threadId);

  const list = (): ReadonlyArray<ProviderSession> =>
    Array.from(sessions.values(), ({ session }) => ({ ...session }));

  const isLive = (threadId: ThreadId): boolean => {
    const context = sessions.get(threadId);
    return context !== undefined && !context.stopped;
  };

  const all = (): ReadonlyArray<AgentSessionContext> => Array.from(sessions.values());

  /** History as the adapter reports it. */
  const snapshot = (context: AgentSessionContext, threadId: ThreadId) => ({
    threadId,
    turns: context.turns.map((turn) => ({ id: turn.id, items: turn.items })),
  });

  /**
   * Drop the last `numTurns` turns.
   *
   * Exact rather than best-effort, because we own the history instead of asking
   * a provider for it. Out-of-range counts clamp rather than throw: rolling back
   * more turns than exist means "go back to the start".
   */
  const rollback = (context: AgentSessionContext, numTurns: number): void => {
    context.turns.length = Math.max(0, context.turns.length - Math.max(0, numTurns));
  };

  return { require, create, close, get, list, isLive, all, snapshot, rollback };
}

export type AgentSessionStore = ReturnType<typeof createSessionStore>;
