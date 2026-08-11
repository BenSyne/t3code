/**
 * An optional tool parameter that also tolerates the `null` models send.
 *
 * @module agent/tools/optionalParam
 */
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/** Declare an optional parameter that reads `null` as absent. */
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
