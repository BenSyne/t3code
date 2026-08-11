/**
 * A thread rendered as something another model can read.
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
  /** Questions the thread is blocked on. */
  readonly pending?: ReadonlyArray<PendingUserInput> | undefined;
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}… [truncated]`;

type Entry = { readonly createdAt: string; readonly line: string };

/** Render the thread. */
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

/** The "it is waiting for you" block. */
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
