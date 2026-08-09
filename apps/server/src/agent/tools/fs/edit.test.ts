import { describe, expect, it } from "vite-plus/test";

import { applyEdit } from "./edit.ts";

const edit = (input: {
  content: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}) => applyEdit({ ...input, replaceAll: input.replaceAll ?? false });

describe("applyEdit", () => {
  it("replaces a unique occurrence", () => {
    const result = edit({ content: "a b c", oldString: "b", newString: "B" });
    expect(result).toEqual({ _tag: "Edited", content: "a B c", replacements: 1 });
  });

  it("refuses an ambiguous match and says how many there were", () => {
    const result = edit({ content: "x x x", oldString: "x", newString: "y" });
    expect(result).toEqual({ _tag: "Ambiguous", occurrences: 3 });
  });

  it("replaces every occurrence when asked", () => {
    const result = edit({ content: "x x x", oldString: "x", newString: "y", replaceAll: true });
    expect(result).toEqual({ _tag: "Edited", content: "y y y", replacements: 3 });
  });

  it("reports a missing string rather than doing nothing quietly", () => {
    expect(edit({ content: "abc", oldString: "zzz", newString: "y" })).toEqual({
      _tag: "NotFound",
    });
  });

  it("treats an identical replacement as a no-op worth reporting", () => {
    expect(edit({ content: "abc", oldString: "b", newString: "b" })).toEqual({ _tag: "Unchanged" });
  });

  it("is whitespace-exact", () => {
    expect(edit({ content: "  indented", oldString: "indented", newString: "x" })).toEqual({
      _tag: "Edited",
      content: "  x",
      replacements: 1,
    });
    expect(edit({ content: "  indented", oldString: "\tindented", newString: "x" })).toEqual({
      _tag: "NotFound",
    });
  });

  it("does not interpret $ patterns in the replacement", () => {
    // `String.replace` would turn `$&` into the matched text. Source code
    // containing `$&` or `$1` must survive an edit unchanged.
    const result = edit({ content: "cost = OLD", oldString: "OLD", newString: "$& $1 $$" });
    expect(result).toEqual({ _tag: "Edited", content: "cost = $& $1 $$", replacements: 1 });
  });

  it("counts overlapping candidates without double-counting", () => {
    // "aa" appears twice in "aaaa" when scanning non-overlapping, which is what
    // a replacement actually does.
    expect(edit({ content: "aaaa", oldString: "aa", newString: "b" })).toEqual({
      _tag: "Ambiguous",
      occurrences: 2,
    });
  });

  it("refuses an empty oldString instead of matching everywhere", () => {
    expect(edit({ content: "abc", oldString: "", newString: "x" })).toEqual({ _tag: "NotFound" });
  });

  it("replaces a multi-line block", () => {
    const result = edit({
      content: "function f() {\n  return 1;\n}\n",
      oldString: "  return 1;",
      newString: "  return 2;",
    });
    expect(result).toEqual({
      _tag: "Edited",
      content: "function f() {\n  return 2;\n}\n",
      replacements: 1,
    });
  });
});
