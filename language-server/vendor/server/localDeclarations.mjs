import { ops } from "@weborigami/language";

/**
 * Given a position in source code, yield the set of local object or lambda
 * declarations that surround that position, working up toward the root of the
 * code.
 *
 * @typedef {import("./types.js").OrigamiPosition} OrigamiPosition
 * @typedef {import("@weborigami/language").AnnotatedCode} AnnotatedCode
 *
 * @param {AnnotatedCode} code
 * @param {OrigamiPosition} origamiPosition
 */
export default function* localDeclarations(code, origamiPosition) {
  if (!Array.isArray(code) || code.location === undefined) {
    return;
  }

  const { location } = code;
  if (
    origamiPosition.line < location.start.line ||
    origamiPosition.line > location.end.line ||
    (origamiPosition.line === location.start.line &&
      origamiPosition.column < location.start.column) ||
    (origamiPosition.line === location.end.line &&
      origamiPosition.column > location.end.column)
  ) {
    // Position is outside of this code
    return;
  }

  // Which argument does the position fall within?
  for (const arg of code) {
    if (Array.isArray(arg)) {
      // If position is outside argument this will return immediately
      // @ts-ignore arg must be AnnotatedCode
      yield* localDeclarations(arg, origamiPosition);
    }
  }

  // Only yield object and lambda declarations
  const fn = code[0];
  if (fn === ops.object || fn === ops.lambda) {
    yield code;
  }
}
