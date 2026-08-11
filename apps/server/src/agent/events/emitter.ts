/**
 * Stamping and queueing for runtime events.
 *
 * @module agent/events/emitter
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { EventId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  assistantMessageItemEvent,
  assistantTextDeltaEvent,
  reasoningDeltaEvent,
  requestOpenedEvent,
  requestResolvedEvent,
  runtimeWarningEvent,
  sessionExitedEvent,
  sessionStartedEvent,
  threadStartedEvent,
  tokenUsageEvent,
  toolItemEvent,
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

    reasoning: (input: { threadId: ThreadId; turnId: TurnId; delta: string }) =>
      Effect.flatMap(stamp, (s) => offer(reasoningDeltaEvent({ provider, ...input, stamp: s }))),

    assistantMessageItem: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      itemId: RuntimeItemId;
      lifecycle: "item.started" | "item.completed";
    }) =>
      Effect.flatMap(stamp, (s) =>
        offer(assistantMessageItemEvent({ provider, ...input, stamp: s })),
      ),

    toolItem: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      itemId: RuntimeItemId;
      lifecycle: "item.started" | "item.updated" | "item.completed";
      itemType: CanonicalItemType;
      status: "inProgress" | "completed" | "failed";
      title: string;
      detail?: string | undefined;
      data?: Record<string, unknown> | undefined;
    }) => Effect.flatMap(stamp, (s) => offer(toolItemEvent({ provider, ...input, stamp: s }))),

    requestOpened: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      requestId: RuntimeRequestId;
      requestType: CanonicalRequestType;
      detail: string;
      args?: Record<string, unknown> | undefined;
    }) => Effect.flatMap(stamp, (s) => offer(requestOpenedEvent({ provider, ...input, stamp: s }))),

    requestResolved: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      requestId: RuntimeRequestId;
      requestType: CanonicalRequestType;
      decision: string;
    }) =>
      Effect.flatMap(stamp, (s) => offer(requestResolvedEvent({ provider, ...input, stamp: s }))),

    tokenUsage: (input: { threadId: ThreadId; usage: ThreadTokenUsageSnapshot }) =>
      Effect.flatMap(stamp, (s) => offer(tokenUsageEvent({ provider, ...input, stamp: s }))),

    warning: (input: { threadId: ThreadId; message: string }) =>
      Effect.flatMap(stamp, (s) => offer(runtimeWarningEvent({ provider, ...input, stamp: s }))),

    turnCompleted: (input: {
      threadId: ThreadId;
      turnId: TurnId;
      state: "completed" | "failed" | "interrupted" | "cancelled";
      stopReason?: string | undefined;
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
