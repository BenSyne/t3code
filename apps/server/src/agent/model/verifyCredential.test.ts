import * as Redacted from "effect/Redacted";
import { describe, expect, it } from "vite-plus/test";

import { countModels, outcomeForStatus, probeFor } from "./verifyCredential.ts";

const KEY = Redacted.make("sk-test-123");

describe("probeFor", () => {
  it("uses Anthropic's own header and required version", () => {
    // The one backend that does not take a bearer token. Getting this wrong
    // reads as a rejected key rather than a malformed request.
    const probe = probeFor({ backend: "anthropic", credential: KEY });
    expect(probe.url).toBe("https://api.anthropic.com/v1/models");
    expect(probe.headers["x-api-key"]).toBe("sk-test-123");
    expect(probe.headers["anthropic-version"]).toBe("2023-06-01");
    expect(probe.headers["Authorization"]).toBeUndefined();
  });

  it("sends a bearer token for the OpenAI-shaped backends", () => {
    for (const backend of ["openai", "openrouter", "cerebras"] as const) {
      const probe = probeFor({ backend, credential: KEY });
      expect(probe.headers["Authorization"]).toBe("Bearer sk-test-123");
    }
  });

  it("never probes OpenRouter's public catalogue", () => {
    // Found by connecting a junk key and watching it be accepted. OpenRouter
    // answers /models with 200 and no credential at all, so probing it verifies
    // nothing and stores whatever was typed. /key requires the credential.
    const probe = probeFor({ backend: "openrouter", credential: KEY });
    expect(probe.url).not.toContain("/models");
    expect(probe.url).toBe("https://openrouter.ai/api/v1/key");
  });

  it("defaults a local server to Ollama's address and sends no auth header", () => {
    // A local server authenticates nothing. An empty bearer would be worse than
    // no header at all — some servers reject it.
    const probe = probeFor({ backend: "openai-compat", credential: undefined });
    expect(probe.url).toBe("http://localhost:11434/v1/models");
    expect(probe.headers["Authorization"]).toBeUndefined();
  });

  it("does not double the slash when a base URL has a trailing one", () => {
    const probe = probeFor({
      backend: "openai-compat",
      credential: undefined,
      baseUrl: "http://127.0.0.1:1234/v1/",
    });
    expect(probe.url).toBe("http://127.0.0.1:1234/v1/models");
  });
});

describe("outcomeForStatus", () => {
  it("accepts any 2xx", () => {
    expect(outcomeForStatus(200, 13)).toEqual({ _tag: "Ok", modelCount: 13 });
  });

  it("treats 401 and 403 as a refused key, not a broken network", () => {
    for (const status of [401, 403]) {
      const outcome = outcomeForStatus(status, 0);
      expect(outcome._tag).toBe("Rejected");
      expect(outcome).toHaveProperty("detail", expect.stringContaining("refused"));
    }
  });

  it("treats 404 as an address problem, since that is what it means for a local server", () => {
    expect(outcomeForStatus(404, 0)._tag).toBe("Unreachable");
  });

  it("reports an unexpected status rather than guessing at it", () => {
    const outcome = outcomeForStatus(503, 0);
    expect(outcome._tag).toBe("Rejected");
    expect(outcome).toHaveProperty("detail", expect.stringContaining("503"));
  });
});

describe("countModels", () => {
  it("counts a data array", () => {
    expect(countModels({ data: [{ id: "a" }, { id: "b" }] })).toBe(2);
  });

  it("returns zero for a shape it does not recognise, rather than failing a good key", () => {
    expect(countModels({ models: [1, 2, 3] })).toBe(0);
    expect(countModels(null)).toBe(0);
    expect(countModels("nope")).toBe(0);
  });
});
