import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_STEP_LIMITS,
  EMPTY_TALLY,
  decideNextStep,
  describeStop,
  recordStep,
  type StepLimits,
} from "./stepPolicy.ts";

const limits: StepLimits = { maxSteps: 3, maxToolCalls: 5 };

const decide = (input: {
  steps: number;
  toolCalls: number;
  requestedTools: boolean;
  interrupted?: boolean;
}) =>
  decideNextStep({
    tally: { steps: input.steps, toolCalls: input.toolCalls },
    limits,
    requestedTools: input.requestedTools,
    interrupted: input.interrupted ?? false,
  });

describe("recordStep", () => {
  it("counts a step and its tool calls", () => {
    expect(recordStep(EMPTY_TALLY, 2)).toEqual({ steps: 1, toolCalls: 2 });
  });

  it("counts a step that used no tools", () => {
    expect(recordStep({ steps: 4, toolCalls: 9 }, 0)).toEqual({ steps: 5, toolCalls: 9 });
  });

  it("never lets a negative count reduce the tally", () => {
    expect(recordStep({ steps: 1, toolCalls: 3 }, -5)).toEqual({ steps: 2, toolCalls: 3 });
  });
});

describe("decideNextStep", () => {
  it("continues while the model keeps asking for tools", () => {
    expect(decide({ steps: 1, toolCalls: 1, requestedTools: true })).toEqual({ _tag: "Continue" });
  });

  it("stops as completed when the model answers without tools", () => {
    expect(decide({ steps: 1, toolCalls: 0, requestedTools: false })).toEqual({
      _tag: "Stop",
      reason: "completed",
    });
  });

  it("stops at the step limit", () => {
    expect(decide({ steps: 3, toolCalls: 1, requestedTools: true })).toEqual({
      _tag: "Stop",
      reason: "step_limit",
    });
  });

  it("stops at the tool-call limit before the step limit is reached", () => {
    expect(decide({ steps: 1, toolCalls: 5, requestedTools: true })).toEqual({
      _tag: "Stop",
      reason: "tool_call_limit",
    });
  });

  it("treats the final step as completed even when it exhausts the step budget", () => {
    // The turn used its whole budget and still produced an answer. That is a
    // success; reporting `step_limit` here would tell the user their result was
    // truncated when it was not.
    expect(decide({ steps: 3, toolCalls: 5, requestedTools: false })).toEqual({
      _tag: "Stop",
      reason: "completed",
    });
  });

  it("reports interruption ahead of any limit", () => {
    expect(decide({ steps: 3, toolCalls: 5, requestedTools: true, interrupted: true })).toEqual({
      _tag: "Stop",
      reason: "interrupted",
    });
  });

  it("reports interruption even on a step that would have completed", () => {
    expect(decide({ steps: 1, toolCalls: 0, requestedTools: false, interrupted: true })).toEqual({
      _tag: "Stop",
      reason: "interrupted",
    });
  });
});

describe("describeStop", () => {
  it("says nothing about a normal ending", () => {
    expect(describeStop("completed", limits)).toBeNull();
  });

  it("names the limit that was hit", () => {
    expect(describeStop("step_limit", limits)).toContain("3 steps");
    expect(describeStop("tool_call_limit", limits)).toContain("5 tool calls");
  });

  it("attributes an interruption to the user", () => {
    expect(describeStop("interrupted", limits)).toBe("Stopped at your request.");
  });
});

describe("a loop driven by the policy", () => {
  it("terminates on the default limits even when the model never stops asking", () => {
    let tally = EMPTY_TALLY;
    let decision = decideNextStep({
      tally,
      limits: DEFAULT_STEP_LIMITS,
      requestedTools: true,
      interrupted: false,
    });
    let iterations = 0;

    while (decision._tag === "Continue") {
      iterations += 1;
      // Guard the guard: if the policy ever failed to terminate, this test
      // should fail rather than hang the suite.
      expect(iterations).toBeLessThan(1000);
      tally = recordStep(tally, 1);
      decision = decideNextStep({
        tally,
        limits: DEFAULT_STEP_LIMITS,
        requestedTools: true,
        interrupted: false,
      });
    }

    expect(decision).toEqual({ _tag: "Stop", reason: "step_limit" });
    expect(tally.steps).toBe(DEFAULT_STEP_LIMITS.maxSteps);
  });
});
