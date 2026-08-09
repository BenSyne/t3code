/**
 * Tools for running other agents.
 *
 * From a phone: "review this PR with Codex and Claude in parallel and tell me
 * where they disagree." Both threads appear in the sidebar, stream live, and
 * stay independently inspectable, interruptible, and revertable — because they
 * are ordinary threads, started through the ordinary command path.
 *
 * Every tool here goes through {@link OrchestrationClient}. None of them
 * imports the provider service or the decider, which is the property that keeps
 * this an integration rather than a back door.
 *
 * @module agent/conductor/conductorTools
 */
import {
  CommandId,
  ApprovalRequestId,
  MessageId,
  ProjectId,
  ThreadId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { ToolFailure, toolFailure } from "../tools/failure.ts";
import { defineTool, type AgentTool, type ToolContributor } from "../tools/registry.ts";
import { checkApproval, checkTarget, type FleetPolicy } from "./fleet.ts";
import type { OrchestrationClient } from "./OrchestrationClient.ts";

export interface ConductorContext {
  readonly client: OrchestrationClient;
  readonly policy: FleetPolicy;
  /** This agent's own driver kind, for the self-targeting guard. */
  readonly selfDriverKind: string;
  /** Fresh ids. Commands are rejected without a unique one. */
  readonly nextId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
  /** Threads this agent has started and not yet seen finish. */
  readonly runningThreads: () => number;
  readonly noteStarted: (threadId: ThreadId) => void;
}

const listProviders = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_providers", {
      description:
        "List the coding agents available in T3 Code, so you can choose one to delegate to.",
      parameters: Schema.Struct({}),
      success: Schema.Struct({
        providers: Schema.Array(
          Schema.Struct({
            instanceId: Schema.String,
            driverKind: Schema.String,
            displayName: Schema.String,
            available: Schema.Boolean,
          }),
        ),
      }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    () =>
      Effect.map(context.client.listProviders, (providers) => ({
        providers: providers.map((provider) => ({
          instanceId: String(provider.instanceId),
          driverKind: provider.driverKind,
          displayName: provider.displayName,
          available: provider.available,
        })),
      })),
  );

const listProjects = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_projects", {
      description: "List the projects in T3 Code, so you can start a thread in one.",
      parameters: Schema.Struct({}),
      success: Schema.Struct({
        projects: Schema.Array(
          Schema.Struct({
            projectId: Schema.String,
            title: Schema.String,
            workspaceRoot: Schema.String,
          }),
        ),
      }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    () =>
      Effect.map(context.client.listProjects, (projects) => ({
        projects: projects.map((project) => ({
          projectId: String(project.id),
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
      })),
  );

const delegate = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("delegate_to_agent", {
      description:
        "Start a thread with another coding agent and send it a task. Returns the thread id. " +
        "The thread runs on its own — use read_delegated_thread to see what it produced.",
      parameters: Schema.Struct({
        providerInstanceId: Schema.String.annotate({
          description: "From list_providers.",
        }),
        projectId: Schema.String.annotate({ description: "From list_projects." }),
        title: Schema.String.annotate({ description: "A short title for the thread." }),
        task: Schema.String.annotate({
          description: "The complete instructions for the other agent.",
        }),
        model: Schema.optional(
          Schema.String.annotate({ description: "Leave unset to use the provider's default." }),
        ),
      }),
      success: Schema.Struct({ threadId: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const providers = yield* context.client.listProviders;
      const target = providers.find(
        (provider) => String(provider.instanceId) === params.providerInstanceId,
      );
      if (target === undefined) {
        return yield* toolFailure(
          `No provider with id "${params.providerInstanceId}". Call list_providers first.`,
        );
      }
      if (!target.available) {
        return yield* toolFailure(`${target.displayName} is not available right now.`);
      }

      const verdict = checkTarget({
        policy: context.policy,
        targetDriverKind: target.driverKind,
        selfDriverKind: context.selfDriverKind,
        runningThreads: context.runningThreads(),
      });
      if (verdict._tag === "Refused") {
        return yield* toolFailure(verdict.reason);
      }

      const threadId = ThreadId.make(yield* context.nextId);
      const model = params.model ?? target.defaultModel;
      if (model === null) {
        return yield* toolFailure(
          `${target.displayName} has no default model. Pass one explicitly.`,
        );
      }

      const created = yield* context.client.dispatch({
        type: "thread.create",
        commandId: CommandId.make(yield* context.nextId),
        threadId,
        projectId: ProjectId.make(params.projectId),
        title: params.title,
        // `instanceId`, not `providerInstanceId`. The whole command was cast
        // to `never` before this file was wired to anything, and the cast hid
        // the wrong field name until a real delegation failed with a decode
        // error the tool could only report as "unknown error". The casts are
        // gone; the schema checks these payloads now.
        modelSelection: { instanceId: target.instanceId, model },
        // Delegated work runs unattended by definition — nobody is watching it
        // to answer a prompt — so it runs in the mode that does not raise them.
        runtimeMode: "auto" satisfies RuntimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: yield* context.nowIso,
      });

      if (!created.accepted) {
        return yield* toolFailure(`Could not start the thread: ${created.detail ?? "rejected"}`);
      }

      const started = yield* context.client.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(yield* context.nextId),
        threadId,
        message: {
          messageId: MessageId.make(yield* context.nextId),
          role: "user",
          text: params.task,
          attachments: [],
        },
        runtimeMode: "auto" satisfies RuntimeMode,
        interactionMode: "default",
        createdAt: yield* context.nowIso,
      });

      if (!started.accepted) {
        return yield* toolFailure(
          `The thread was created but the task did not start: ${started.detail ?? "rejected"}`,
        );
      }

      context.noteStarted(threadId);
      return { threadId: String(threadId) };
    }),
  );

const readDelegated = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("read_delegated_thread", {
      description:
        "Read what a thread has produced so far. Use after delegate_to_agent to collect the result.",
      parameters: Schema.Struct({ threadId: Schema.String }),
      success: Schema.Struct({ transcript: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const transcript = yield* context.client.readThread(ThreadId.make(params.threadId));
      return {
        transcript: transcript === "" ? "That thread has not produced anything yet." : transcript,
      };
    }),
  );

const stopDelegated = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("stop_delegated_thread", {
      description: "Interrupt a thread you started, when its answer is no longer needed.",
      parameters: Schema.Struct({ threadId: Schema.String }),
      success: Schema.Struct({ stopped: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const result = yield* context.client.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(yield* context.nextId),
        threadId: ThreadId.make(params.threadId),
        createdAt: yield* context.nowIso,
      });
      return { stopped: result.accepted };
    }),
  );

const revertDelegated = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("revert_delegated_thread", {
      description: "Undo the last turns of a thread you started, restoring the files it changed.",
      parameters: Schema.Struct({
        threadId: Schema.String,
        turnCount: Schema.Number.annotate({ description: "How many turns to undo." }),
      }),
      success: Schema.Struct({ reverted: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const result = yield* context.client.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make(yield* context.nextId),
        threadId: ThreadId.make(params.threadId),
        turnCount: Math.max(0, Math.floor(params.turnCount)),
        createdAt: yield* context.nowIso,
      });
      return { reverted: result.accepted };
    }),
  );

/**
 * Answering an approval on another thread.
 *
 * Contributed only when explicitly enabled. Absent otherwise rather than
 * present-and-refusing, so the model never learns that approving is something
 * it might be able to do.
 */
const approveRequest = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("approve_delegated_request", {
      description: "Answer an approval prompt that a thread you started is waiting on.",
      parameters: Schema.Struct({
        threadId: Schema.String,
        requestId: Schema.String,
        approve: Schema.Boolean,
      }),
      success: Schema.Struct({ answered: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const verdict = checkApproval(context.policy);
      if (verdict._tag === "Refused") {
        return yield* toolFailure(verdict.reason);
      }
      const result = yield* context.client.dispatch({
        type: "thread.approval.respond",
        commandId: CommandId.make(yield* context.nextId),
        threadId: ThreadId.make(params.threadId),
        requestId: ApprovalRequestId.make(params.requestId),
        decision: params.approve ? "accept" : "decline",
        createdAt: yield* context.nowIso,
      });
      return { answered: result.accepted };
    }),
  );

export function conductorContributor(context: ConductorContext | null): ToolContributor {
  return {
    name: "conductor",
    tools: () =>
      Effect.succeed(
        context === null
          ? []
          : [
              listProviders(context),
              listProjects(context),
              delegate(context),
              readDelegated(context),
              stopDelegated(context),
              revertDelegated(context),
              ...(context.policy.allowApprovingRequests ? [approveRequest(context)] : []),
            ],
      ),
  };
}
