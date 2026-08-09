import { ThreadId, TurnId } from "@t3tools/contracts";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Prompt from "effect/unstable/ai/Prompt";

import type { AgentToolkit } from "../tools/registry.ts";
import {
  applyModelChoice,
  closeSession,
  setSessionStatus,
  type AgentSessionContext,
} from "./AgentSession.ts";
import { createSessionStore } from "./sessionStore.ts";

const THREAD = ThreadId.make("thread-1");

const session = (): AgentSessionContext["session"] => ({
  provider: "t3agent" as AgentSessionContext["session"]["provider"],
  status: "ready",
  runtimeMode: "default" as AgentSessionContext["session"]["runtimeMode"],
  threadId: THREAD,
  createdAt: "2026-08-08T22:00:00.000Z",
  updatedAt: "2026-08-08T22:00:00.000Z",
});

const makeStore = () => {
  const store = createSessionStore("t3agent");
  const context = store.create({
    session: session(),
    model: "claude-sonnet-5",
    modelLayer: Layer.empty as AgentSessionContext["modelLayer"],
    workspaceRoot: "/workspace",
    toolkit: { tools: {} } as unknown as AgentToolkit,
    contextWindow: 200_000,
    prompt: Prompt.make([{ role: "system", content: "rules" }]),
  });
  return { store, context };
};

const userMessage = (text: string) =>
  Prompt.make([{ role: "user" as const, content: [{ type: "text" as const, text }] }]);

/** Play a turn: remember where the conversation was, then grow it. */
const recordTurn = (context: AgentSessionContext, id: string, text: string) => {
  const promptLengthBefore = context.prompt.content.length;
  context.prompt = Prompt.concat(context.prompt, userMessage(text));
  context.prompt = Prompt.concat(
    context.prompt,
    Prompt.make([{ role: "assistant", content: [{ type: "text", text: `re: ${text}` }] }]),
  );
  context.turns.push({ id: TurnId.make(id), items: [], promptLengthBefore });
};

describe("session lookup", () => {
  it.effect("finds a live session", () =>
    Effect.gen(function* () {
      const { store } = makeStore();
      const found = yield* store.require(THREAD);
      expect(found.session.threadId).toBe(THREAD);
    }),
  );

  it.effect("tells a missing session apart from a closed one", () =>
    Effect.gen(function* () {
      const { store, context } = makeStore();

      const missing = yield* Effect.flip(store.require(ThreadId.make("nope")));
      expect(missing._tag).toBe("ProviderAdapterSessionNotFoundError");

      setSessionStatus(context, "closed", "2026-08-08T22:05:00.000Z");
      const closed = yield* Effect.flip(store.require(THREAD));
      expect(closed._tag).toBe("ProviderAdapterSessionClosedError");
    }),
  );

  it("stops tracking a session once it is closed", () => {
    const { store, context } = makeStore();

    expect(store.isLive(THREAD)).toBe(true);
    expect(store.close(context, "2026-08-08T22:06:00.000Z")).toBe(true);
    expect(store.isLive(THREAD)).toBe(false);
    expect(store.list()).toEqual([]);
    // Second close is a no-op, so exactly one exit event is ever emitted.
    expect(store.close(context, "2026-08-08T22:07:00.000Z")).toBe(false);
  });
});

describe("rollback", () => {
  it("restores the conversation to exactly where the dropped turn began", () => {
    const { store, context } = makeStore();
    recordTurn(context, "turn-1", "first");
    recordTurn(context, "turn-2", "second");
    expect(context.prompt.content).toHaveLength(5);

    store.rollback(context, 1);

    expect(context.turns.map((turn) => turn.id)).toEqual([TurnId.make("turn-1")]);
    // System message plus the first exchange — the second turn is gone from the
    // conversation, not just from the turn list.
    expect(context.prompt.content).toHaveLength(3);
  });

  it("rolls back several turns at once", () => {
    const { store, context } = makeStore();
    recordTurn(context, "turn-1", "first");
    recordTurn(context, "turn-2", "second");

    store.rollback(context, 2);

    expect(context.turns).toEqual([]);
    expect(context.prompt.content).toHaveLength(1);
  });

  it("clamps rather than throwing when asked for more turns than exist", () => {
    const { store, context } = makeStore();
    recordTurn(context, "turn-1", "first");

    store.rollback(context, 99);

    expect(context.turns).toEqual([]);
    expect(context.prompt.content).toHaveLength(1);
  });

  it("does nothing for zero or negative counts", () => {
    const { store, context } = makeStore();
    recordTurn(context, "turn-1", "first");

    store.rollback(context, 0);
    store.rollback(context, -3);

    expect(context.turns).toHaveLength(1);
    expect(context.prompt.content).toHaveLength(3);
  });
});

describe("session lifecycle helpers", () => {
  it("closes once and reports whether it did the closing", () => {
    const { context } = makeStore();

    expect(closeSession(context, "2026-08-08T22:01:00.000Z")).toBe(true);
    expect(context.session.status).toBe("closed");
    expect(closeSession(context, "2026-08-08T22:02:00.000Z")).toBe(false);
  });

  it("updates status without disturbing the rest of the record", () => {
    const { context } = makeStore();

    setSessionStatus(context, "running", "2026-08-08T22:03:00.000Z");

    expect(context.session.status).toBe("running");
    expect(context.session.threadId).toBe(THREAD);
    expect(context.session.updatedAt).toBe("2026-08-08T22:03:00.000Z");
  });

  it("starts with no turn in flight and nothing interrupted", () => {
    const { context } = makeStore();

    expect(context.running).toBeNull();
    expect(context.interrupted).toBe(false);
    expect(context.usage.inputTokens).toBe(0);
  });
});

describe("applyModelChoice", () => {
  const nextLayer = Layer.empty as AgentSessionContext["modelLayer"];

  it("swaps model, effort, layer and window together", () => {
    const { context } = makeStore();

    applyModelChoice(
      context,
      {
        model: "claude-opus-5",
        reasoningEffort: "high",
        modelLayer: nextLayer,
        contextWindow: 500_000,
      },
      "2026-08-09T10:00:00.000Z",
    );

    expect(context.model).toBe("claude-opus-5");
    expect(context.reasoningEffort).toBe("high");
    expect(context.modelLayer).toBe(nextLayer);
    expect(context.contextWindow).toBe(500_000);
  });

  it("updates the wire-visible record, or the orchestrator would restart the session", () => {
    // ProviderCommandReactor compares session.model against the requested
    // selection to decide whether anything changed. A stale record here makes
    // every turn after a switch look like a fresh change.
    const { context } = makeStore();

    applyModelChoice(
      context,
      {
        model: "claude-opus-5",
        reasoningEffort: undefined,
        modelLayer: nextLayer,
        contextWindow: null,
      },
      "2026-08-09T10:01:00.000Z",
    );

    expect(context.session.model).toBe("claude-opus-5");
    expect(context.session.updatedAt).toBe("2026-08-09T10:01:00.000Z");
    expect(context.session.threadId).toBe(THREAD);
  });

  it("leaves the conversation and turn history alone", () => {
    const { context } = makeStore();
    recordTurn(context, "turn-1", "before the switch");

    applyModelChoice(
      context,
      {
        model: "claude-opus-5",
        reasoningEffort: "low",
        modelLayer: nextLayer,
        contextWindow: null,
      },
      "2026-08-09T10:02:00.000Z",
    );

    expect(context.turns).toHaveLength(1);
    expect(context.prompt.content).toHaveLength(3);
  });
});
