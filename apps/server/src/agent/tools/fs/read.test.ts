import { describe, expect, it } from "vite-plus/test";

import { formatSlice } from "./read.ts";

const FILE = "alpha\nbravo\ncharlie\ndelta\n";

describe("formatSlice", () => {
  it("numbers every line from 1", () => {
    const result = formatSlice(FILE, undefined, undefined);
    expect(result.content).toBe("1\talpha\n2\tbravo\n3\tcharlie\n4\tdelta");
    expect(result.totalLines).toBe(4);
    expect(result.truncated).toBe(false);
  });

  it("does not count the empty string after a trailing newline as a line", () => {
    expect(formatSlice("one\n", undefined, undefined).totalLines).toBe(1);
    expect(formatSlice("one", undefined, undefined).totalLines).toBe(1);
  });

  it("treats offset as 1-based", () => {
    const result = formatSlice(FILE, 2, 2);
    expect(result.content).toBe("2\tbravo\n3\tcharlie");
  });

  it("reports truncation when the window stops short of the end", () => {
    expect(formatSlice(FILE, 1, 2).truncated).toBe(true);
    expect(formatSlice(FILE, 3, 2).truncated).toBe(false);
  });

  it("returns nothing when the offset is past the end", () => {
    const result = formatSlice(FILE, 99, 10);
    expect(result.content).toBe("");
    expect(result.truncated).toBe(false);
  });

  it("tolerates a zero or negative offset by starting at the first line", () => {
    expect(formatSlice(FILE, 0, 1).content).toBe("1\talpha");
    expect(formatSlice(FILE, -5, 1).content).toBe("1\talpha");
  });

  it("returns nothing for a zero limit", () => {
    expect(formatSlice(FILE, 1, 0).content).toBe("");
  });

  it("handles an empty file", () => {
    const result = formatSlice("", undefined, undefined);
    expect(result.content).toBe("");
    expect(result.totalLines).toBe(0);
  });

  it("clips a single enormous line instead of returning all of it", () => {
    const result = formatSlice("x".repeat(5000), undefined, undefined);
    expect(result.content).toContain("[line truncated]");
    expect(result.content.length).toBeLessThan(3000);
  });
});
