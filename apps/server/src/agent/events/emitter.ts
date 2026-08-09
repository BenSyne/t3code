/**
 * Stamping and queueing for runtime events.
 *
 * The builders in `builders.ts` are pure; this is where the impure half lives —
 * minting an id, reading the clock, and putting the result on the stream the
 * adapter exposes. Keeping it here means the adapter names *what* happened and
 * never repeats the mechanics of saying so.
 *
 * @module agent/events/emitter
 */
import type {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { EventId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  assistantTextDeltaEvent,
  sessionExitedEvent,
  sessionStartedEvent,
  threadStartedEvent,
  turnCompletedEvent,
  turnStartedEvent,
} from "./builders.ts";

export interface RuntimeEventEmitterOptions {
  readonly provider: ProviderDriverKind;
  /** Fresh uuid per event. Dies rather than fails: id generation is infallible. */
  readonly uuid: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

export const makeRuntimeEventEmitter = Effect.fnUntraced(function* (
  options: RuntimeEventEmitterOptions,
) {
  const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const provider = options.provider;

  const stamp = Effect.all({
    eventId: Effect.map(options.uuid, EventId.make),
    createdAt: options.nowIso,
  });

  const offer = (event: ProviderRuntimeEvent) => Queue.offer(queue, event).pipe(Effect.asVoid);

  return {
    sessionStarted: (threadId: ThreadId) =>
      Effect.flatMap(stamp, (s) => offer(sessionStartedEvent({ provider, threadId, stamp: s }))),

    threadStarted: (threadId: ThreadId) =>
      Effect.flatMap(stamp, (s) => offer(threadStartedEvent({ provider, threadId, stamp: s }))),

    turnStarted: (input: { threadId: ThreadId; turnId: TurnId; model: string }) =>
      Effect.flatMap(stamp, (s) => offer(turnStartedEvent({ provider, ...input, stamp: s }))),

    assistantText: (input: { threadId: ThreadId; turnId: TurnId; delta: string }) =>
      Effect.flatMap(stamp, (s) =>
        offer(assistantTextDeltaEvent({ provider, ...input, stamp: s })),
      ),

    turnCompleted: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      state: "completed" | "failed" | "interrupted" | "cancelled";
      errorMessage?: string | undefined;
    }) => Effect.flatMap(stamp, (s) => offer(turnCompletedEvent({ provider, ...input, stamp: s }))),

    sessionExited: (input: {
      threadId: ThreadId;
      exitKind: "graceful" | "error";
      reason?: string | undefined;
    }) => Effect.flatMap(stamp, (s) => offer(sessionExitedEvent({ provider, ...input, stamp: s }))),

    get stream() {
      return Stream.fromQueue(queue);
    },

    shutdown: Queue.shutdown(queue),
  };
});
