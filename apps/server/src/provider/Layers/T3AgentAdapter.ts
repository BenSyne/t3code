/**
 * T3AgentAdapter — the built-in agent as a provider.
 *
 * Every other adapter here translates a subprocess's native protocol. This one
 * has no subprocess: sessions are objects in a Map and a turn is a function
 * call. The contract is identical, which is the point — orchestration,
 * checkpointing, remote access and the clients cannot tell the difference.
 *
 * Two behaviours below look arbitrary and are not. `sendTurn` mints the
 * `TurnId` and stamps it on every event for that turn, because the strict
 * lifecycle guard silently drops turn events whose id disagrees with the
 * tracked active turn — an inconsistent id yields a turn that hangs with
 * nothing in any log. And the stale-request `detail` strings are matched by
 * substring upstream to render a friendly "no longer waiting" activity;
 * different wording turns that into a raw error banner.
 *
 * @module provider/Layers/T3AgentAdapter
 */
import { type ProviderSession, TurnId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";

import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { makeRuntimeEventEmitter } from "../../agent/events/emitter.ts";
import {
  runTurn,
  setSessionStatus,
  type AgentSessionContext,
} from "../../agent/loop/AgentSession.ts";
import { createSessionStore } from "../../agent/loop/sessionStore.ts";
import { resolveLanguageModel } from "../../agent/model/resolveLanguageModel.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { T3AgentAdapterOptions, T3AgentAdapterShape } from "../Services/T3AgentAdapter.ts";

const PROVIDER = T3AGENT_DRIVER_KIND;

export const makeT3AgentAdapter = Effect.fnUntraced(function* (options: T3AgentAdapterOptions) {
  const store = createSessionStore(PROVIDER);
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const events = yield* makeRuntimeEventEmitter({ provider: PROVIDER, uuid, nowIso });

  const startSession: T3AgentAdapterShape["startSession"] = Effect.fn("t3agent/startSession")(
    function* (input) {
      const credential = options.credential();
      if (credential._tag === "Missing") {
        // Named so the UI can tell the user exactly what to set, rather than
        // reporting an unexplained unavailable provider.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session.start",
          detail: `No API key found. Set ${credential.variableName} for this provider instance.`,
        });
      }

      const model = input.modelSelection?.model ?? options.defaultModel;
      const createdAt = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        model,
        createdAt,
        updatedAt: createdAt,
      };

      store.create({
        session,
        model,
        // Transport is baked in here, once, so a turn requires nothing further.
        modelLayer: Layer.provide(
          resolveLanguageModel({ backend: "anthropic", credential: credential.key, model }),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
      });

      yield* events.sessionStarted(input.threadId);
      yield* events.threadStarted(input.threadId);
      return session;
    },
  );

  const sendTurn: T3AgentAdapterShape["sendTurn"] = Effect.fn("t3agent/sendTurn")(
    function* (input) {
      const context = yield* store.require(input.threadId);
      // Minted here and stamped on every event below — see the module note.
      const turnId = TurnId.make(yield* uuid);
      const threadId = input.threadId;

      setSessionStatus(context, "running", yield* nowIso);
      yield* events.turnStarted({ threadId, turnId, model: context.model });

      const outcome = yield* Effect.exit(runTurn(context, { text: input.input ?? "" }));
      setSessionStatus(context, "ready", yield* nowIso);

      if (outcome._tag === "Success") {
        if (outcome.value.text !== "") {
          yield* events.assistantText({ threadId, turnId, delta: outcome.value.text });
        }
        context.turns.push({ id: turnId, items: [] });
        yield* events.turnCompleted({ threadId, turnId, state: "completed" });
      } else {
        yield* events.turnCompleted({
          threadId,
          turnId,
          state: "failed",
          errorMessage: describeFailure(outcome.cause),
        });
      }

      return { threadId, turnId };
    },
  );

  const stopContext = Effect.fnUntraced(function* (context: AgentSessionContext) {
    if (!store.close(context, yield* nowIso)) {
      return;
    }
    yield* events.sessionExited({ threadId: context.session.threadId, exitKind: "graceful" });
  });

  const stopAll: T3AgentAdapterShape["stopAll"] = () =>
    Effect.forEach(store.all(), stopContext, { discard: true });

  // A finalizer cannot fail, so anything unexpected while releasing the
  // instance scope is a defect rather than a swallowed error.
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.andThen(events.shutdown), Effect.orDie, Effect.asVoid),
  );

  return {
    provider: PROVIDER,
    // We own the conversation, so a model change is just a different layer on
    // the next turn. No other provider here can say that.
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn: Effect.fn("t3agent/interruptTurn")(function* (threadId) {
      // A turn is a single awaited call today, so there is nothing to cancel
      // between steps. Validating the session still gives the caller a real
      // answer instead of a silent success against a dead thread.
      yield* store.require(threadId);
    }),
    respondToRequest: Effect.fn("t3agent/respondToRequest")(function* (threadId, requestId) {
      yield* store.require(threadId);
      // Load-bearing wording: matched by substring upstream. See module note.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "permission.reply",
        detail: `Unknown pending permission request: ${requestId}`,
      });
    }),
    respondToUserInput: Effect.fn("t3agent/respondToUserInput")(function* (threadId, requestId) {
      yield* store.require(threadId);
      // Load-bearing wording: matched by substring upstream. See module note.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "question.reply",
        detail: `Unknown pending user-input request: ${requestId}`,
      });
    }),
    stopSession: Effect.fn("t3agent/stopSession")(function* (threadId) {
      const context = store.get(threadId);
      // Stopping an unknown session is a no-op, not an error: the caller wanted
      // it gone and it is gone.
      if (context) {
        yield* stopContext(context);
      }
    }),
    listSessions: () => Effect.sync(store.list),
    hasSession: (threadId) => Effect.sync(() => store.isLive(threadId)),
    readThread: Effect.fn("t3agent/readThread")(function* (threadId) {
      return store.snapshot(yield* store.require(threadId), threadId);
    }),
    rollbackThread: Effect.fn("t3agent/rollbackThread")(function* (threadId, numTurns) {
      const context = yield* store.require(threadId);
      store.rollback(context, numTurns);
      return store.snapshot(context, threadId);
    }),
    stopAll,
    get streamEvents() {
      return events.stream;
    },
  } satisfies T3AgentAdapterShape;
});

function describeFailure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.trim() === "" ? "The agent turn failed." : text;
}
