// @effect-diagnostics nodeBuiltinImport:off
/**
 * Write a whole file.
 *
 * @module agent/tools/fs/write
 */
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";

import { describeFileSystemFailure, ToolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";
import { resolveForWrite } from "../safePath.ts";

const WriteTool = Tool.make("write", {
  description:
    "Write text to a file, creating it and any missing parent directories. " +
    "Replaces the whole file — use `edit` to change part of an existing one.",
  parameters: Schema.Struct({
    filePath: Schema.String.annotate({
      description: "Path to the file, absolute or relative to the project root.",
    }),
    content: Schema.String.annotate({ description: "The complete new contents of the file." }),
  }),
  success: Schema.Struct({
    path: Schema.String,
    /** False when an existing file was replaced. */
    created: Schema.Boolean,
    bytesWritten: Schema.Number,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeWriteTool(context: AgentToolContext): AgentTool {
  return defineTool(
    WriteTool,
    Effect.fnUntraced(function* (params) {
      const target = yield* resolveForWrite({
        fileSystem: context.fileSystem,
        workspaceRoot: context.workspaceRoot,
        candidate: params.filePath,
      });

      const existed = yield* Effect.orElseSucceed(
        context.fileSystem.exists(target.absolutePath),
        () => false,
      );

      yield* Effect.mapError(
        context.fileSystem.makeDirectory(NodePath.dirname(target.absolutePath), {
          recursive: true,
        }),
        (cause) =>
          describeFileSystemFailure({
            cause,
            displayPath: target.relativePath,
            operation: "create the directory for",
          }),
      );

      yield* Effect.mapError(
        context.fileSystem.writeFileString(target.absolutePath, params.content),
        (cause) =>
          describeFileSystemFailure({
            cause,
            displayPath: target.relativePath,
            operation: "write",
          }),
      );

      return {
        path: target.relativePath,
        created: !existed,
        bytesWritten: Buffer.byteLength(params.content, "utf8"),
      };
    }),
  );
}
