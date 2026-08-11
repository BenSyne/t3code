import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { optionalParam } from "./optionalParam.ts";

const Params = Schema.Struct({
  pattern: Schema.String,
  path: optionalParam(Schema.String),
  limit: optionalParam(Schema.Number),
});

const decode = Schema.decodeUnknownSync(Params);

describe("optionalParam", () => {
  it("reads an explicit null as absent", () => {
    // The bug this exists for. A model filling in every key of the parameter
    // object rather than omitting the ones it does not want used to fail the
    // decode, and because tool calls decode as one union over the whole
    // toolkit, that killed the entire turn.
    expect(decode({ pattern: "src/**/*.ts", path: null })).toEqual({
      pattern: "src/**/*.ts",
      path: undefined,
      limit: undefined,
    });
  });

  it("treats omitted and undefined the same as null", () => {
    const omitted = decode({ pattern: "p" });
    const explicit = decode({ pattern: "p", path: undefined, limit: undefined });
    expect(omitted).toEqual(explicit);
    expect(omitted).toEqual({ pattern: "p", path: undefined, limit: undefined });
  });

  it("passes real values through untouched", () => {
    expect(decode({ pattern: "p", path: "src", limit: 20 })).toEqual({
      pattern: "p",
      path: "src",
      limit: 20,
    });
  });

  it("still rejects a wrong type", () => {
    // Widening by exactly one value. `null` is accepted because models send it
    // for "not supplied"; a number where a string belongs is a real mistake and
    // must not decode.
    expect(() => decode({ pattern: "p", path: 42 })).toThrow();
    expect(() => decode({ pattern: "p", limit: "twenty" })).toThrow();
  });

  it("still rejects a missing required parameter", () => {
    expect(() => decode({ path: "src" })).toThrow();
  });
});
