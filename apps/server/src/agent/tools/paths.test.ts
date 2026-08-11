// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { describeRejection, isWithinRoot, resolveWithinRoot } from "./paths.ts";

const ROOT = NodePath.resolve("/workspace/project");

const resolve = (candidate: string) => resolveWithinRoot({ root: ROOT, candidate });

const allowed = (candidate: string) => {
  const result = resolve(candidate);
  if (result._tag !== "Allowed") {
    throw new Error(`expected "${candidate}" to be allowed, got ${result.reason}`);
  }
  return result;
};

const rejected = (candidate: string) => {
  const result = resolve(candidate);
  if (result._tag !== "Rejected") {
    throw new Error(`expected "${candidate}" to be rejected, got ${result.absolutePath}`);
  }
  return result;
};

describe("resolveWithinRoot", () => {
  it("resolves a relative path against the root", () => {
    const result = allowed("src/index.ts");
    expect(result.absolutePath).toBe(NodePath.join(ROOT, "src", "index.ts"));
    expect(result.relativePath).toBe("src/index.ts");
  });

  it("accepts the root itself", () => {
    expect(allowed(".").relativePath).toBe("");
  });

  it("accepts an absolute path inside the root", () => {
    expect(allowed(NodePath.join(ROOT, "a", "b.ts")).relativePath).toBe("a/b.ts");
  });

  it("normalises interior traversal that stays inside", () => {
    expect(allowed("src/../lib/x.ts").relativePath).toBe("lib/x.ts");
  });

  it("rejects traversal above the root", () => {
    expect(rejected("../secrets.txt").reason).toBe("outside_root");
  });

  it("rejects traversal that climbs out and back to a sibling", () => {
    expect(rejected("src/../../other-project/x.ts").reason).toBe("outside_root");
  });

  it("rejects an unrelated absolute path", () => {
    expect(rejected("/etc/passwd").reason).toBe("outside_root");
  });

  it("rejects a sibling directory sharing the root's name prefix", () => {
    // The bug a naive `startsWith` check would have: `/workspace/project-backup`
    // is not inside `/workspace/project`.
    expect(rejected(`${ROOT}-backup/x.ts`).reason).toBe("outside_root");
  });

  it("rejects an empty or whitespace path", () => {
    expect(rejected("").reason).toBe("empty");
    expect(rejected("   ").reason).toBe("empty");
  });

  it("rejects a NUL byte", () => {
    expect(rejected("src/index\0.ts").reason).toBe("nul_byte");
  });

  it("checks for a NUL byte before anything else", () => {
    // A NUL in an otherwise-escaping path should still be named as the NUL,
    // because that is the more specific fact about the input.
    expect(rejected("../x\0").reason).toBe("nul_byte");
  });
});

describe("isWithinRoot", () => {
  it("accepts the root and its descendants", () => {
    expect(isWithinRoot(ROOT, ROOT)).toBe(true);
    expect(isWithinRoot(ROOT, NodePath.join(ROOT, "deep", "nested", "file.ts"))).toBe(true);
  });

  it("rejects a parent, a sibling, and a name-prefix neighbour", () => {
    expect(isWithinRoot(ROOT, NodePath.dirname(ROOT))).toBe(false);
    expect(isWithinRoot(ROOT, "/workspace/other")).toBe(false);
    expect(isWithinRoot(ROOT, `${ROOT}-backup`)).toBe(false);
  });

  it("is what a caller re-runs against a realpath result", () => {
    // The symlink case this exists for: the string path is inside the root, the
    // resolved path is not, and only the second check catches it.
    const symlinkPath = NodePath.join(ROOT, "link", "passwd");
    expect(resolve(symlinkPath)._tag).toBe("Allowed");
    expect(isWithinRoot(ROOT, "/etc/passwd")).toBe(false);
  });
});

describe("describeRejection", () => {
  it("tells the model what to do instead", () => {
    expect(describeRejection({ reason: "outside_root", requested: "../x" })).toContain(
      "inside the project",
    );
    expect(describeRejection({ reason: "empty", requested: "" })).toContain("project root");
    expect(describeRejection({ reason: "nul_byte", requested: "a\0" })).toContain(
      "invalid character",
    );
  });
});
