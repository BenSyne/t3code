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
import * as Scope from "effect/Scope";
import * as Prompt from "effect/unstable/ai/Prompt";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { T3AGENT_DRIVER_KIND } from "../../agent/driverKind.ts";
import { makeRuntimeEventEmitter } from "../../agent/events/emitter.ts";
import { setSessionStatus, type AgentSessionContext } from "../../agent/loop/AgentSession.ts";
import { compactPrompt } from "../../agent/compaction/summarize.ts";
import { contextBudget, shouldCompact } from "../../agent/compaction/tokenBudget.ts";
import { makeAgentConcurrency } from "../../agent/loop/concurrency.ts";
import { decidePermission } from "../../agent/permission/decide.ts";
import { makeApprovalGate } from "../../agent/permission/Gate.ts";
import { subjectForTool } from "../../agent/permission/profile.ts";
import { runTurn } from "../../agent/loop/runTurn.ts";
import { createSessionStore } from "../../agent/loop/sessionStore.ts";
import { makeTranscriptStore } from "../../agent/state/TranscriptStore.ts";
import { resolveLanguageModel } from "../../agent/model/resolveLanguageModel.ts";
import { readProjectContext } from "../../agent/prompt/agentsMd.ts";
import { buildSystemPrompt } from "../../agent/prompt/systemPrompt.ts";
import { connectAll } from "../../agent/mcp/McpClientPool.ts";
import { mcpContributor } from "../../agent/mcp/mcpTools.ts";
import { BUILTIN_SKILLS } from "../../agent/knowledge/builtinSkills.ts";
import { discoverSkills, skillCatalogBlock } from "../../agent/skills/discover.ts";
import { skillContributor } from "../../agent/skills/skillTool.ts";
import { subagentContributor } from "../../agent/subagent/taskTool.ts";
import { coreTools } from "../../agent/tools/core.ts";
import { buildToolkit, resolveTools, type ToolContributor } from "../../agent/tools/registry.ts";
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
  const transcripts = makeTranscriptStore({
    fileSystem,
    directory: options.transcriptDirectory,
  });
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
      // Connected once per session rather than per turn: starting a subprocess
      // for every message would be slow and would lose whatever state the
      // server keeps between calls.
      const pool = yield* connectAll({
        servers: options.mcpServers,
        spawner,
        baseEnv: options.commandEnv,
        workspaceRoot,
        // The pool's reader fibers and subprocesses belong to the instance, not
        // to the request that happened to start the session.
      }).pipe(Effect.provideService(Scope.Scope, instanceScope));

      for (const status of pool.statuses) {
        if (status.state === "failed") {
          yield* events.warning({
            threadId: input.threadId,
            message: `MCP server "${status.name}" is unavailable: ${status.detail ?? "unknown reason"}. Its tools are not available this session.`,
          });
        }
      }

      const discovered = yield* discoverSkills({
        workspaceRoot,
        homeDirectory: options.homeDirectory,
      });

      // Built-in knowledge first, so a project skill of the same name wins —
      // a repository that ships its own `t3-providers` has decided what that
      // name should mean inside it.
      const skills = [
        ...BUILTIN_SKILLS.filter(
          (builtin) => !discovered.skills.some((found) => found.name === builtin.name),
        ),
        ...discovered.skills,
      ];

      for (const rejection of discovered.rejected) {
        yield* events.warning({
          threadId: input.threadId,
          message: `Skill at ${rejection.path} was skipped: ${rejection.reason}.`,
        });
      }

      // Built at a depth so a sub-agent's own toolkit can be built the same
      // way, one level down, and lose `task` at the cap.
      const modelLayer = Layer.provide(
        resolveLanguageModel({
          backend: options.backend,
          credential: credential.key,
          model,
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        }),
        Layer.succeed(HttpClient.HttpClient, httpClient),
      );

      const contributorsAtDepth = (depth: number): ReadonlyArray<ToolContributor> => [
        coreTools,
        skillContributor(skills),
        mcpContributor(pool.servers),
        subagentContributor({
          depth,
          systemPrompt: () => systemPrompt,
          contextWindow: options.contextWindowFor(model),
          toolkitForDepth: (childDepth) =>
            Effect.flatMap(resolveTools(contributorsAtDepth(childDepth), toolContext), (child) =>
              buildToolkit(child.tools),
            ),
          modelLayer,
          emitter: events,
          threadId: input.threadId,
          resolveTurnId: () => activeTurns.get(input.threadId),
          isInterrupted: () => store.get(input.threadId)?.interrupted === true,
        }),
      ];

      const resolved = yield* resolveTools(contributorsAtDepth(0), toolContext);
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
        skillCatalog: skillCatalogBlock(skills),
      });

      // Pick up where a previous server process left off, if it left anything.
      const resumed = yield* transcripts.read(input.threadId);
      const startingPrompt =
        resumed.content.length > 0
          ? Prompt.make([
              { role: "system" as const, content: systemPrompt },
              ...resumed.content.filter((message) => message.role !== "system"),
            ])
          : Prompt.make([{ role: "system" as const, content: systemPrompt }]);

      store.create({
        session,
        model,
        // Transport is baked in here, once, so a turn requires nothing further.
        modelLayer,
        workspaceRoot,
        toolkit,
        contextWindow: options.contextWindowFor(model),
        prompt: startingPrompt,
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

    // Compact before the request, not after: the point is to make room for the
    // turn that is about to run.
    yield* compactIfNeeded(context);

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
    // Only the messages this turn added, so the file grows by an append rather
    // than being rewritten every turn.
    yield* transcripts.append(threadId, result.prompt.content.slice(promptLengthBefore));
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

  /**
   * Summarise the older half of the conversation when it no longer fits.
   *
   * Every outcome continues the turn. A failed summary leaves the conversation
   * as it was and warns — the request may still succeed, and losing the user's
   * turn over a failed optimisation would be the worse trade.
   */
  const compactIfNeeded = Effect.fnUntraced(function* (context: AgentSessionContext) {
    if (
      !shouldCompact({
        usedTokens: context.usage.contextTokens,
        contextWindow: context.contextWindow,
      })
    ) {
      return;
    }

    const budget = contextBudget(context.contextWindow);
    const outcome = yield* compactPrompt({
      prompt: context.prompt,
      preserveTokens: budget.preserve,
    }).pipe(Effect.provide(context.modelLayer));

    switch (outcome._tag) {
      case "Compacted":
        context.prompt = outcome.prompt;
        yield* transcripts.replace(context.session.threadId, outcome.prompt);
        yield* events.warning({
          threadId: context.session.threadId,
          message: `The conversation was getting long, so ${outcome.summarisedMessages} earlier messages were replaced with a summary.`,
        });
        return;
      case "Failed":
        yield* events.warning({
          threadId: context.session.threadId,
          message: `Could not summarise the conversation (${outcome.detail}). Continuing without compacting.`,
        });
        return;
      case "NotNeeded":
        return;
    }
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
      // The file has to shrink too, or restarting resurrects the turns the user
      // just undid.
      yield* transcripts.replace(threadId, context.prompt);
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
