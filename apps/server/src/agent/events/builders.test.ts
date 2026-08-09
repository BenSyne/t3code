import { EventId, ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { T3AGENT_DRIVER_KIND } from "../driverKind.ts";
import {
  assistantTextDeltaEvent,
  sessionExitedEvent,
  sessionStartedEvent,
  threadStartedEvent,
  turnCompletedEvent,
  turnStartedEvent,
  type EventStamp,
} from "./builders.ts";

// Decoding against the real contract is the point of this file: a builder that
// merely satisfies TypeScript can still emit a shape the wire schema rejects.
const decodeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

const stamp: EventStamp = {
  eventId: EventId.make("11111111-1111-4111-8111-111111111111"),
  createdAt: "2026-08-08T22:00:00.000Z",
};
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const ctx = { stamp, provider: T3AGENT_DRIVER_KIND, threadId };
const turnCtx = { ...ctx, turnId };

describe("agent event builders", () => {
  it("emits a full turn that decodes against the wire contract", () => {
    const turn = [
      sessionStartedEvent(ctx),
      threadStartedEvent(ctx),
      turnStartedEvent({ ...turnCtx, model: "claude-sonnet-5" }),
      assistantTextDeltaEvent({ ...turnCtx, delta: "Hello" }),
      turnCompletedEvent({ ...turnCtx, state: "completed" }),
      sessionExitedEvent({ ...ctx, exitKind: "graceful" }),
    ];

    for (const event of turn) {
      expect(() => decodeEvent(event)).not.toThrow();
    }
    expect(turn.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.completed",
      "session.exited",
    ]);
  });

  it("tags assistant text as assistant_text", () => {
    // Ingestion gates the assistant-message fold on this exact literal. Any
    // other value and the text is accepted, stored, and never rendered.
    const event = assistantTextDeltaEvent({ ...turnCtx, delta: "hi" });

    expect(event.type).toBe("content.delta");
    if (event.type !== "content.delta") return;
    expect(event.payload.streamKind).toBe("assistant_text");
    expect(event.payload.delta).toBe("hi");
  });

  it("preserves an empty delta rather than dropping it", () => {
    const event = assistantTextDeltaEvent({ ...turnCtx, delta: "" });

    expect(() => decodeEvent(event)).not.toThrow();
  });

  it("stamps turnId on every turn-scoped event", () => {
    // A turnId that disagrees with the one sendTurn returned is dropped by the
    // strict lifecycle guard with no error: the turn simply hangs.
    const events = [
      turnStartedEvent({ ...turnCtx, model: "m" }),
      assistantTextDeltaEvent({ ...turnCtx, delta: "d" }),
      turnCompletedEvent({ ...turnCtx, state: "completed" }),
    ];

    for (const event of events) {
      expect(event.turnId).toBe(turnId);
    }
  });

  it("carries every terminal turn state the contract allows", () => {
    for (const state of ["completed", "failed", "interrupted", "cancelled"] as const) {
      const event = turnCompletedEvent({ ...turnCtx, state });
      expect(() => decodeEvent(event)).not.toThrow();
      if (event.type !== "turn.completed") return;
      expect(event.payload.state).toBe(state);
    }
  });

  it("omits optional fields rather than sending undefined", () => {
    const event = turnCompletedEvent({ ...turnCtx, state: "completed" });
    if (event.type !== "turn.completed") return;

    expect("stopReason" in event.payload).toBe(false);
    expect("errorMessage" in event.payload).toBe(false);
  });

  it("reports a failed turn with its message", () => {
    const event = turnCompletedEvent({
      ...turnCtx,
      state: "failed",
      errorMessage: "model refused",
    });

    expect(() => decodeEvent(event)).not.toThrow();
    if (event.type !== "turn.completed") return;
    expect(event.payload.errorMessage).toBe("model refused");
  });

  it("distinguishes a graceful exit from an error exit", () => {
    const graceful = sessionExitedEvent({ ...ctx, exitKind: "graceful" });
    const failed = sessionExitedEvent({ ...ctx, exitKind: "error", reason: "boom" });

    expect(() => decodeEvent(graceful)).not.toThrow();
    expect(() => decodeEvent(failed)).not.toThrow();
    if (failed.type !== "session.exited") return;
    expect(failed.payload.exitKind).toBe("error");
    expect(failed.payload.reason).toBe("boom");
  });

  it("omits raw, whose source union is closed", () => {
    // Attaching a native payload needs a contracts change that ripples to
    // every client decoder. Nothing here should be emitting one yet.
    expect(sessionStartedEvent(ctx).raw).toBeUndefined();
    expect(assistantTextDeltaEvent({ ...turnCtx, delta: "x" }).raw).toBeUndefined();
  });
});
