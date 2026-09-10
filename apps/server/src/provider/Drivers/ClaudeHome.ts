import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  return path.resolve(homePath.length > 0 ? expandHomePath(homePath) : NodeOS.homedir());
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  if (homePath.length === 0) return resolvedBaseEnv;
  const resolvedHomePath = yield* resolveClaudeHomePath(config);
  return {
    ...resolvedBaseEnv,
    // Isolate this instance's config via CLAUDE_CONFIG_DIR rather than HOME.
    // Overriding HOME also relocates the macOS login keychain lookup
    // ($HOME/Library/Keychains), so the spawned CLI can't find its stored
    // OAuth credentials and reports "Not logged in". CLAUDE_CONFIG_DIR points
    // Claude Code at its config dir directly while leaving HOME (and the
    // keychain) intact.
    CLAUDE_CONFIG_DIR: resolvedHomePath,
  };
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "sessionHomePath">>,
    baseEnv?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const layout = yield* resolveClaudeSessionLayout(config, baseEnv);
    return `claude:sessions:${layout.sharedPath}`;
  },
);

const SHARED_SESSION_DIRECTORIES = ["projects", "file-history", "plans"] as const;

export const resolveClaudeSessionLayout = Effect.fn("resolveClaudeSessionLayout")(function* (
  config: Pick<ClaudeSettings, "homePath"> & Partial<Pick<ClaudeSettings, "sessionHomePath">>,
  baseEnv?: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const configuredHome = config.homePath.trim() || (baseEnv ?? process.env).CLAUDE_CONFIG_DIR;
  const accountPath = path.resolve(
    configuredHome ? expandHomePath(configuredHome) : path.join(NodeOS.homedir(), ".claude"),
  );
  const sharedPath = config.sessionHomePath?.trim()
    ? path.resolve(expandHomePath(config.sessionHomePath))
    : accountPath;
  return { accountPath, sharedPath };
});

export class ClaudeSessionStorageError extends Schema.TaggedError<ClaudeSessionStorageError>()(
  "ClaudeSessionStorageError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/** Only conversation data is shared. Existing independent history is never replaced. */
export const materializeClaudeSessionHome = Effect.fn("materializeClaudeSessionHome")(function* (
  config: Pick<ClaudeSettings, "homePath" | "sessionHomePath">,
  baseEnv?: NodeJS.ProcessEnv,
) {
  const { accountPath, sharedPath } = yield* resolveClaudeSessionLayout(config, baseEnv);
  if (accountPath === sharedPath) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(accountPath, { recursive: true });
  for (const directory of SHARED_SESSION_DIRECTORIES) {
    const target = path.join(sharedPath, directory);
    const link = path.join(accountPath, directory);
    yield* fs.makeDirectory(target, { recursive: true });
    const linkedTarget = yield* fs
      .readLink(link)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (linkedTarget !== undefined) {
      if (path.resolve(accountPath, linkedTarget) === target) continue;
      return yield* new ClaudeSessionStorageError({
        detail: `The conversation directory '${link}' already points elsewhere. Use a fresh account directory.`,
      });
    }
    if (yield* fs.exists(link)) {
      return yield* new ClaudeSessionStorageError({
        detail: `The conversation directory '${link}' already exists. Use a fresh account directory to keep its history intact.`,
      });
    }
    yield* fs.symlink(target, link);
  }
});

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "homePath">,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config);
    return `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/**
 * Describe the spawned CLI's environment separately from the login command so
 * paths remain literal on every shell, including relative inherited values.
 */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
