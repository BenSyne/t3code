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

  if (recent.length === 0) {
    return [...header, "", "Nothing has happened in this thread yet."].join("\n");
  }

  return [...header, "", ...recent.map((entry) => entry.line)].join("\n");
}
