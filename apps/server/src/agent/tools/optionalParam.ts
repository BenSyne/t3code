/**
 * An optional tool parameter that also tolerates the `null` models send.
 *
 * `Schema.optional(Schema.String)` accepts `string | undefined` and nothing
 * else. Models routinely fill in every key of a parameter object instead of
 * leaving the unwanted ones out, so `{"pattern": "src/**\/*.ts", "path": null}`
 * is an ordinary thing to receive — and it does not decode.
 *
 * The cost of that is out of all proportion to the mistake. Tool calls are
 * decoded as one union over every tool in the toolkit, so a single `null`
 * fails the whole response, and the turn dies with a wall of
 * `Expected "read" at [2]["name"]` listing every tool that also did not match.
 * Everything the agent had already done in that turn goes with it.
 *
 * So: accept `null` on the wire and hand the tool body `undefined`, which is
 * what "the caller did not supply this" already means everywhere else. Wrong
 * types are still rejected — this widens the schema by exactly one value, not
 * into `unknown`.
 *
 * @module agent/tools/optionalParam
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Declare an optional parameter that reads `null` as absent.
 *
 * Prefer this over `Schema.optional` for every tool *parameter*. Success and
 * failure schemas do not need it: we produce those values, and we do not send
 * `null` for an absent one.
 */
export const optionalParam = <S extends Schema.Top>(schema: S) =>
  Schema.optional(
    Schema.NullOr(schema).pipe(
      Schema.decodeTo(
        Schema.UndefinedOr(schema),
        SchemaTransformation.transform<S["Type"] | undefined, S["Type"] | null>({
          decode: (value) => (value === null ? undefined : value),
          encode: (value) => (value === undefined ? null : value),
        }),
      ),
    ),
  );
