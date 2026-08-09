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

import { asReasoningEffort, REASONING_EFFORTS } from "../model/reasoning.ts";
import { ToolFailure, toolFailure } from "../tools/failure.ts";
import { defineTool, type AgentTool, type ToolContributor } from "../tools/registry.ts";
import { checkApproval, checkTarget, type FleetPolicy } from "./fleet.ts";
import type { OrchestrationClient } from "./OrchestrationClient.ts";
import { planThreadStateChange, THREAD_STATE_ACTIONS } from "./threadLifecycle.ts";

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
        "List the coding agents available in T3 Code, so you can choose one to delegate to. " +
        "Read `billing` before choosing: 'subscription' means the user has already paid for " +
        "that agent's capacity, 'per-token' means each delegation adds to a bill.",
      parameters: Schema.Struct({}),
      success: Schema.Struct({
        providers: Schema.Array(
          Schema.Struct({
            instanceId: Schema.String,
            driverKind: Schema.String,
            displayName: Schema.String,
            available: Schema.Boolean,
            defaultModel: Schema.NullOr(Schema.String),
            billing: Schema.String,
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
          defaultModel: provider.defaultModel,
          billing: provider.billing,
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

/**
 * The most recently touched threads, newest first.
 *
 * A cap rather than the lot: a long-lived project accumulates hundreds, the
 * agent almost always wants the recent ones, and quietly returning everything
 * would spend the context window on threads from months ago. When the cap
 * bites, the result says so — a truncated list that claims to be complete is
 * how an agent concludes something does not exist.
 */
const THREAD_LIST_LIMIT = 40;

const listThreads = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_threads", {
      description:
        "List the recent threads in a project — including ones you did not start — so you can " +
        "read what another agent is doing or has already done. `lifecycle` is where the thread " +
        "sits in the user's inbox (active, settled, snoozed, pinned, archived) and `isRunning` " +
        "is whether a turn is in flight. Pair with read_delegated_thread or set_thread_state.",
      parameters: Schema.Struct({
        projectId: Schema.String.annotate({ description: "From list_projects." }),
      }),
      success: Schema.Struct({
        threads: Schema.Array(
          Schema.Struct({
            threadId: Schema.String,
            title: Schema.String,
            providerInstanceId: Schema.String,
            status: Schema.String,
            updatedAt: Schema.String,
            lifecycle: Schema.String,
            isRunning: Schema.Boolean,
          }),
        ),
        /** Present only when older threads were left out. */
        omitted: Schema.optional(Schema.Number),
      }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const all = yield* context.client.listThreads(params.projectId);
      const recent = [...all]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, THREAD_LIST_LIMIT);
      const omitted = all.length - recent.length;
      return {
        threads: recent.map((thread) => ({
          threadId: String(thread.threadId),
          title: thread.title,
          providerInstanceId: String(thread.providerInstanceId),
          status: thread.status,
          updatedAt: thread.updatedAt,
          lifecycle: thread.lifecycle,
          isRunning: thread.isRunning,
        })),
        ...(omitted > 0 ? { omitted } : {}),
      };
    }),
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
        reasoningEffort: Schema.optional(
          Schema.String.annotate({
            description:
              "How hard the other agent should think: none, minimal, low, medium, high, xhigh, or max. " +
              "Leave unset for its default. Higher costs more and takes longer; raise it for design " +
              "and debugging, lower it for mechanical work.",
          }),
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

      // Validated here rather than passed through: an effort the target does
      // not accept is rejected by its provider at the first request, which the
      // user sees as a delegation that failed for no visible reason.
      const effort = asReasoningEffort(params.reasoningEffort);
      if (params.reasoningEffort !== undefined && effort === undefined) {
        return yield* toolFailure(
          `"${params.reasoningEffort}" is not a reasoning level. Use one of: ${REASONING_EFFORTS.join(", ")}.`,
        );
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
        // `options` is the same per-model control surface the composer writes,
        // so an effort chosen here reaches the other agent by exactly the path
        // a person clicking the picker would have used.
        modelSelection: {
          instanceId: target.instanceId,
          model,
          ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
        },
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
        "Read a thread: what was asked, what the agent did, anything that failed, and what it " +
        "concluded. Use after delegate_to_agent to collect a result, or with a thread id from " +
        "list_threads to read work you did not start. Lines starting [failed] are errors, and a " +
        "header line counts any that happened earlier than the part shown.",
      parameters: Schema.Struct({ threadId: Schema.String }),
      success: Schema.Struct({ transcript: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      return { transcript: yield* context.client.readThread(ThreadId.make(params.threadId)) };
    }),
  );

/**
 * Moving a thread around the user's inbox.
 *
 * One tool for eight verbs. They are the same act — deciding whether the user
 * still has to look at something — and eight separate descriptions would be
 * charged on every request of every turn to say that eight times.
 *
 * No ownership check, deliberately. Tidying an inbox means tidying the threads
 * that are in it, not the subset this agent happens to have started, and every
 * action here is reversible by the inverse verb sitting next to it.
 */
const setThreadState = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("set_thread_state", {
      description:
        "Move a thread around the user's inbox: settle or unsettle it, archive or unarchive it, " +
        "snooze or unsnooze it, pin or unpin it. Works on any thread, not only ones you started. " +
        "Settling is the normal way to clear finished work; archiving removes it from the list " +
        "entirely. Read `lifecycle` from list_threads first so you do not act on a thread that " +
        "is already where you want it.",
      parameters: Schema.Struct({
        threadId: Schema.String.annotate({ description: "From list_threads." }),
        action: Schema.String.annotate({
          description: `One of: ${THREAD_STATE_ACTIONS.join(", ")}.`,
        }),
        snoozeHours: Schema.optional(
          Schema.Number.annotate({
            description:
              "Required for snooze, ignored otherwise: how many hours to hide the thread for.",
          }),
        ),
      }),
      success: Schema.Struct({ applied: Schema.Boolean, lifecycleBefore: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const threadId = ThreadId.make(params.threadId);
      const thread = yield* context.client.getThread(threadId);
      if (thread === undefined) {
        return yield* toolFailure(
          `No thread with id "${params.threadId}". Call list_threads first.`,
        );
      }

      const plan = planThreadStateChange({
        action: params.action,
        threadId,
        commandId: CommandId.make(yield* context.nextId),
        nowIso: yield* context.nowIso,
        snoozeHours: params.snoozeHours,
        isRunning: thread.isRunning,
      });
      if (plan._tag === "Refused") {
        return yield* toolFailure(plan.reason);
      }

      const result = yield* context.client.dispatch(plan.command);
      if (!result.accepted) {
        return yield* toolFailure(
          `Could not ${params.action} that thread: ${result.detail ?? "rejected"}`,
        );
      }
      // The state it was in, not the state it is now: the agent asked for the
      // new one and knows what it is, but "it was already settled" is the fact
      // that stops it doing the same thing again on the next pass.
      return { applied: true, lifecycleBefore: thread.lifecycle };
    }),
  );

const renameThread = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("rename_thread", {
      description:
        "Give a thread a clearer title. Useful when a provider auto-named it something that does " +
        "not say what it ended up being about.",
      parameters: Schema.Struct({
        threadId: Schema.String,
        title: Schema.String.annotate({ description: "A short, specific title." }),
      }),
      success: Schema.Struct({ renamed: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const title = params.title.trim();
      if (title === "") {
        return yield* toolFailure("A title cannot be empty.");
      }
      // `thread.meta.update` also carries model selection, branch and worktree
      // path. Only the title is passed through: the other three change how and
      // where a thread runs, which is a decision about someone else's work.
      const result = yield* context.client.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(yield* context.nextId),
        threadId: ThreadId.make(params.threadId),
        title,
      });
      if (!result.accepted) {
        return yield* toolFailure(`Could not rename that thread: ${result.detail ?? "rejected"}`);
      }
      return { renamed: true };
    }),
  );

const stopDelegated = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("stop_delegated_thread", {
      // Said plainly because it used to say "a thread you started", which no
      // code enforced. The agent believed the description over its own reach
      // and told the user it could not stop threads it in fact could.
      description:
        "Interrupt a running thread when its answer is no longer needed. Works on any thread, " +
        "not only ones you started.",
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

/**
 * Three thread commands exist and are deliberately not offered here.
 *
 * `thread.delete` is the only one of these with no inverse. Everything else the
 * agent can do to a thread is undone by the verb next to it; a deletion is
 * gone, and there is no checkpoint to walk it back. That is a decision for the
 * person whose work it was.
 *
 * `thread.runtime-mode.set` and `thread.interaction-mode.set` change how much
 * another thread is allowed to do without asking. An agent that can raise a
 * thread's permissions has escalated its own by starting work there afterwards,
 * and no fleet limit catches that — the limit counts threads, not authority.
 */
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
              listThreads(context),
              delegate(context),
              readDelegated(context),
              setThreadState(context),
              renameThread(context),
              stopDelegated(context),
              revertDelegated(context),
              ...(context.policy.allowApprovingRequests ? [approveRequest(context)] : []),
            ],
      ),
  };
}
