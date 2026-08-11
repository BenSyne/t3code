/**
 * Which questions a thread is still waiting on an answer for.
 *
 * There is no pending-requests table to read. A request arrives as a
 * `user-input.requested` activity and is closed by a `user-input.resolved`
 * one carrying the same `requestId`, so "still pending" is a fold over the
 * activity log: latest state per request wins, and the ones whose latest state
 * is still `requested` are the open ones. The sidebar's own counter is derived
 * the same way.
 *
 * This matters more than it looks. A delegated agent that stops to ask a
 * question is indistinguishable, from the outside, from one that is working —
 * same status, same absence of new messages. Without this the Conductor polls
 * a thread that will never move again.
 *
 * @module agent/conductor/pendingRequests
 */

/** The activity fields this fold reads. Deliberately narrow. */
export interface RequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
}

export interface PendingQuestion {
  readonly id: string;
  readonly question: string;
  /** Option labels. An answer is one of these, verbatim. */
  readonly options: ReadonlyArray<string>;
  readonly multiSelect: boolean;
}

export interface PendingUserInput {
  readonly requestId: string;
  readonly questions: ReadonlyArray<PendingQuestion>;
}

const REQUESTED = "user-input.requested";
/**
 * States that close a request.
 *
 * A failed response counts as closed for the same reason the projection's own
 * counter treats it that way: the provider has moved on, and re-answering a
 * request it no longer knows about only produces a second failure.
 */
const RESOLVED = new Set(["user-input.resolved", "provider.user-input.respond.failed"]);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

const readQuestions = (payload: Record<string, unknown>): ReadonlyArray<PendingQuestion> => {
  const questions = payload["questions"];
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions.flatMap((entry): ReadonlyArray<PendingQuestion> => {
    const question = asRecord(entry);
    if (question === undefined) {
      return [];
    }
    const id = question["id"];
    const text = question["question"];
    if (typeof id !== "string" || typeof text !== "string") {
      return [];
    }
    const options = Array.isArray(question["options"]) ? question["options"] : [];
    return [
      {
        id,
        question: text,
        options: options.flatMap((option) => {
          const label = asRecord(option)?.["label"];
          return typeof label === "string" ? [label] : [];
        }),
        multiSelect: question["multiSelect"] === true,
      },
    ];
  });
};

/**
 * Fold the activity log into the open questions.
 *
 * Chronological, so a request answered and then re-asked under a new id is
 * handled by both entries standing on their own, and a resolve always follows
 * the request it closes. Activities carrying no `requestId` are not part of
 * this conversation and are skipped rather than treated as malformed.
 */
export function pendingUserInputOf(
  activities: ReadonlyArray<RequestActivity>,
): ReadonlyArray<PendingUserInput> {
  const open = new Map<string, PendingUserInput | null>();

  for (const activity of [...activities].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const payload = asRecord(activity.payload);
    if (payload === undefined) {
      continue;
    }
    const requestId = payload["requestId"];
    if (typeof requestId !== "string") {
      continue;
    }
    if (activity.kind === REQUESTED) {
      open.set(requestId, { requestId, questions: readQuestions(payload) });
    } else if (RESOLVED.has(activity.kind)) {
      // Kept as a tombstone rather than deleted: a later unrelated activity
      // must not be able to resurrect a request that was already answered.
      open.set(requestId, null);
    }
  }

  return [...open.values()].filter((entry): entry is PendingUserInput => entry !== null);
}
