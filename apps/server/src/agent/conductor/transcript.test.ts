import { describe, expect, it } from "vite-plus/test";

import { renderTranscript, type TranscriptInput } from "./transcript.ts";

const render = (parts: Partial<TranscriptInput>): string =>
  renderTranscript({
    title: "Fix the parser",
    status: "idle",
    messages: [],
    activities: [],
    ...parts,
  });

/** Nth moment of the thread, as a real timestamp — the renderer sorts on these. */
const at = (step: number): string => {
  const hour = String(Math.floor(step / 60)).padStart(2, "0");
  const minute = String(step % 60).padStart(2, "0");
  return `2026-08-09T${hour}:${minute}:00.000Z`;
};

describe("rendering a thread for another agent", () => {
  it("interleaves what was said with what was done, in the order it happened", () => {
    // Two separate blocks would lose the only thing that makes them mean
    // something together: whether the claim came before or after the failure.
    const output = render({
      messages: [
        { role: "user", text: "fix it", createdAt: at(0) },
        { role: "assistant", text: "done", createdAt: at(3) },
      ],
      activities: [{ tone: "tool", summary: "Edited parser.ts", createdAt: at(1) }],
    });
    const lines = output.split("\n");
    expect(lines.indexOf("User: fix it")).toBeLessThan(lines.indexOf("· Edited parser.ts"));
    expect(lines.indexOf("· Edited parser.ts")).toBeLessThan(lines.indexOf("Agent: done"));
  });

  it("marks failures so they cannot be read as ordinary steps", () => {
    const output = render({
      activities: [{ tone: "error", summary: "Build failed", createdAt: at(1) }],
    });
    expect(output).toContain("[failed] Build failed");
  });

  it("counts errors across the whole thread, not just the part it shows", () => {
    // The reason this exists: an early failure in a long run falls off the top
    // and the tail reads like a clean transcript.
    const activities = [
      { tone: "error", summary: "Build failed", createdAt: at(0) },
      ...Array.from({ length: 80 }, (_, index) => ({
        tone: "tool",
        summary: `Step ${index}`,
        createdAt: at(index + 1),
      })),
    ];
    const output = render({ activities });
    expect(output).toContain("Errors recorded: 1");
    expect(output).not.toContain("[failed]");
  });

  it("says how much it left out rather than looking complete", () => {
    const messages = Array.from({ length: 90 }, (_, index) => ({
      role: "assistant",
      text: `line ${index}`,
      createdAt: at(index),
    }));
    const output = render({ messages });
    expect(output).toContain("30 earlier entries omitted");
    expect(output).toContain("line 89");
    expect(output).not.toContain("line 0:");
  });

  it("truncates a pasted file instead of spending the context on it", () => {
    const output = render({
      messages: [{ role: "user", text: "x".repeat(5_000), createdAt: at(0) }],
    });
    expect(output).toContain("[truncated]");
    expect(output.length).toBeLessThan(3_000);
  });

  it("says plainly when a thread has produced nothing", () => {
    // An empty string here reads to the model as a tool that failed.
    expect(render({})).toContain("Nothing has happened in this thread yet.");
  });
});
