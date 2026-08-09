/**
 * Run a shell command in the project.
 *
 * The most powerful tool and the most dangerous one, so the shape of it matters
 * more than the code: it always runs in the workspace directory, it always has
 * a timeout, and its output is always bounded. What it is *allowed* to run is
 * not decided here — that belongs to the approval gate, which can see the whole
 * command and the user's rules. This file's job is to run one command well and
 * report honestly what happened.
 *
 * @module agent/tools/shell/bash
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tool from "effect/unstable/ai/Tool";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

import { toolFailure, ToolFailure } from "../failure.ts";
import { defineTool, type AgentTool, type AgentToolContext } from "../registry.ts";

/** What a shell reports for a command killed by `timeout(1)`. Familiar to models. */
const TIMEOUT_EXIT_CODE = 124;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Per stream. A build that prints a megabyte should not become a megabyte of context. */
const MAX_OUTPUT_BYTES = 60_000;

const BashTool = Tool.make("bash", {
  description:
    "Run a shell command in the project directory. Use for builds, tests, git, and anything the file tools cannot do. " +
    "Prefer the glob and grep tools over `find` and `grep` — they are faster and skip build output.",
  parameters: Schema.Struct({
    command: Schema.String.annotate({ description: "The shell command to run." }),
    description: Schema.optional(
      Schema.String.annotate({
        description: "Short description of what this command does, shown to the user.",
      }),
    ),
    timeoutMs: Schema.optional(
      Schema.Number.annotate({
        description: `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}, maximum ${MAX_TIMEOUT_MS}.`,
      }),
    ),
  }),
  success: Schema.Struct({
    stdout: Schema.String,
    stderr: Schema.String,
    exitCode: Schema.Number,
    /** True when the command was killed for running too long. */
    timedOut: Schema.Boolean,
    /** True when either stream was cut short. */
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
});

export function makeBashTool(context: AgentToolContext): AgentTool {
  return defineTool(
    BashTool,
    Effect.fnUntraced(function* (params) {
      const timeout = clampTimeout(params.timeoutMs);

      const run = Effect.gen(function* () {
        const child = yield* context.spawner.spawn(
          ChildProcess.make("/bin/sh", ["-c", params.command], {
            cwd: context.workspaceRoot,
            env: context.commandEnv,
          }),
        );

        // Signalling the process ourselves rather than wrapping the wait in
        // `Effect.timeout`: interrupting the fiber would discard the output
        // collected so far, and a command that hangs *after* printing the error
        // explaining why is exactly when the model needs to see what it said.
        const deadline = { passed: false };
        const killer = yield* Effect.forkScoped(
          Effect.sleep(Duration.millis(timeout)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                deadline.passed = true;
              }),
            ),
            Effect.andThen(child.kill({ forceKillAfter: Duration.seconds(5) })),
            Effect.ignore,
          ),
        );

        // A process killed by a signal has no exit code to report, so waiting
        // for one fails. That is an outcome, not an error — treat it as an
        // absent code so the output we did collect still comes back.
        const [stdout, stderr, exit] = yield* Effect.all(
          [collect(child.stdout), collect(child.stderr), Effect.option(child.exitCode)],
          { concurrency: "unbounded" },
        );
        yield* Fiber.interrupt(killer);

        return {
          stdout: stdout.text,
          stderr: deadline.passed
            ? appendNotice(stderr.text, `Command timed out after ${timeout} ms and was stopped.`)
            : stderr.text,
          exitCode: resolveExitCode(exit, deadline.passed),
          timedOut: deadline.passed,
          truncated: stdout.truncated || stderr.truncated,
        };
      });

      return yield* Effect.scoped(run).pipe(
        Effect.mapError(() => toolFailure(`Could not run: ${params.command}`)),
      );
    }),
  );
}

/**
 * `128 + SIGTERM`, the conventional shell code for "killed by a signal". Used
 * when the process died without reporting a code and we did not kill it, so the
 * model can tell that apart from a clean non-zero exit.
 */
const SIGNALLED_EXIT_CODE = 143;

function resolveExitCode(exit: Option.Option<number>, timedOut: boolean): number {
  if (timedOut) {
    return TIMEOUT_EXIT_CODE;
  }
  return exit._tag === "Some" ? Number(exit.value) : SIGNALLED_EXIT_CODE;
}

const appendNotice = (text: string, notice: string): string =>
  text === "" ? notice : `${text}\n${notice}`;

/** Out-of-range values clamp rather than fail: the model meant "a long time". */
function clampTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(requested), MAX_TIMEOUT_MS);
}

/**
 * Read a stream, stopping at the byte cap.
 *
 * Keeps the head rather than the tail. A failing command's first error is
 * usually the real one, and the thousand that follow are consequences.
 */
const collect = Effect.fnUntraced(function* <E>(stream: Stream.Stream<Uint8Array, E>) {
  const chunks: Array<string> = [];
  let bytes = 0;
  let truncated = false;

  yield* Stream.runForEach(Stream.decodeText(stream), (piece: string) => {
    if (truncated) {
      return Effect.void;
    }
    const size = Buffer.byteLength(piece, "utf8");
    if (bytes + size > MAX_OUTPUT_BYTES) {
      chunks.push(piece.slice(0, Math.max(0, MAX_OUTPUT_BYTES - bytes)));
      chunks.push("\n… output truncated …");
      truncated = true;
      return Effect.void;
    }
    bytes += size;
    chunks.push(piece);
    return Effect.void;
  }).pipe(Effect.orElseSucceed(() => undefined));

  return { text: chunks.join(""), truncated };
});
