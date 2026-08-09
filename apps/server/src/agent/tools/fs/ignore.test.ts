import { describe, expect, it } from "vite-plus/test";

import { isIgnoredPath, isIgnoredSegment } from "./ignore.ts";

describe("isIgnoredPath", () => {
  it("skips a dependency directory at any depth", () => {
    expect(isIgnoredPath("node_modules/react/index.js")).toBe(true);
    expect(isIgnoredPath("packages/ui/node_modules/react/index.js")).toBe(true);
  });

  it("skips build output and version control", () => {
    expect(isIgnoredPath("dist/bundle.js")).toBe(true);
    expect(isIgnoredPath(".git/config")).toBe(true);
    expect(isIgnoredPath("apps/web/.next/server/page.js")).toBe(true);
  });

  it("keeps project source", () => {
    expect(isIgnoredPath("src/index.ts")).toBe(false);
    expect(isIgnoredPath("apps/server/src/agent/tools/paths.ts")).toBe(false);
  });

  it("matches whole segments, not substrings", () => {
    // A file that merely mentions an ignored name is still project source.
    expect(isIgnoredPath("src/node_modules_shim.ts")).toBe(false);
    expect(isIgnoredPath("src/distribution/index.ts")).toBe(false);
    expect(isIgnoredPath("docs/building.md")).toBe(false);
  });
});

describe("isIgnoredSegment", () => {
  it("answers for one segment at a time, for a walker that prunes as it goes", () => {
    expect(isIgnoredSegment("node_modules")).toBe(true);
    expect(isIgnoredSegment("src")).toBe(false);
  });
});
