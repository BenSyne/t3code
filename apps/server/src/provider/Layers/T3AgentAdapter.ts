/**
 * T3AgentAdapter — the built-in agent as a provider.
 *
 * Every other adapter here translates a subprocess's native protocol. This one
 * has no subprocess: sessions are objects in a Map and a turn is a function
 * call. The contract is identical, which is the point — orchestration,
 * checkpointing, remote access and the clients cannot tell the difference.
 *
 * Three behaviours below look arbitrary and are not. `sendTurn` mints the
 * `TurnId` and stamps it on every event for that turn, because the strict
 * lifecycle guard silently drops turn events whose id disagrees with the
 * tracked active turn — an inconsistent id yields a turn that hangs with
 * nothing in any log. The stale-request `detail` strings are matched by
 * substring upstream to render a friendly "no longer waiting" activity;
 * different wording turns that into a raw error banner. And `sendTurn` returns
 * as soon as the turn is *running*, not when it finishes, because that is what
 * every other adapter does and what the streaming UI expects.
 *
 * @module provider/Layers/T3AgentAdapter
 */
import {
  RuntimeRequestId,
  type CanonicalRequestType,
  type ProviderSession,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Prompt from "effect/unstable/ai/Prompt";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { makeRuntimeEventEmitter } from "../../agent/events/emitter.ts";
import { setSessionStatus, type AgentSessionContext } from "../../agent/loop/AgentSession.ts";
import { makeAgentConcurrency } from "../../agent/loop/concurrency.ts";
import { decidePermission } from "../../agent/permission/decide.ts";
import { makeApprovalGate } from "../../agent/permission/Gate.ts";
import { subjectForTool } from "../../agent/permission/profile.ts";
import { runTurn } from "../../agent/loop/runTurn.ts";
import { createSessionStore } from "../../agent/loop/sessionStore.ts";
import { resolveLanguageModel } from "../../agent/model/resolveLanguageModel.ts";
import { readProjectContext } from "../../agent/prompt/agentsMd.ts";
import { buildSystemPrompt } from "../../agent/prompt/systemPrompt.ts";
import { coreTools } from "../../agent/tools/core.ts";
import { buildToolkit, resolveTools } from "../../agent/tools/registry.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { T3AgentAdapterOptions, T3AgentAdapterShape } from "../Services/T3AgentAdapter.ts";

const PROVIDER = T3AGENT_DRIVER_KIND;

export const makeT3AgentAdapter = Effect.fnUntraced(function* (options: T3AgentAdapterOptions) {
  const store = createSessionStore(PROVIDER);
  const httpClient = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const concurrency = yield* makeAgentConcurrency();
  // Turns are forked into the adapter's own scope, not the caller's: `sendTurn`
  // returns immediately, so the turn must outlive the call that started it and
  // die with the instance rather than with the request.
  const instanceScope = yield* Effect.scope;
  const gate = yield* makeApprovalGate;
  // A request event must carry the turn it belongs to, and the tool that raises
  // it is several frames below the turn that started it.
  const activeTurns = new Map<ThreadId, TurnId>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const events = yield* makeRuntimeEventEmitter({ provider: PROVIDER, uuid, nowIso });

  /**
   * Decide, and ask the user if the decision is to ask.
   *
   * The wait is a `Deferred` held by the gate; the client answers through
   * `respondToRequest`. If the session closes first, the gate denies everything
   * outstanding, so no tool is left waiting on a person who has gone away.
   */
  const askForApproval = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly mode: RuntimeMode;
    readonly toolName: string;
    readonly target: string;
  }) {
    const outcome = decidePermission({
      mode: input.mode,
      toolName: input.toolName,
      target: input.target,
      rules: options.permissionRules,
    });

    if (outcome.decision === "allow") {
      return { _tag: "Allowed" as const };
    }
    if (outcome.decision === "deny") {
      return {
        _tag: "Denied" as const,
        reason: `Not permitted: ${outcome.reason ?? "a rule you set"} blocks this.`,
      };
    }

    const requestId = RuntimeRequestId.make(yield* uuid);
    const turnId = activeTurns.get(input.threadId);
    const requestType = requestTypeFor(input.toolName);
    const detail =
      outcome.reason === undefined ? input.target : `${input.target} — ${outcome.reason}`;

    if (turnId !== undefined) {
      yield* events.requestOpened({
        threadId: input.threadId,
        turnId,
        requestId,
        requestType,
        detail,
        args: { toolName: input.toolName, target: input.target },
      });
    }

    const decision = yield* gate.await({
      requestId,
      toolName: input.toolName,
      target: input.target,
      reason: outcome.reason,
    });

    if (turnId !== undefined) {
      yield* events.requestResolved({
        threadId: input.threadId,
        turnId,
        requestId,
        requestType,
        decision,
      });
    }

    return decision === "approved"
      ? { _tag: "Allowed" as const }
      : { _tag: "Denied" as const, reason: "You declined this action." };
  });

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
      const workspaceRoot = input.cwd ?? process.cwd();
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

      const toolContext = {
        workspaceRoot,
        fileSystem,
        spawner,
        commandEnv: options.commandEnv,
        requestApproval: (request: { readonly toolName: string; readonly target: string }) =>
          askForApproval({ threadId: input.threadId, mode: input.runtimeMode, ...request }),
      };
      const resolved = yield* resolveTools([coreTools], toolContext);
      const toolkit = yield* buildToolkit(resolved.tools);

      for (const dropped of resolved.dropped) {
        yield* events.warning({
          threadId: input.threadId,
          message: `Tool "${dropped.toolName}" from ${dropped.contributor} was ignored: ${dropped.keptFrom} already provides it.`,
        });
      }

      const projectContext = yield* readProjectContext({ fileSystem, workspaceRoot });
      const systemPrompt = buildSystemPrompt({
        workspaceRoot,
        projectContext: projectContext.text,
        toolNames: resolved.tools.map((entry) => entry.tool.name),
      });

      store.create({
        session,
        model,
        // Transport is baked in here, once, so a turn requires nothing further.
        modelLayer: Layer.provide(
          resolveLanguageModel({ backend: options.backend, credential: credential.key, model }),
          Layer.succeed(HttpClient.HttpClient, httpClient),
        ),
        workspaceRoot,
        toolkit,
        contextWindow: options.contextWindowFor(model),
        prompt: Prompt.make([{ role: "system", content: systemPrompt }]),
      });

      yield* events.sessionStarted(input.threadId);
      yield* events.threadStarted(input.threadId);
      return session;
    },
  );

  /**
   * Run a turn to completion and report how it ended.
   *
   * Everything here is deliberately failure-tolerant: this runs detached, so a
   * failure that escaped would be an unhandled fiber death with no turn-completed
   * event, and the UI would show a turn spinning forever.
   */
  const executeTurn = Effect.fnUntraced(function* (input: {
    readonly context: AgentSessionContext;
    readonly turnId: TurnId;
    readonly text: string;
  }) {
    const { context, turnId } = input;
    const threadId = context.session.threadId;
    const promptLengthBefore = context.prompt.content.length;

    context.prompt = Prompt.concat(
      context.prompt,
      Prompt.make([{ role: "user", content: [{ type: "text", text: input.text }] }]),
    );

    const outcome = yield* Effect.exit(
      runTurn({
        threadId,
        turnId,
        model: context.model,
        contextWindow: context.contextWindow,
        prompt: context.prompt,
        toolkit: context.toolkit,
        emitter: events,
        isInterrupted: () => context.interrupted,
      }).pipe(Effect.provide(context.modelLayer)),
    );

    setSessionStatus(context, "ready", yield* nowIso);
    context.interrupted = false;
    context.running = null;
    activeTurns.delete(threadId);

    if (outcome._tag !== "Success") {
      yield* events.turnCompleted({
        threadId,
        turnId,
        state: "failed",
        errorMessage: describeFailure(outcome.cause),
      });
      return;
    }

    const result = outcome.value;
    context.prompt = result.prompt;
    context.usage = result.usage;
    context.turns.push({ id: turnId, items: [], promptLengthBefore });

    yield* events.turnCompleted({
      threadId,
      turnId,
      state: result.stopReason === "interrupted" ? "interrupted" : "completed",
      stopReason: result.stopReason,
    });
  });

  const sendTurn: T3AgentAdapterShape["sendTurn"] = Effect.fn("t3agent/sendTurn")(
    function* (input) {
      const context = yield* store.require(input.threadId);
      // Minted here and stamped on every event below — see the module note.
      const turnId = TurnId.make(yield* uuid);
      const threadId = input.threadId;

      context.interrupted = false;
      activeTurns.set(threadId, turnId);
      setSessionStatus(context, "running", yield* nowIso);
      yield* events.turnStarted({ threadId, turnId, model: context.model });

      // Detached: the caller gets the ids now and watches the event stream, the
      // same as it would for a provider running in another process.
      context.running = yield* Effect.forkIn(
        concurrency.withTurnSlot(
          threadId,
          executeTurn({ context, turnId, text: input.input ?? "" }),
        ),
        instanceScope,
      );

      return { threadId, turnId };
    },
  );

  const stopContext = Effect.fnUntraced(function* (context: AgentSessionContext) {
    context.interrupted = true;
    // Before anything else: a tool parked on an approval would otherwise wait
    // forever for a person who is no longer there, and the turn would never end.
    yield* gate.rejectAll;
    const running = context.running;
    if (running !== null) {
      yield* Fiber.interrupt(running);
      context.running = null;
    }
    if (!store.close(context, yield* nowIso)) {
      return;
    }
    concurrency.forget(context.session.threadId);
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
      const context = yield* store.require(threadId);
      // A flag, not a fiber interrupt: stopping mid-step would leave a tool call
      // with no result in the history and the next request would fail on it.
      context.interrupted = true;
    }),
    respondToRequest: Effect.fn("t3agent/respondToRequest")(
      function* (threadId, requestId, decision) {
        yield* store.require(threadId);
        const answered = yield* gate.resolve(
          requestId,
          decision === "accept" || decision === "acceptForSession" ? "approved" : "denied",
        );
        if (answered) {
          return;
        }
        // Load-bearing wording: matched by substring upstream. See module note.
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      },
    ),
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

/** Which prompt the client shows. A wrong pick renders the wrong dialog. */
function requestTypeFor(toolName: string): CanonicalRequestType {
  switch (subjectForTool(toolName)) {
    case "command":
      return "command_execution_approval";
    case "edit":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
  }
}

function describeFailure(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.trim() === "" ? "The agent turn failed." : text;
}
