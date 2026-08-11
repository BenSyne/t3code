// @effect-diagnostics nodeBuiltinImport:off
/**
 * The core tools against a real filesystem.
 *
 * The unit tests next to each tool cover its arithmetic. This one covers the
 * part that arithmetic cannot: that the tools actually read, write, find, and
 * run things, and that a path pointing outside the workspace is refused even
 * when the string looks innocent.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { coreTools } from "./core.ts";
import { buildToolkit, resolveTools, type AgentToolContext } from "./registry.ts";

/** A workspace with a little of everything the tools care about. */
const makeWorkspace = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3agent-tools-" });
  // The temp directory itself is often a symlink (`/var` → `/private/var` on
  // macOS), so the workspace root has to be the resolved path or every
  // containment check would fail against real paths.
  const workspaceRoot = yield* fileSystem.realPath(root);

  yield* fileSystem.makeDirectory(NodePath.join(workspaceRoot, "src"), { recursive: true });
  yield* fileSystem.writeFileString(
    NodePath.join(workspaceRoot, "src", "index.ts"),
    "export const answer = 42;\nexport const other = 1;\n",
  );
  yield* fileSystem.makeDirectory(NodePath.join(workspaceRoot, "node_modules", "dep"), {
    recursive: true,
  });
  yield* fileSystem.writeFileString(
    NodePath.join(workspaceRoot, "node_modules", "dep", "index.ts"),
    "export const answer = 99;\n",
  );

  const context = {
    workspaceRoot,
    fileSystem,
    spawner,
    // A client that fails loudly if touched: nothing in these tests fetches.
    httpClient: HttpClient.make(() => Effect.die(new Error("no HTTP in this suite"))),
    commandEnv: { PATH: process.env.PATH ?? "" },
    // These tests exercise the tools, not the gate; approval has its own suite.
    requestApproval: () => Effect.succeed({ _tag: "Allowed" as const }),
  } satisfies AgentToolContext;

  const resolved = yield* resolveTools([coreTools], context);
  const toolkit = yield* buildToolkit(resolved.tools);

  const call = (name: string, params: Record<string, unknown>) =>
    Effect.gen(function* () {
      const results = yield* Stream.runCollect(yield* toolkit.handle(name, params as never));
      return results.at(-1)?.result as Record<string, unknown> | undefined;
    });

  return { workspaceRoot, fileSystem, call };
});

const isFailure = (result: unknown): result is { _tag: "ToolFailure"; message: string } =>
  typeof result === "object" &&
  result !== null &&
  (result as { _tag?: string })._tag === "ToolFailure";

const expectFailure = (result: unknown): string => {
  if (!isFailure(result)) {
    throw new Error(`expected a tool failure, got ${JSON.stringify(result)}`);
  }
  return result.message;
};

describe("core tools", () => {
  it.effect("reads a file with line numbers", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("read", { filePath: "src/index.ts" });

      expect(result?.content).toBe("1\texport const answer = 42;\n2\texport const other = 1;");
      expect(result?.totalLines).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("writes a file and creates its parent directories", () =>
    Effect.gen(function* () {
      const { call, fileSystem, workspaceRoot } = yield* makeWorkspace;

      const result = yield* call("write", {
        filePath: "deep/nested/new.txt",
        content: "hello",
      });

      expect(result?.created).toBe(true);
      const written = yield* fileSystem.readFileString(
        NodePath.join(workspaceRoot, "deep", "nested", "new.txt"),
      );
      expect(written).toBe("hello");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("edits an existing file", () =>
    Effect.gen(function* () {
      const { call, fileSystem, workspaceRoot } = yield* makeWorkspace;

      const result = yield* call("edit", {
        filePath: "src/index.ts",
        oldString: "answer = 42",
        newString: "answer = 43",
      });

      expect(result?.replacements).toBe(1);
      const updated = yield* fileSystem.readFileString(
        NodePath.join(workspaceRoot, "src", "index.ts"),
      );
      expect(updated).toContain("answer = 43");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("globs project files and skips node_modules", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("glob", { pattern: "**/*.ts" });

      expect(result?.paths).toEqual(["src/index.ts"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("greps file contents and skips node_modules", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("grep", { pattern: "answer" });
      const matches = result?.matches as ReadonlyArray<Record<string, unknown>>;

      expect(matches).toHaveLength(1);
      expect(matches[0]).toMatchObject({ path: "src/index.ts", line: 1 });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a bad regular expression instead of throwing", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("grep", { pattern: "([unclosed" });

      expect(expectFailure(result)).toContain("Invalid pattern");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("runs a shell command in the workspace", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("bash", { command: "ls src" });

      expect(result?.exitCode).toBe(0);
      expect(result?.stdout).toContain("index.ts");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a failing command as a result, not a tool failure", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("bash", { command: "exit 3" });

      expect(result?.exitCode).toBe(3);
      expect(isFailure(result)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // `it.effect` runs on a TestClock, where the tool's own `Effect.sleep` would
  // never elapse. This one needs wall-clock time.
  it.live("stops a command that runs too long", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("bash", { command: "sleep 5", timeoutMs: 300 });

      expect(result?.timedOut).toBe(true);
      expect(result?.exitCode).toBe(124);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("containment", () => {
  it.effect("refuses a path that climbs out of the workspace", () =>
    Effect.gen(function* () {
      const { call } = yield* makeWorkspace;

      const result = yield* call("read", { filePath: "../../etc/passwd" });

      expect(expectFailure(result)).toContain("outside the workspace");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a symlink that points out of the workspace", () =>
    Effect.gen(function* () {
      const { call, workspaceRoot, fileSystem } = yield* makeWorkspace;

      // The string path is unimpeachable — every segment is inside the
      // workspace. Only resolving the link reveals where it goes, which is the
      // entire reason the check runs twice.
      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3agent-outside-" });
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "top secret"),
      );
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(workspaceRoot, "escape")));

      const result = yield* call("read", { filePath: "escape/secret.txt" });

      expect(expectFailure(result)).toContain("outside the workspace");
      expect(expectFailure(result)).not.toContain("top secret");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to write through a symlink that points out of the workspace", () =>
    Effect.gen(function* () {
      const { call, workspaceRoot, fileSystem } = yield* makeWorkspace;

      const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3agent-outside-" });
      yield* Effect.promise(() => NodeFSP.symlink(outside, NodePath.join(workspaceRoot, "escape")));

      const result = yield* call("write", {
        filePath: "escape/planted.txt",
        content: "should never land",
      });

      expect(expectFailure(result)).toContain("outside the workspace");
      const landed = yield* fileSystem.exists(NodePath.join(outside, "planted.txt"));
      expect(landed).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
