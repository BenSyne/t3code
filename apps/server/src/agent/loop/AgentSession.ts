/**
 * One conversation with the built-in agent.
 *
 * A session owns the per-thread state a turn needs: the wire-visible
 * `ProviderSession` record, the resolved language model, the tools that turn may
 * call, and the running conversation. It deliberately knows nothing about the
 * provider adapter that holds it — the adapter maps sessions to the T3 Code
 * contract, this maps them to a model.
 *
 * The turn itself lives in `runTurn.ts`. This file is the state it acts on, kept
 * separate so the loop can be read without the bookkeeping and the bookkeeping
 * can be changed without touching the loop.
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
  /**
   * How many messages the conversation held before this turn began.
   *
   * Rollback truncates to this, which is what makes it exact rather than
   * approximate: we own the history instead of asking a provider to rewind it.
   */
  readonly promptLengthBefore: number;
}

export interface AgentSessionContext {
  /** The wire-visible record. Replaced in place as status changes. */
  session: ProviderSession;
  /**
   * Mutable, together with the three fields below, because this adapter
   * advertises in-session model switching: T3 Code deliberately keeps the
   * session alive across a model change and trusts the next turn to honour
   * the new selection. Swap them only through `applyModelChoice`, which keeps
   * the four consistent — a layer built for one model under another's name
   * would misreport cost and context for every following turn.
   */
  model: string;
  /** How hard the model is asked to think, or undefined for its own default. */
  reasoningEffort: ReasoningEffort | undefined;
  /**
   * A ready-to-use model. `HttpClient` is provided once when the session is
   * created, not per turn, so running a turn requires nothing further — which
   * is what lets the loop be tested against a stub with no transport at all.
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
   * Set by `interruptTurn`, read by the loop between steps.
   *
   * A flag rather than a fiber interrupt, so a stopped turn keeps the work it
   * already finished: the loop notices between steps and returns the tool
   * results and text it has, rather than throwing the step away.
   *
   * That is the right default and a bad only option. A step that never
   * finishes — a provider holding a stream open, a model generating without
   * end — never reaches the check, so Stop appears to do nothing and there is
   * no way out. See `interruptRequests`.
   */
  interrupted: boolean;
  /**
   * How many times the user has asked for this turn to stop.
   *
   * Asking twice means "I do not care about a tidy ending, stop it", and the
   * adapter interrupts the fiber on the second ask. Safe because the running
   * step's parts are local to the loop and only reach the conversation when it
   * returns normally — an abandoned step leaves the user's message with no
   * reply, which is well-formed, rather than a tool call with no result.
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
 * Switch what the session talks to, atomically from the loop's point of view.
 *
 * Called between turns, never during one — the running turn holds its own
 * references. The wire-visible record is updated too, because the orchestrator
 * compares `session.model` against the requested selection to decide whether a
 * change happened; leaving it stale would make it restart sessions this
 * adapter is built to keep.
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
