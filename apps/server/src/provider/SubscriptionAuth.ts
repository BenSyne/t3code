import * as NodeUtil from "node:util";

import {
  ProviderSetupError,
  type ProviderAuthState,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderAuthController } from "./Services/ProviderAuthService.ts";

/** Return only the provider's public authorization URL and device code, never raw CLI output. */
export function parseSubscriptionAuthOutput(output: string, provider: "codex" | "claudeAgent") {
  const clean = NodeUtil.stripVTControlCharacters(output);
  const urls = Array.from(clean.matchAll(/(https:\/\/[^\s<>"']+)(?=\s)/g), (match) => match[1]!);
  const authorizationUrl = urls.find((raw) => {
    try {
      const url = new URL(raw);
      return provider === "codex"
        ? url.hostname === "auth.openai.com" && url.pathname === "/codex/device"
        : url.hostname === "claude.ai" && url.pathname === "/oauth/authorize";
    } catch {
      return false;
    }
  });
  const deviceCode =
    provider === "codex" ? clean.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] : undefined;
  return { authorizationUrl, deviceCode };
}

/** Owns a single CLI login process, scoped to one named subscription and one client. */
export const makeSubscriptionAuth = Effect.fn("makeSubscriptionAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: "codex" | "claudeAgent";
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly codexFileCredentials?: boolean;
  readonly onChanged: Effect.Effect<void>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const empty: ProviderAuthState = {
    instanceId: options.instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
  };
  const state = yield* SubscriptionRef.make(empty);
  let owner: string | undefined;
  let flow:
    | { id: string; fiber: Fiber.Fiber<void>; process?: ChildProcessSpawner.ChildProcessHandle }
    | undefined;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const checkOwner = (sessionId: string, flowId: string) =>
    owner === sessionId && flow?.id === flowId
      ? Effect.void
      : Effect.fail(failure("auth", "This sign-in belongs to another client or has expired."));
  const command = Effect.fn("SubscriptionAuth.command")(function* (logout: boolean) {
    const args =
      options.provider === "codex"
        ? [
            ...(options.codexFileCredentials ? ["-c", 'cli_auth_credentials_store="file"'] : []),
            ...(logout ? ["logout"] : ["login", "--device-auth"]),
          ]
        : ["auth", logout ? "logout" : "login", ...(logout ? [] : ["--claudeai"])];
    const resolved = yield* resolveSpawnCommand(options.binaryPath, args, {
      env: options.environment,
      extendEnv: true,
    });
    return yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: { ...options.environment, NO_COLOR: "1" },
        extendEnv: true,
        shell: resolved.shell,
        forceKillAfter: "5 seconds",
      }),
    );
  });
  const controller: ProviderAuthController = {
    start: (sessionId, stopSessions = Effect.void) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (flow)
            return yield* Effect.fail(
              failure("start", "Sign-in is already in progress. Complete or cancel it first."),
            );
          yield* stopSessions;
          const id = yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(() => failure("start", "Could not start a secure sign-in flow.")),
          );
          owner = sessionId;
          const expiresAt = DateTime.formatIso(
            DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 600_000),
          );
          yield* SubscriptionRef.set(state, {
            ...empty,
            flowId: id,
            phase: "starting",
            expiresAt,
            message: "Starting subscription sign-in…",
          });
          const admitted = yield* Deferred.make<void>();
          const run = Deferred.await(admitted).pipe(
            Effect.andThen(
              Effect.scoped(
                Effect.gen(function* () {
                  const child = yield* command(false);
                  if (flow?.id === id) flow.process = child;
                  let output = "";
                  const read = Stream.merge(child.stdout, child.stderr).pipe(
                    Stream.decodeText(),
                    Stream.runForEach((chunk) => {
                      output = (output + chunk).slice(-16_384);
                      const parsed = parseSubscriptionAuthOutput(output, options.provider);
                      if (!parsed.authorizationUrl) return Effect.void;
                      return SubscriptionRef.update(state, (previous) => ({
                        ...previous,
                        phase: "waiting" as const,
                        authorizationUrl: parsed.authorizationUrl!,
                        message: parsed.deviceCode
                          ? `Enter code ${parsed.deviceCode} on the sign-in page.`
                          : "Sign in with your subscription. If the browser returns a code, paste it below.",
                      }));
                    }),
                  );
                  const [, code] = yield* Effect.all([read, child.exitCode], {
                    concurrency: "unbounded",
                  });
                  if (code !== 0)
                    return yield* Effect.fail(
                      failure("start", "The provider could not complete sign-in. Try again."),
                    );
                  yield* SubscriptionRef.update(state, (previous) => ({
                    ...previous,
                    phase: "verifying" as const,
                    authorizationUrl: null,
                    message: "Refreshing account and models…",
                  }));
                  yield* options.onChanged;
                  if (flow?.id === id) flow = undefined;
                  yield* SubscriptionRef.set(state, {
                    ...empty,
                    phase: "succeeded",
                    message: "Subscription connected.",
                  });
                }),
              ),
            ),
            Effect.timeout("10 minutes"),
            Effect.catch(() =>
              SubscriptionRef.set(state, {
                ...empty,
                phase: "failed",
                message: "Sign-in did not complete. Check that the CLI is installed and try again.",
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                if (flow?.id === id) flow = undefined;
              }),
            ),
          );
          const fiber = yield* Effect.forkIn(run, scope);
          flow = { id, fiber };
          yield* Deferred.succeed(admitted, undefined);
          return yield* SubscriptionRef.get(state);
        }),
      ),
    complete: (sessionId, input) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* checkOwner(sessionId, input.flowId);
          if (options.provider !== "claudeAgent" || !flow?.process) {
            return yield* Effect.fail(
              failure("complete", "Complete sign-in on the provider's page."),
            );
          }
          // OAuth codes may include '#state'. Reject control characters before
          // writing the single response expected by the owned login process.
          if (!/^[A-Za-z0-9_#\-./=+]{1,4096}$/.test(input.callbackUrl)) {
            return yield* Effect.fail(
              failure("complete", "Paste the authorization code supplied by Claude."),
            );
          }
          yield* Stream.encodeText(Stream.make(`${input.callbackUrl}\n`)).pipe(
            Stream.run(flow.process.stdin),
            Effect.mapError(() =>
              failure("complete", "Could not send the code. Start sign-in again."),
            ),
          );
          return yield* SubscriptionRef.get(state);
        }),
      ),
    cancel: (sessionId, flowId) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* checkOwner(sessionId, flowId);
          if (flow) yield* Fiber.interrupt(flow.fiber);
          yield* SubscriptionRef.set(state, {
            ...empty,
            phase: "cancelled",
            message: "Sign-in cancelled.",
          });
          return yield* SubscriptionRef.get(state);
        }),
      ),
    logout: (stopSessions) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (flow)
            return yield* Effect.fail(failure("logout", "Cancel the active sign-in first."));
          yield* stopSessions;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const child = yield* command(true);
              const [, code] = yield* Effect.all(
                [Stream.merge(child.stdout, child.stderr).pipe(Stream.runDrain), child.exitCode],
                { concurrency: "unbounded" },
              );
              if (code !== 0)
                return yield* Effect.fail(failure("logout", "The provider could not sign out."));
            }),
          ).pipe(
            Effect.timeout("30 seconds"),
            Effect.mapError(() => failure("logout", "Could not sign out. Try again.")),
          );
          yield* options.onChanged;
          yield* SubscriptionRef.set(state, empty);
          return empty;
        }),
      ),
    subscribe: (sessionId) =>
      SubscriptionRef.changes(state).pipe(
        Stream.map((snapshot) =>
          owner !== undefined && owner !== sessionId && snapshot.flowId !== null
            ? {
                ...snapshot,
                flowId: null,
                authorizationUrl: null,
                message: "Sign-in is in progress in another client.",
              }
            : snapshot,
        ),
      ),
  };
  return controller;
});
