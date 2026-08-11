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

/**
 * One chunk of the model's reasoning.
 *
 * Separate from assistant text so the client can collapse it. Sharing the
 * builder and passing a `streamKind` would put the two literals one typo apart.
 */
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

/**
 * The envelope around a run of assistant text.
 *
 * Deltas alone leave the client guessing where one message ends and the next
 * begins, which matters here because a turn produces several: one per step,
 * separated by tool calls.
 */
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

/**
 * A tool call appearing, updating, or finishing.
 *
 * `itemId` is the model's own tool-call id, so the started and completed events
 * refer to the same timeline row without us inventing a correlation key.
 */
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

/**
 * The agent is waiting for a human.
 *
 * `requestType` is what the client keys its approval UI on, so a command and a
 * file change get the prompt each deserves.
 */
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

/**
 * Something went wrong that the turn survived.
 *
 * A shadowed tool name, an MCP server that would not start. These belong in
 * front of the user but must never be mistaken for a failed turn.
 */
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
