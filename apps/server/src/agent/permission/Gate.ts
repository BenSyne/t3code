/**
 * Waiting for a human to say yes.
 *
 * @module agent/permission/Gate
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export type ApprovalDecision = "approved" | "denied";

export interface PendingApproval {
  readonly requestId: string;
  readonly toolName: string;
  /** The command line or path the user is being asked about. */
  readonly target: string;
  readonly reason?: string | undefined;
}

export interface ApprovalGate {
  /** Park until the request is answered. Resolves to a decision, never fails. */
  readonly await: (request: PendingApproval) => Effect.Effect<ApprovalDecision>;
  /** Answer a pending request. */
  readonly resolve: (requestId: string, decision: ApprovalDecision) => Effect.Effect<boolean>;
  /** Everything still waiting, for a client that reconnects mid-turn. */
  readonly pending: Effect.Effect<ReadonlyArray<PendingApproval>>;
  /** Deny everything outstanding. */
  readonly rejectAll: Effect.Effect<void>;
}

export const makeApprovalGate = Effect.sync(() => {
  interface Entry {
    readonly request: PendingApproval;
    readonly deferred: Deferred.Deferred<ApprovalDecision>;
  }
  const waiting = new Map<string, Entry>();

  const awaitDecision = Effect.fnUntraced(function* (request: PendingApproval) {
    const deferred = yield* Deferred.make<ApprovalDecision>();
    waiting.set(request.requestId, { request, deferred });
    // Removed on the way out however this ends — answered, cascaded, or the
    // turn interrupted — so a closed session leaves nothing behind.
    return yield* Effect.ensuring(
      Deferred.await(deferred),
      Effect.sync(() => {
        waiting.delete(request.requestId);
      }),
    );
  });

  const resolve = (requestId: string, decision: ApprovalDecision) =>
    Effect.suspend(() => {
      const entry = waiting.get(requestId);
      if (entry === undefined) {
        return Effect.succeed(false);
      }
      waiting.delete(requestId);
      return Effect.as(Deferred.succeed(entry.deferred, decision), true);
    });

  const rejectAll = Effect.suspend(() => {
    const entries = Array.from(waiting.values());
    waiting.clear();
    return Effect.forEach(entries, (entry) => Deferred.succeed(entry.deferred, "denied"), {
      discard: true,
    });
  });

  return {
    await: awaitDecision,
    resolve,
    pending: Effect.sync(() => Array.from(waiting.values(), (entry) => entry.request)),
    rejectAll,
  } satisfies ApprovalGate;
});
