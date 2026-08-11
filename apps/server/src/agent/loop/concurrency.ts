/**
 * How many turns may run at once.
 *
 * @module agent/loop/concurrency
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export interface ConcurrencyLimits {
  /** Turns at once across the whole instance. */
  readonly maxConcurrentTurns: number;
}

export const DEFAULT_CONCURRENCY_LIMITS: ConcurrencyLimits = {
  maxConcurrentTurns: 4,
};

export interface AgentConcurrency {
  /** Run `work` holding both a thread slot and a global slot. */
  readonly withTurnSlot: <A, E, R>(
    threadId: ThreadId,
    work: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Drop a thread's lock once its session is gone, so the map cannot grow forever. */
  readonly forget: (threadId: ThreadId) => void;
}

export const makeAgentConcurrency = Effect.fnUntraced(function* (
  limits: ConcurrencyLimits = DEFAULT_CONCURRENCY_LIMITS,
) {
  const global = yield* Semaphore.make(Math.max(1, limits.maxConcurrentTurns));
  const perThread = new Map<ThreadId, Semaphore.Semaphore>();

  const threadLock = Effect.fnUntraced(function* (threadId: ThreadId) {
    const existing = perThread.get(threadId);
    if (existing !== undefined) {
      return existing;
    }
    const created = yield* Semaphore.make(1);
    perThread.set(threadId, created);
    return created;
  });

  return {
    withTurnSlot: (threadId, work) =>
      Effect.flatMap(threadLock(threadId), (lock) =>
        lock.withPermits(1)(global.withPermits(1)(work)),
      ),
    forget: (threadId) => {
      perThread.delete(threadId);
    },
  } satisfies AgentConcurrency;
});
