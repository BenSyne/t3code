/**
 * What a tool says when it cannot do the thing.
 *
 * @module agent/tools/failure
 */
import * as Schema from "effect/Schema";

export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

export const toolFailure = (message: string): ToolFailure => new ToolFailure({ message });

/** Describe a filesystem problem in terms the model can act on. */
export function describeFileSystemFailure(input: {
  readonly cause: unknown;
  readonly displayPath: string;
  readonly operation: string;
}): ToolFailure {
  const code = extractErrorCode(input.cause);
  switch (code) {
    case "ENOENT":
      return toolFailure(`No such file or directory: ${input.displayPath}`);
    case "EACCES":
    case "EPERM":
      return toolFailure(`Permission denied: ${input.displayPath}`);
    case "EISDIR":
      return toolFailure(`${input.displayPath} is a directory, not a file.`);
    case "ENOTDIR":
      return toolFailure(`${input.displayPath} is not a directory.`);
    case "EMFILE":
    case "ENFILE":
      return toolFailure("Too many open files. Try again.");
    default:
      return toolFailure(`Could not ${input.operation} ${input.displayPath}.`);
  }
}

function extractErrorCode(cause: unknown): string | null {
  // `PlatformError` wraps the original in `cause`, so check both levels before
  // giving up and falling back to the generic message.
  for (const candidate of [cause, (cause as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === "object" && candidate !== null && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") {
        return code;
      }
    }
  }
  return null;
}
