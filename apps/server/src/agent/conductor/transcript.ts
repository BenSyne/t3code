/**
 * A thread rendered as something another model can read.
 *
 * What the agent needs from someone else's thread is not the chat. It is:
 * what was asked, what was done, whether anything broke, and what the
 * conclusion was. Messages alone answer the first and last of those, which is
 * why reading a delegated thread used to come back looking fine while the work
 * inside it had failed — the failure was an activity, and activities were not
 * rendered at all.
 *
 * Pure, so the trimming rules are testable. They are the part with teeth: this
 * output lands in a context window that also has to hold the agent's own work,
 * and a thread that pasted a whole build log into it would end the turn.
 *
 * @module agent/conductor/transcript
 */
import type { PendingUserInput } from "./pendingRequests.ts";

/** Lines past this stop informing and start crowding the context. */
const MAX_ENTRIES = 60;
/** One pasted file should not become the whole of what the agent reads back. */
const MAX_TEXT_CHARS = 2_000;
/** Activity summaries are already one-liners; this only catches pathological ones. */
const MAX_SUMMARY_CHARS = 300;

export interface TranscriptMessage {
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

export interface TranscriptActivity {
  readonly tone: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface TranscriptInput {
  readonly title: string;
  readonly status: string;
  readonly messages: ReadonlyArray<TranscriptMessage>;
  readonly activities: ReadonlyArray<TranscriptActivity>;
  /**
   * Questions the thread is blocked on.
   *
   * Reported here rather than through a tool of its own, because this is
   * already where the agent looks to collect a result — and "it is waiting for
   * you" is the single most important thing a read can say. A blocked thread
   * looks exactly like a working one from the outside, so without this the
   * only available move is to poll something that will never change.
   */
  readonly pending?: ReadonlyArray<PendingUserInput> | undefined;
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`;

type Entry = { readonly createdAt: string; readonly line: string };

/**
 * Render the thread.
 *
 * Messages and activities are interleaved by time rather than listed in two
 * blocks, because "it said it was done" and "the build failed" only mean
 * something in the order they happened.
 *
 * The tail, not the head: a long thread's recent turns are what a reader needs,
 * and the earlier ones are reported as a count so a truncated view is never
 * mistaken for the whole thread. Errors are counted across the *whole* thread
 * for the same reason — a failure early in a long run would otherwise fall off
 * the top and read as a clean transcript.
 */
export function renderTranscript(input: TranscriptInput): string {
  const entries: Array<Entry> = [
    ...input.messages.map((message) => ({
      createdAt: message.createdAt,
      line: `${message.role === "user" ? "User" : "Agent"}: ${truncate(message.text, MAX_TEXT_CHARS)}`,
    })),
    ...input.activities.map((activity) => ({
      createdAt: activity.createdAt,
      // Tone is carried through only when it is a problem. Prefixing every
      // routine tool call with "[tool]" spends tokens restating the obvious.
      line:
        activity.tone === "error"
          ? `[failed] ${truncate(activity.summary, MAX_SUMMARY_CHARS)}`
          : `· ${truncate(activity.summary, MAX_SUMMARY_CHARS)}`,
    })),
  ];

  entries.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const recent = entries.slice(-MAX_ENTRIES);
  const omitted = entries.length - recent.length;
  const failures = input.activities.filter((activity) => activity.tone === "error").length;

  const header = [
    `Thread: ${input.title}`,
    `Status: ${input.status}`,
    ...(failures > 0 ? [`Errors recorded: ${failures}`] : []),
    ...(omitted > 0 ? [`(${omitted} earlier entries omitted)`] : []),
  ];

  const body =
    recent.length === 0
      ? ["Nothing has happened in this thread yet."]
      : recent.map((entry) => entry.line);

  return [...header, "", ...body, ...blockedSection(input.pending ?? [])].join("\n");
}

/**
 * The "it is waiting for you" block.
 *
 * Last rather than first, so it is the freshest thing in the reader's context,
 * and explicit about the answer shape because getting it wrong sends nonsense
 * to an agent that is stuck until someone sends something.
 */
function blockedSection(pending: ReadonlyArray<PendingUserInput>): ReadonlyArray<string> {
  if (pending.length === 0) {
    return [];
  }
  return [
    "",
    "This thread is blocked waiting for an answer. It will not continue until one is sent.",
    ...pending.flatMap((request) => [
      `  request ${request.requestId}:`,
      ...(request.questions.length === 0
        ? ["    (the question could not be read — tell the user rather than guessing)"]
        : request.questions.map(
            (question) =>
              `    ${question.id}: ${question.question}` +
              (question.options.length === 0
                ? " (free text)"
                : ` [${question.options.join(" | ")}]${question.multiSelect ? " (choose one or more)" : ""}`),
          )),
    ]),
  ];
}
