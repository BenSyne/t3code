/**
 * How many turns may run at once.
 *
 * Two limits, because they guard different failures. One turn per thread stops
 * a second message from racing the first through the same conversation — two
 * turns appending to one prompt interleave into nonsense, and the transcript
 * cannot be untangled afterwards. A cap across all threads stops the Conductor
 * from opening thirty threads and hitting a provider's rate limit hard enough
 * to get the user's key throttled.
 *
 * Queueing rather than rejecting: a user who sends two messages quickly means
 * both, in order.
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
  /**
   * Run `work` holding both a thread slot and a global slot.
   *
   * Acquired in that order everywhere, which is what keeps two threads from
   * deadlocking by each holding the lock the other needs.
   */
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
