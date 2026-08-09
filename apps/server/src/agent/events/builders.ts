/**
 * Pure builders for the canonical runtime events one turn emits.
 *
 * These are deliberately pure: the only impure inputs — an event id and a
 * timestamp — arrive as an `EventStamp`, so every builder is a total function
 * that can be table-tested without a runtime.
 *
 * Several of the literals here are load-bearing in ways that fail *silently*
 * rather than loudly, which is why they are centralised in one tested file:
 *
 *   - `streamKind: "assistant_text"` is what the ingestion layer gates the
 *     assistant-message fold on. Any other value and the text is accepted,
 *     stored, and never rendered.
 *   - `turnId` must match the id returned from `sendTurn`. The strict
 *     lifecycle guard drops turn events whose id disagrees with the tracked
 *     active turn, with no error anywhere — the symptom is a turn that hangs
 *     forever.
 *
 * `raw` is deliberately omitted. `RuntimeEventRawSource` is a closed union, so
 * attaching a native payload means a contracts change that ripples out to every
 * client decoder. It buys nothing until there is a debug log to attach.
 *
 * @module agent/events/builders
 */
import type {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

/** The impure part of an event, minted once per event by the adapter. */
export interface EventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

interface EventContext {
  readonly stamp: EventStamp;
  readonly provider: ProviderDriverKind;
  readonly threadId: ThreadId;
}

interface TurnContext extends EventContext {
  readonly turnId: TurnId;
}

export function sessionStartedEvent(ctx: EventContext): ProviderRuntimeEvent {
  return { ...base(ctx), type: "session.started", payload: {} };
}

export function threadStartedEvent(ctx: EventContext): ProviderRuntimeEvent {
  return { ...base(ctx), type: "thread.started", payload: {} };
}

export function turnStartedEvent(
  ctx: TurnContext & { readonly model: string },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "turn.started",
    turnId: ctx.turnId,
    payload: { model: ctx.model },
  };
}

/**
 * One chunk of assistant text.
 *
 * `streamKind` is not a parameter on purpose — this builder exists so the
 * literal is written once, in a place a test can pin.
 */
export function assistantTextDeltaEvent(
  ctx: TurnContext & { readonly delta: string },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "content.delta",
    turnId: ctx.turnId,
    payload: { streamKind: "assistant_text", delta: ctx.delta },
  };
}

export function turnCompletedEvent(
  ctx: TurnContext & {
    readonly state: "completed" | "failed" | "interrupted" | "cancelled";
    readonly stopReason?: string | undefined;
    readonly errorMessage?: string | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "turn.completed",
    turnId: ctx.turnId,
    payload: {
      state: ctx.state,
      ...(ctx.stopReason === undefined ? {} : { stopReason: ctx.stopReason }),
      ...(ctx.errorMessage === undefined ? {} : { errorMessage: ctx.errorMessage }),
    },
  };
}

export function sessionExitedEvent(
  ctx: EventContext & {
    readonly exitKind: "graceful" | "error";
    readonly reason?: string | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "session.exited",
    payload: {
      exitKind: ctx.exitKind,
      ...(ctx.reason === undefined ? {} : { reason: ctx.reason }),
    },
  };
}

function base(ctx: EventContext) {
  return {
    eventId: ctx.stamp.eventId,
    createdAt: ctx.stamp.createdAt,
    provider: ctx.provider,
    threadId: ctx.threadId,
  };
}
