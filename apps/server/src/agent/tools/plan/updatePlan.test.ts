/**
 * The plan tool.
 *
 * The tool stores nothing, so what can go wrong is what it accepts and what
 * the timeline shows. A plan the timeline renders wrongly is worse than no
 * plan — the user trusts the checklist over the prose.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { describeToolCall } from "../../events/toolItemMapping.ts";
import { makeUpdatePlanTool, summarizePlan } from "./updatePlan.ts";

const handler = makeUpdatePlanTool().handler as unknown as (
  params: Record<string, unknown>,
  context: Record<string, unknown>,
) => Effect.Effect<{ readonly summary: string }, { readonly message: string }>;

const run = (params: Record<string, unknown>) => Effect.result(handler(params, {}));

describe("update_plan", () => {
  it.effect("answers with a one-line summary of where the work stands", () =>
    Effect.gen(function* () {
      const outcome = yield* run({
        plan: [
          { step: "Read the failing test", status: "completed" },
          { step: "Fix the off-by-one", status: "in_progress" },
          { step: "Run the suite", status: "pending" },
        ],
      });
      assert.strictEqual(outcome._tag, "Success");
      if (outcome._tag !== "Success") return;
      assert.strictEqual(outcome.success.summary, "1/3 done — in progress: Fix the off-by-one");
    }),
  );

  it.effect("rejects an empty plan", () =>
    Effect.gen(function* () {
      const outcome = yield* run({ plan: [] });
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );

  it.effect("names the accepted statuses when given one it does not know", () =>
    Effect.gen(function* () {
      const outcome = yield* run({ plan: [{ step: "Do it", status: "doing" }] });
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag !== "Failure") return;
      assert.include(outcome.failure.message, "pending");
      assert.include(outcome.failure.message, "in_progress");
      assert.include(outcome.failure.message, "completed");
    }),
  );

  it.effect("rejects a step with no words in it", () =>
    Effect.gen(function* () {
      const outcome = yield* run({ plan: [{ step: "   ", status: "pending" }] });
      assert.strictEqual(outcome._tag, "Failure");
    }),
  );
});

describe("summarizePlan", () => {
  it("counts without naming a current step when nothing is in progress", () => {
    assert.strictEqual(
      summarizePlan([
        { step: "One", status: "completed" },
        { step: "Two", status: "completed" },
      ]),
      "2/2 done",
    );
  });
});

describe("the plan in the timeline", () => {
  it("shows progress in the title and the steps in the detail", () => {
    const described = describeToolCall({
      toolName: "update_plan",
      params: {
        plan: [
          { step: "Read the code", status: "completed" },
          { step: "Write the fix", status: "in_progress" },
        ],
      },
    });
    assert.strictEqual(described.title, "Plan: 1/2 done — in progress: Write the fix");
    assert.strictEqual(described.detail, "✓ Read the code\n▸ Write the fix");
  });

  it("stays standing when the model sends a shape it should not", () => {
    // Presentation must not throw on garbage — the loop renders whatever the
    // model actually sent, valid or not.
    const described = describeToolCall({
      toolName: "update_plan",
      params: { plan: "not an array" },
    });
    assert.strictEqual(described.title, "Update the plan");
  });
});
