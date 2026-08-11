/**
 * The live sessions an agent instance owns.
 *
 * @module agent/loop/sessionStore
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProviderSession } from "@t3tools/contracts";
import * as Prompt from "effect/unstable/ai/Prompt";

import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
} from "../../provider/Errors.ts";
import {
  closeSession,
  makeSessionContext,
  type AgentSessionContext,
  type AgentSessionMap,
} from "./AgentSession.ts";

export type SessionLookupError =
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterSessionClosedError;

type CreateInput = Omit<Parameters<typeof makeSessionContext>[0], "prompt"> & {
  readonly prompt?: Prompt.Prompt | undefined;
};

export function createSessionStore(provider: string) {
  const sessions: AgentSessionMap = new Map();

  /** Fetch a session that is safe to act on. */
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

  const create = (input: CreateInput): AgentSessionContext => {
    const context = makeSessionContext({ ...input, prompt: input.prompt ?? Prompt.empty });
    sessions.set(input.session.threadId, context);
    return context;
  };

  /** Close a session and drop it. */
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

  /** Drop the last `numTurns` turns, conversation included. */
  const rollback = (context: AgentSessionContext, numTurns: number): void => {
    const drop = Math.min(context.turns.length, Math.max(0, numTurns));
    if (drop === 0) {
      return;
    }
    const firstDropped = context.turns[context.turns.length - drop];
    context.turns.length = context.turns.length - drop;
    if (firstDropped !== undefined) {
      context.prompt = Prompt.make(
        context.prompt.content.slice(0, firstDropped.promptLengthBefore),
      );
    }
  };

  return { require, create, close, get, list, isLive, all, snapshot, rollback };
}

export type AgentSessionStore = ReturnType<typeof createSessionStore>;
