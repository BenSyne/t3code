/**
 * One conversation with the built-in agent.
 *
 * A session owns the per-thread state a turn needs: the wire-visible
 * `ProviderSession` record, the resolved language model, the tools that turn
 * may call, and the running conversation. It knows nothing about the provider
 * adapter that holds it.
 *
 * The turn itself lives in `runTurn.ts`; this is the state it acts on.
 *
 * @module agent/loop/AgentSession
 */
import type { ProviderSession, ThreadId, TurnId } from "@t3tools/contracts";
import type * as Fiber from "effect/Fiber";
import type * as Layer from "effect/Layer";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";

import { EMPTY_USAGE, type UsageTally } from "../events/usage.ts";
import type { ReasoningEffort } from "../model/reasoning.ts";
import type { AgentToolkit } from "../tools/registry.ts";

/** A finished turn, with what it takes to undo it. */
export interface CompletedTurn {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
  /** Rollback truncates to this, which is exact because we own the history. */
  readonly promptLengthBefore: number;
}

export interface AgentSessionContext {
  /** The wire-visible record. Replaced in place as status changes. */
  session: ProviderSession;
  /**
   * Mutable, with the three fields below, because this adapter advertises
   * in-session model switching. Swap them only through `applyModelChoice` — a
   * layer built for one model under another's name misreports cost and context
   * for every following turn.
   */
  model: string;
  reasoningEffort: ReasoningEffort | undefined;
  /**
   * `HttpClient` is provided once at session creation, not per turn, so running
   * a turn requires nothing further — which is what lets the loop be tested
   * against a stub with no transport.
   */
  modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  /** Absolute path every tool in this session is confined to. */
  readonly workspaceRoot: string;
  readonly toolkit: AgentToolkit;
  /** For the usage meter's denominator. Null when the model's window is unknown. */
  contextWindow: number | null;
  /** Conversation so far. Replaced wholesale each turn; never mutated. */
  prompt: Prompt.Prompt;
  turns: Array<CompletedTurn>;
  usage: UsageTally;
  /** One-shot teardown latch, so stopping twice is a no-op. */
  stopped: boolean;
  /**
   * Set by `interruptTurn`, read by the loop between steps — a flag rather than
   * a fiber interrupt so a stopped turn keeps the work it already finished.
   *
   * A step that never finishes never reaches the check, which is why
   * `interruptRequests` exists.
   */
  interrupted: boolean;
  /**
   * A second ask means "stop it", and the adapter interrupts the fiber. Safe
   * because a running step's parts only reach the conversation on a normal
   * return: an abandoned step leaves a user message with no reply, which is
   * well-formed, rather than a tool call with no result.
   */
  interruptRequests: number;
  /** The turn in flight, if any. */
  running: Fiber.Fiber<void, never> | null;
}

export function makeSessionContext(input: {
  readonly session: ProviderSession;
  readonly model: string;
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  readonly workspaceRoot: string;
  readonly toolkit: AgentToolkit;
  readonly contextWindow: number | null;
  readonly prompt: Prompt.Prompt;
}): AgentSessionContext {
  return {
    session: input.session,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    modelLayer: input.modelLayer,
    workspaceRoot: input.workspaceRoot,
    toolkit: input.toolkit,
    contextWindow: input.contextWindow,
    prompt: input.prompt,
    turns: [],
    usage: EMPTY_USAGE,
    stopped: false,
    interrupted: false,
    interruptRequests: 0,
    running: null,
  };
}

/** What a mid-session model change swaps in. Built by the adapter, applied here. */
export interface ModelChoice {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly modelLayer: Layer.Layer<LanguageModel.LanguageModel>;
  readonly contextWindow: number | null;
}

/**
 * Switch what the session talks to. Called between turns, never during one.
 *
 * The wire-visible record is updated too: the orchestrator compares
 * `session.model` against the requested selection to decide whether a change
 * happened, so leaving it stale restarts sessions this adapter keeps alive.
 */
export function applyModelChoice(
  context: AgentSessionContext,
  choice: ModelChoice,
  updatedAt: string,
): void {
  context.model = choice.model;
  context.reasoningEffort = choice.reasoningEffort;
  context.modelLayer = choice.modelLayer;
  context.contextWindow = choice.contextWindow;
  context.session = { ...context.session, model: choice.model, updatedAt };
}

/** Mark a session closed. Idempotent: the second call is a no-op. */
export function closeSession(context: AgentSessionContext, updatedAt: string): boolean {
  if (context.stopped) {
    return false;
  }
  context.stopped = true;
  context.session = { ...context.session, status: "closed", updatedAt };
  return true;
}

/** Update a session's status without disturbing the rest of the record. */
export function setSessionStatus(
  context: AgentSessionContext,
  status: ProviderSession["status"],
  updatedAt: string,
): void {
  context.session = { ...context.session, status, updatedAt };
}

/** Sessions are keyed by thread: one live conversation per thread. */
export type AgentSessionMap = Map<ThreadId, AgentSessionContext>;
