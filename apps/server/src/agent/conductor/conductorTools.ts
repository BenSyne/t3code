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

import {
  asReasoningEffort,
  nearestAcceptedEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../model/reasoning.ts";
import { ToolFailure, toolFailure } from "../tools/failure.ts";
import { defineTool, type AgentTool, type ToolContributor } from "../tools/registry.ts";
import { checkApproval, checkTarget, type FleetPolicy } from "./fleet.ts";
import type { OrchestrationClient } from "./OrchestrationClient.ts";
import {
  orderForAttention,
  planThreadStateChange,
  THREAD_STATE_ACTIONS,
} from "./threadLifecycle.ts";

export interface ConductorContext {
  readonly client: OrchestrationClient;
  readonly policy: FleetPolicy;
  /** This agent's own driver kind, for the self-targeting guard. */
  readonly selfDriverKind: string;
  /** Fresh ids. Commands are rejected without a unique one. */
  readonly nextId: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

const listProviders = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_providers", {
      description:
        "List the coding agents available in T3 Code, so you can choose one to delegate to. " +
        "Read `billing` before choosing: 'subscription' means the user has already paid for " +
        "that agent's capacity, 'per-token' means each delegation adds to a bill. " +
        "`defaultModel` is what a delegation uses when you name none; call list_models to see " +
        "the rest.",
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

/**
 * What an instance can actually be pointed at.
 *
 * Its own tool rather than a field on `list_providers`, because a workspace
 * with a couple of aggregator instances has hundreds of models between them
 * and "who can I delegate to" is asked far more often than "and on which
 * model". This is the call that stops the agent guessing a slug: before it
 * existed, asked which model to use it either invented a plausible name or
 * hedged about what the user's picker showed, having no way to look.
 */
const listModels = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_models", {
      description:
        "List the models one agent can be pointed at, with the reasoning levels each of them " +
        "accepts. Call this before naming a model in delegate_to_agent — never guess a slug, and " +
        "never describe a model you have not seen here. `reasoningEfforts` is per model: an empty " +
        "list means that model has no reasoning control, so passing one does nothing.",
      parameters: Schema.Struct({
        providerInstanceId: Schema.String.annotate({ description: "From list_providers." }),
      }),
      success: Schema.Struct({
        models: Schema.Array(
          Schema.Struct({
            slug: Schema.String,
            name: Schema.String,
            isDefault: Schema.Boolean,
            isLegacy: Schema.Boolean,
            vendor: Schema.NullOr(Schema.String),
            reasoningEfforts: Schema.Array(Schema.String),
          }),
        ),
      }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const models = yield* context.client.listModels(params.providerInstanceId);
      if (models.length === 0) {
        // Distinguished from an empty answer: "no models" and "no such
        // instance" would otherwise both read as "that agent has nothing".
        const providers = yield* context.client.listProviders;
        const known = providers.some(
          (provider) => String(provider.instanceId) === params.providerInstanceId,
        );
        if (!known) {
          return yield* toolFailure(
            `No provider with id "${params.providerInstanceId}". Call list_providers first.`,
          );
        }
      }
      return { models: models.map((model) => ({ ...model })) };
    }),
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
 * The threads worth looking at, most in need of someone first.
 *
 * A cap rather than the lot: a long-lived project accumulates hundreds, the
 * agent almost always wants the recent ones, and quietly returning everything
 * would spend the context window on threads from months ago. When the cap
 * bites, the result says so — a truncated list that claims to be complete is
 * how an agent concludes something does not exist.
 *
 * Ordered by `orderForAttention` rather than by time, so the cap can never be
 * what hides a thread that is blocked waiting for an answer.
 */
const THREAD_LIST_LIMIT = 40;

const listThreads = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("list_threads", {
      description:
        "List the recent threads in a project — including ones you did not start — so you can " +
        "read what another agent is doing or has already done. Anything blocked comes first, then " +
        "most recently touched. `lifecycle` is where the thread " +
        "sits in the user's inbox (active, settled, snoozed, pinned, archived) and `isRunning` " +
        "is whether a turn is in flight. `awaitingInput` or `awaitingApproval` means it has " +
        "stopped and is waiting on a person — it will not move until someone answers, so polling " +
        "it is pointless. Pair with read_delegated_thread or set_thread_state.",
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
            awaitingInput: Schema.Boolean,
            awaitingApproval: Schema.Boolean,
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
      const recent = orderForAttention(all).slice(0, THREAD_LIST_LIMIT);
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
          awaitingInput: thread.awaitingInput,
          awaitingApproval: thread.awaitingApproval,
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
        "The thread runs on its own and nothing will tell you when it finishes — use " +
        "read_delegated_thread to look. Do not promise the user you will watch it or report back.",
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
      success: Schema.Struct({
        threadId: Schema.String,
        /** Present only when the requested reasoning level was adjusted. */
        note: Schema.optional(Schema.String),
      }),
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

      // Snapped to what the chosen model actually offers, rather than
      // refused. This used to be a hard error, and it fired constantly — the
      // agent would ask GPT-5.6-Sol for "minimal" on a lineup that starts at
      // "low" and burn a round trip learning something the ordering already
      // implied. The scale is ordered, so an unavailable level still says
      // which direction was wanted.
      //
      // Only where the model advertises a set: an empty one means "not
      // advertised", not "none allowed", and snapping on that would break
      // every driver that publishes no descriptors.
      let effortSent = effort;
      let effortNote: string | undefined;
      if (effort !== undefined) {
        const models = yield* context.client.listModels(params.providerInstanceId);
        const chosen = models.find((candidate) => candidate.slug === model);
        const accepted = chosen?.reasoningEfforts ?? [];
        if (accepted.length > 0) {
          const snapped = nearestAcceptedEffort(effort, accepted as ReadonlyArray<ReasoningEffort>);
          if (snapped !== undefined && snapped !== effort) {
            effortSent = snapped;
            effortNote = `${chosen?.name ?? model} does not offer "${effort}"; used "${snapped}".`;
          }
        }
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
          ...(effortSent === undefined
            ? {}
            : { options: [{ id: "reasoningEffort", value: effortSent }] }),
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

      return {
        threadId: String(threadId),
        ...(effortNote === undefined ? {} : { note: effortNote }),
      };
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

/**
 * A follow-up on a thread that already exists.
 *
 * Without this, delegation was one-shot: `delegate_to_agent` always mints a new
 * thread, so "tell Codex it got that null check wrong" meant starting again
 * with none of the context the correction depends on. Supervising work is the
 * point of orchestrating it, and supervision is a second message.
 */
const sendToThread = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("send_to_thread", {
      description:
        "Send a follow-up message to a thread that already exists, keeping everything it has " +
        "already done. Use this to correct or extend work rather than starting a fresh " +
        "delegation, which would lose the context. For a question the thread is blocked on, use " +
        "answer_thread_question instead.",
      parameters: Schema.Struct({
        threadId: Schema.String.annotate({
          description: "From delegate_to_agent or list_threads.",
        }),
        message: Schema.String.annotate({ description: "What to say to that agent." }),
      }),
      success: Schema.Struct({ sent: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const message = params.message.trim();
      if (message === "") {
        return yield* toolFailure("There is no point sending an empty message.");
      }
      const threadId = ThreadId.make(params.threadId);
      const thread = yield* context.client.getThread(threadId);
      if (thread === undefined) {
        return yield* toolFailure(
          `No thread with id "${params.threadId}". Call list_threads first.`,
        );
      }
      // Refused rather than queued: what a second turn does to a thread already
      // mid-turn is the provider's business and they do not agree — some steer,
      // some reject, some quietly drop it. Waiting is the one behaviour that
      // means the same thing everywhere.
      if (thread.isRunning) {
        return yield* toolFailure(
          "That thread is mid-turn. Wait for it to finish, or stop it first with stop_delegated_thread.",
        );
      }
      if (thread.awaitingInput) {
        return yield* toolFailure(
          "That thread is blocked on a question. Read it, then answer with answer_thread_question — an ordinary message will not unblock it.",
        );
      }

      const result = yield* context.client.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(yield* context.nextId),
        threadId,
        message: {
          messageId: MessageId.make(yield* context.nextId),
          role: "user",
          text: message,
          attachments: [],
        },
        // Required by the command schema and ignored for a thread that already
        // exists — the decider reads the thread's own runtime and interaction
        // modes, not these. That is the property that makes this tool safe to
        // point at a thread the user configured: a follow-up cannot quietly
        // change what that thread is allowed to do.
        runtimeMode: "auto" satisfies RuntimeMode,
        interactionMode: "default",
        createdAt: yield* context.nowIso,
      });
      if (!result.accepted) {
        return yield* toolFailure(`Could not send that: ${result.detail ?? "rejected"}`);
      }
      return { sent: true };
    }),
  );

/**
 * Answering a question a delegated thread is stuck on.
 *
 * Restricted to threads this agent started, and — unlike the claim that used to
 * sit on `stop_delegated_thread` — actually enforced. The distinction is real:
 * settling or stopping a thread is neutral and reversible, while an answer is
 * put into the user's mouth and acted on. In a thread the agent wrote the task
 * for, it is the best-placed party to say what it meant. In one it has never
 * seen, it would be guessing on someone else's behalf.
 */
const answerQuestion = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("answer_thread_question", {
      description:
        "Answer a question a thread you started is blocked on. read_delegated_thread shows the " +
        "request id, the question ids, and the exact option labels. Answer with those labels " +
        "verbatim — a value that is not one of them will be rejected. Only answer what the task " +
        "you set actually settles; if the question needs the user's judgement, ask them instead.",
      parameters: Schema.Struct({
        threadId: Schema.String,
        requestId: Schema.String.annotate({ description: "From read_delegated_thread." }),
        answers: Schema.Record(
          Schema.String,
          // A union because the two kinds of question take different shapes:
          // a single-choice answer is one label, a multi-select is the list.
          // Typed as string-only, every multi-select question would have been
          // unanswerable.
          Schema.Union([Schema.String, Schema.Array(Schema.String)]),
        ).annotate({
          description:
            "Question id to the chosen option label. Use a list of labels for a question marked " +
            "'choose one or more', a single label otherwise.",
        }),
      }),
      success: Schema.Struct({ answered: Schema.Boolean }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const threadId = ThreadId.make(params.threadId);
      const pending = yield* context.client.pendingInput(threadId);
      const request = pending.find((entry) => entry.requestId === params.requestId);
      if (request === undefined) {
        return yield* toolFailure(
          pending.length === 0
            ? "That thread is not waiting on a question."
            : `No pending request "${params.requestId}". Open ones: ${pending.map((entry) => entry.requestId).join(", ")}.`,
        );
      }
      // Checked here so a wrong shape is a sentence the model can act on
      // rather than a rejection from a provider that only says "invalid".
      const missing = request.questions
        .filter((question) => params.answers[question.id] === undefined)
        .map((question) => question.id);
      if (missing.length > 0) {
        return yield* toolFailure(
          `Every question needs an answer. Missing: ${missing.join(", ")}.`,
        );
      }
      // Labels are matched exactly because that is what the provider matches
      // on. A near-miss — right idea, reworded — is rejected downstream with a
      // message that does not say which value was wrong.
      for (const question of request.questions) {
        const given = params.answers[question.id];
        const chosen = Array.isArray(given) ? given : [given];
        if (!question.multiSelect && chosen.length > 1) {
          return yield* toolFailure(`"${question.id}" takes a single answer, not several.`);
        }
        if (question.options.length === 0) {
          continue;
        }
        const unknown = chosen.filter((label) => !question.options.includes(label as string));
        if (unknown.length > 0) {
          return yield* toolFailure(
            `"${unknown.join('", "')}" is not an option for "${question.id}". Use one of: ${question.options.join(", ")}.`,
          );
        }
      }

      const result = yield* context.client.dispatch({
        type: "thread.user-input.respond",
        commandId: CommandId.make(yield* context.nextId),
        threadId,
        requestId: ApprovalRequestId.make(params.requestId),
        answers: params.answers,
        createdAt: yield* context.nowIso,
      });
      if (!result.accepted) {
        return yield* toolFailure(`Could not answer: ${result.detail ?? "rejected"}`);
      }
      return { answered: true };
    }),
  );

const createProject = (context: ConductorContext): AgentTool =>
  defineTool(
    Tool.make("create_project", {
      description:
        "Add a project to T3 Code for a directory on this machine, so threads can be started in " +
        "it. Check list_projects first — a directory that is already a project does not need a " +
        "second one.",
      parameters: Schema.Struct({
        title: Schema.String.annotate({ description: "What to call it in the sidebar." }),
        workspaceRoot: Schema.String.annotate({
          description: "Absolute path to the directory. It must already exist.",
        }),
      }),
      success: Schema.Struct({ projectId: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
    }),
    Effect.fnUntraced(function* (params) {
      const title = params.title.trim();
      const workspaceRoot = params.workspaceRoot.trim();
      if (title === "" || workspaceRoot === "") {
        return yield* toolFailure("A project needs both a title and a directory.");
      }
      const existing = yield* context.client.listProjects;
      const already = existing.find((project) => project.workspaceRoot === workspaceRoot);
      if (already !== undefined) {
        // Reported as a success rather than an error: the caller wanted a
        // project for that directory and there is one, so handing back its id
        // is the useful answer and a duplicate is not.
        return { projectId: String(already.id) };
      }

      const projectId = ProjectId.make(yield* context.nextId);
      const result = yield* context.client.dispatch({
        type: "project.create",
        commandId: CommandId.make(yield* context.nextId),
        projectId,
        title,
        workspaceRoot,
        // Never creates the directory. A mistyped path should fail loudly, not
        // leave an empty folder somewhere in the user's filesystem.
        createWorkspaceRootIfMissing: false,
        createdAt: yield* context.nowIso,
      });
      if (!result.accepted) {
        return yield* toolFailure(`Could not create that project: ${result.detail ?? "rejected"}`);
      }
      return { projectId: String(projectId) };
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
              listModels(context),
              listProjects(context),
              listThreads(context),
              createProject(context),
              delegate(context),
              sendToThread(context),
              readDelegated(context),
              answerQuestion(context),
              setThreadState(context),
              renameThread(context),
              stopDelegated(context),
              revertDelegated(context),
              ...(context.policy.allowApprovingRequests ? [approveRequest(context)] : []),
            ],
      ),
  };
}
