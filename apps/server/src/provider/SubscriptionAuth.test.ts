import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeSubscriptionAuth, parseSubscriptionAuthOutput } from "./SubscriptionAuth.ts";

describe("subscription sign-in", () => {
  it("extracts only complete official sign-in links and the device code", () => {
    expect(
      parseSubscriptionAuthOutput(
        "secret=do-not-display\nhttps://auth.openai.com/codex/device\nABCD-EFGH\n",
        "codex",
      ),
    ).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-EFGH",
    });
    expect(
      parseSubscriptionAuthOutput("https://auth.openai.com.evil.test/codex/device\n", "codex")
        .authorizationUrl,
    ).toBeUndefined();
    expect(
      parseSubscriptionAuthOutput("https://claude.ai/oauth/authorize?partial", "claudeAgent")
        .authorizationUrl,
    ).toBeUndefined();
    expect(
      parseSubscriptionAuthOutput("https://claude.ai/oauth/authorize?code=true\n", "claudeAgent")
        .authorizationUrl,
    ).toContain("claude.ai");
  });

  it.effect("limits sign-in to the owning client and stops only its owned process on cancel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<Uint8Array>();
        const processClosed = yield* Deferred.make<void>();
        const launched = yield* Deferred.make<void>();
        const spawner = ChildProcessSpawner.make(() =>
          Effect.acquireRelease(
            Deferred.succeed(launched, undefined).pipe(
              Effect.as(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(123),
                  exitCode: Effect.never,
                  isRunning: Effect.succeed(true),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: Stream.fromQueue(output),
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              ),
            ),
            () => Deferred.succeed(processClosed, undefined).pipe(Effect.asVoid),
          ),
        );
        const auth = yield* makeSubscriptionAuth({
          instanceId: ProviderInstanceId.make("codex_backup"),
          provider: "codex",
          binaryPath: process.execPath,
          environment: {},
          codexFileCredentials: true,
          onChanged: Effect.void,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const started = yield* auth.start("owner");
        yield* Deferred.await(launched);
        const waiting = yield* auth.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "waiting"),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Queue.offer(
          output,
          new TextEncoder().encode(
            "private=secret\nhttps://auth.openai.com/codex/device\nABCD-EFGH\n",
          ),
        );
        const visible = yield* Fiber.join(waiting);
        expect(Option.getOrThrow(visible).message).not.toContain("private=secret");
        const other = yield* auth.subscribe("another-client").pipe(Stream.runHead);
        expect(Option.getOrThrow(other).message).not.toContain("ABCD-EFGH");
        expect(Option.getOrThrow(other).authorizationUrl).toBeNull();
        expect(
          (yield* auth.cancel("another-client", started.flowId!).pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* auth.cancel("owner", started.flowId!);
        yield* Deferred.await(processClosed);
        expect((yield* auth.subscribe("owner").pipe(Stream.runHead))._tag).toBe("Some");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "accepts Claude's code, refreshes the account, and signs out after stopping sessions",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          let spawnCount = 0;
          let refreshes = 0;
          let stopped = false;
          let receivedCode = "";
          const spawner = ChildProcessSpawner.make(() => {
            const isLogin = spawnCount++ === 0;
            if (!isLogin) expect(stopped).toBe(true);
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(124),
                exitCode: isLogin
                  ? Deferred.await(exited)
                  : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                isRunning: Effect.succeed(isLogin),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.forEach((bytes: Uint8Array) => {
                  receivedCode += new TextDecoder().decode(bytes);
                  return Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0));
                }),
                stdout: isLogin
                  ? Stream.encodeText(Stream.make("https://claude.ai/oauth/authorize?code=true\n"))
                  : Stream.empty,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          });
          const auth = yield* makeSubscriptionAuth({
            instanceId: ProviderInstanceId.make("claude_backup"),
            provider: "claudeAgent",
            binaryPath: process.execPath,
            environment: {},
            onChanged: Effect.sync(() => {
              refreshes++;
            }),
          }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          const started = yield* auth.start("owner");
          yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "waiting"),
            Stream.runHead,
          );
          const invalid = yield* auth
            .complete("owner", { flowId: started.flowId!, callbackUrl: "code\nsecond-line" })
            .pipe(Effect.result);
          expect(invalid._tag).toBe("Failure");
          yield* auth.complete("owner", {
            flowId: started.flowId!,
            callbackUrl: "auth-code#state",
          });
          yield* auth.subscribe("owner").pipe(
            Stream.filter((state) => state.phase === "succeeded"),
            Stream.runHead,
          );
          expect(receivedCode).toBe("auth-code#state\n");
          expect(refreshes).toBe(1);
          yield* auth.logout(
            Effect.sync(() => {
              stopped = true;
            }),
          );
          expect(refreshes).toBe(2);
          expect(spawnCount).toBe(2);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});
