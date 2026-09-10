import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";

import {
  claudeSignedOutMessage,
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
  materializeClaudeSessionHome,
  resolveClaudeSessionLayout,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(
          `claude:sessions:${resolved}`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:sessions:${path.join(resolved, ".claude")}`,
        );
      }),
    );
  });
  it.effect(
    "shares native transcripts without linking credentials and refuses existing history",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          const shared = path.join(root, "main");
          const privateHome = path.join(root, "backup");
          const config = { homePath: privateHome, sessionHomePath: shared };
          yield* materializeClaudeSessionHome(config);
          yield* fs.writeFileString(
            path.join(shared, "projects", "conversation.jsonl"),
            "saved context",
          );
          yield* fs.writeFileString(
            path.join(privateHome, ".credentials.json"),
            "private backup login",
          );
          expect(
            yield* fs.readFileString(path.join(privateHome, "projects", "conversation.jsonl")),
          ).toBe("saved context");
          expect(yield* fs.exists(path.join(shared, ".credentials.json"))).toBe(false);
          expect(yield* makeClaudeContinuationGroupKey(config)).toBe(
            yield* makeClaudeContinuationGroupKey({ homePath: shared }),
          );
          yield* materializeClaudeSessionHome(config);
          expect(yield* fs.readFileString(path.join(privateHome, ".credentials.json"))).toBe(
            "private backup login",
          );
          expect(
            yield* resolveClaudeSessionLayout({ homePath: "" }, { CLAUDE_CONFIG_DIR: shared }),
          ).toEqual({ accountPath: shared, sharedPath: shared });
          const occupied = path.join(root, "occupied");
          yield* fs.makeDirectory(path.join(occupied, "projects"), { recursive: true });
          expect(
            yield* materializeClaudeSessionHome({
              homePath: occupied,
              sessionHomePath: shared,
            }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "ClaudeSessionStorageError" });
          expect(yield* fs.exists(path.join(occupied, "projects"))).toBe(true);
        }),
      ),
  );
});
