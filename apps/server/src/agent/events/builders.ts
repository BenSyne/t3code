/**
 * Pure builders for the canonical runtime events one turn emits.
 *
 * @module agent/events/builders
 */
import type {
  CanonicalItemType,
  CanonicalRequestType,
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  ThreadTokenUsageSnapshot,
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

/** One chunk of assistant text. */
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

/** One chunk of the model's reasoning. */
export function reasoningDeltaEvent(
  ctx: TurnContext & { readonly delta: string },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "content.delta",
    turnId: ctx.turnId,
    payload: { streamKind: "reasoning_text", delta: ctx.delta },
  };
}

/** The envelope around a run of assistant text. */
export function assistantMessageItemEvent(
  ctx: TurnContext & {
    readonly itemId: RuntimeItemId;
    readonly lifecycle: "item.started" | "item.completed";
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: ctx.lifecycle,
    turnId: ctx.turnId,
    itemId: ctx.itemId,
    payload: {
      itemType: "assistant_message",
      status: ctx.lifecycle === "item.completed" ? "completed" : "inProgress",
    },
  };
}

/** A tool call appearing, updating, or finishing. */
export function toolItemEvent(
  ctx: TurnContext & {
    readonly itemId: RuntimeItemId;
    readonly lifecycle: "item.started" | "item.updated" | "item.completed";
    readonly itemType: CanonicalItemType;
    readonly status: "inProgress" | "completed" | "failed";
    readonly title: string;
    readonly detail?: string | undefined;
    readonly data?: Record<string, unknown> | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: ctx.lifecycle,
    turnId: ctx.turnId,
    itemId: ctx.itemId,
    payload: {
      itemType: ctx.itemType,
      status: ctx.status,
      title: ctx.title,
      ...(ctx.detail === undefined || ctx.detail === "" ? {} : { detail: ctx.detail }),
      ...(ctx.data === undefined ? {} : { data: ctx.data }),
    },
  };
}

/** The agent is waiting for a human. */
export function requestOpenedEvent(
  ctx: TurnContext & {
    readonly requestId: RuntimeRequestId;
    readonly requestType: CanonicalRequestType;
    readonly detail: string;
    readonly args?: Record<string, unknown> | undefined;
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "request.opened",
    turnId: ctx.turnId,
    requestId: ctx.requestId,
    payload: {
      requestType: ctx.requestType,
      detail: ctx.detail,
      ...(ctx.args === undefined ? {} : { args: ctx.args }),
    },
  };
}

export function requestResolvedEvent(
  ctx: TurnContext & {
    readonly requestId: RuntimeRequestId;
    readonly requestType: CanonicalRequestType;
    readonly decision: string;
  },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "request.resolved",
    turnId: ctx.turnId,
    requestId: ctx.requestId,
    payload: { requestType: ctx.requestType, decision: ctx.decision },
  };
}

export function tokenUsageEvent(
  ctx: EventContext & { readonly usage: ThreadTokenUsageSnapshot },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "thread.token-usage.updated",
    payload: { usage: ctx.usage },
  };
}

/** Something went wrong that the turn survived. */
export function runtimeWarningEvent(
  ctx: EventContext & { readonly message: string },
): ProviderRuntimeEvent {
  return {
    ...base(ctx),
    type: "runtime.warning",
    payload: { message: ctx.message },
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
