import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { resolveCredential } from "./credentials.ts";

const VAR = "ANTHROPIC_API_KEY";

describe("resolveCredential", () => {
  it("prefers the instance environment over the process environment", () => {
    const result = resolveCredential({
      variableName: VAR,
      instanceEnv: { [VAR]: "instance-key" },
      processEnv: { [VAR]: "process-key" },
    });

    expect(result._tag).toBe("Resolved");
    if (result._tag !== "Resolved") return;
    expect(Redacted.value(result.key)).toBe("instance-key");
    expect(result.source).toBe("instance-environment");
  });

  it("falls back to the process environment", () => {
    const result = resolveCredential({
      variableName: VAR,
      instanceEnv: {},
      processEnv: { [VAR]: "process-key" },
    });

    expect(result._tag).toBe("Resolved");
    if (result._tag !== "Resolved") return;
    expect(Redacted.value(result.key)).toBe("process-key");
    expect(result.source).toBe("process-environment");
  });

  it("reports the variable name when nothing is set, so the UI can name it", () => {
    const result = resolveCredential({ variableName: VAR, instanceEnv: {}, processEnv: {} });

    expect(result).toEqual({ _tag: "Missing", variableName: VAR });
  });

  it("treats a blank value as absent", () => {
    // A cleared settings field and a never-set one must behave identically.
    for (const blank of ["", "   ", "\n"]) {
      const result = resolveCredential({
        variableName: VAR,
        instanceEnv: { [VAR]: blank },
        processEnv: {},
      });
      expect(result._tag).toBe("Missing");
    }
  });

  it("trims surrounding whitespace off a pasted key", () => {
    const result = resolveCredential({
      variableName: VAR,
      instanceEnv: { [VAR]: "  sk-ant-pasted  " },
      processEnv: {},
    });

    expect(result._tag).toBe("Resolved");
    if (result._tag !== "Resolved") return;
    expect(Redacted.value(result.key)).toBe("sk-ant-pasted");
  });

  it("treats a blank variable name as missing rather than reading the whole env", () => {
    const result = resolveCredential({
      variableName: "   ",
      instanceEnv: { "": "oops" },
      processEnv: {},
    });

    expect(result._tag).toBe("Missing");
  });

  it("keeps the key out of stringified output", () => {
    // Redacted is the reason a key cannot reach a log line by accident.
    const result = resolveCredential({
      variableName: VAR,
      instanceEnv: { [VAR]: "sk-ant-secret" },
      processEnv: {},
    });
    if (result._tag !== "Resolved") throw new Error("expected Resolved");

    expect(String(result.key)).not.toContain("sk-ant-secret");
    expect(JSON.stringify(result)).not.toContain("sk-ant-secret");
  });
});
