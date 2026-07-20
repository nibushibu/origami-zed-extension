import { AnnotatedCode } from "@weborigami/language";

// Result of compiling an Origami file; null if not compiled yet
export type CompileResult = AnnotatedCode | Error | null;

/**
 * The Origami Position type definition here is more limited than the underlying
 * Peggy structure: Peggy adds an `offset` property, but we don't need that and
 * don't want to calculate it for nothing.
 */
export type OrigamiPosition = {
  line: number;
  column: number;
}
