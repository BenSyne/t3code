/**
 * What the orchestrator knows about its fleet before the first word is typed.
 *
 * Without this the agent starts every session blind: the tools could answer
 * "which agents exist, what do they cost, what is stuck" — but only if the
 * model decides to spend steps asking. On a greeting turn it never does, so
 * the thing sold as an orchestrator opens the conversation knowing nothing
 * about the room. One snapshot at session start fixes the posture: the first
 * reply can already speak to what is configured, what is running, and what is
 * blocked waiting on a person.
 *
 * A snapshot, not a subscription — it is stale the moment a thread moves, and
 * says so, pointing at the listing tools for current state.
 *
 * Fail-soft by design: the snapshot is a nicety and session start is not
 * allowed to hang or die on a projection. Anything slow or broken returns
 * null and the session starts without it.
 *
 * @module agent/prompt/environmentSnapshot
 */
import * as Effect from "effect/Effect";

import type {
  OrchestrationClient,
  ProviderSummary,
  ThreadSummary,
} from "../conductor/OrchestrationClient.ts";

/** How long session start will wait on the projections before shrugging. */
const DEFAULT_TIMEOUT_MILLIS = 3_000;

/** Blocked threads named individually; past this they become a count. */
const MAX_NAMED_THREADS = 5;

export const buildEnvironmentSnapshot = (input: {
  readonly client: OrchestrationClient;
  /** Which entry in the provider list is the agent itself. */
  readonly selfDriverKind: string;
  readonly timeoutMillis?: number | undefined;
}): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const [providers, projects] = yield* Effect.all(
      [input.client.listProviders, input.client.listProjects],
      { concurrency: 2 },
    );

    const threads = (yield* Effect.forEach(
      projects,
      (project) => input.client.listThreads(project.id),
      { concurrency: 4 },
    ))
      .flat()
      // Settled, snoozed, and archived threads are tidied away; counting them
      // would bury the two numbers that matter — running and blocked.
      .filter((thread) => thread.lifecycle === "active" || thread.lifecycle === "pinned");

    const lines: Array<string> = [
      "The fleet, as of the start of this session (the listing tools give current state):",
    ];

    if (providers.length === 0) {
      lines.push("No agents are configured yet.");
    }
    for (const provider of providers) {
      lines.push(describeProvider(provider, input.selfDriverKind));
    }

    if (projects.length > 0) {
      lines.push(
        `Projects: ${projects.map((project) => JSON.stringify(project.title)).join(", ")}.`,
      );
      lines.push(describeThreads(threads));
    }

    return lines.join("\n");
  }).pipe(
    // A projection that is slow or broken must not take session start with it.
    Effect.timeoutOption(input.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS),
    Effect.map((option) => (option._tag === "Some" ? option.value : null)),
    Effect.catchDefect(() => Effect.succeed(null)),
  );

function describeProvider(provider: ProviderSummary, selfDriverKind: string): string {
  const notes: Array<string> = [];
  if (provider.billing === "subscription") {
    notes.push("subscription — capacity already paid for");
  } else if (provider.billing === "per-token") {
    notes.push("per-token — each delegation bills the user");
  }
  if (provider.defaultModel !== null) {
    notes.push(`default model ${provider.defaultModel}`);
  }
  if (!provider.available) {
    notes.push("currently unavailable");
  }
  if (provider.driverKind === selfDriverKind) {
    notes.push("this is you");
  }
  return `- ${provider.displayName}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

function describeThreads(threads: ReadonlyArray<ThreadSummary>): string {
  if (threads.length === 0) {
    return "Threads: none active.";
  }

  const running = threads.filter((thread) => thread.isRunning);
  const blocked = threads.filter(
    (thread) => !thread.isRunning && (thread.awaitingInput || thread.awaitingApproval),
  );

  const parts = [
    `Threads: ${threads.length} active — ${running.length} running, ${blocked.length} blocked waiting on a person.`,
  ];

  // The blocked ones are the actionable ones, so they get named. A running
  // thread needs nothing; a blocked thread is why the fleet is idle.
  for (const thread of blocked.slice(0, MAX_NAMED_THREADS)) {
    const reason = thread.awaitingInput ? "waiting for an answer" : "waiting on an approval";
    parts.push(`  - ${JSON.stringify(thread.title)} is ${reason}.`);
  }
  if (blocked.length > MAX_NAMED_THREADS) {
    parts.push(`  - …and ${blocked.length - MAX_NAMED_THREADS} more blocked threads.`);
  }

  return parts.join("\n");
}
