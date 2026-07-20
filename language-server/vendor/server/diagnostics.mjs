import { compile } from "@weborigami/language";
import languageServerPackage from "vscode-languageserver";
import { origamiPositionToLSPPosition } from "../utilities.mjs";
const { Diagnostic, DiagnosticSeverity } = languageServerPackage;

/**
 * Map document URIs for Origami files to the result of compiling the file
 *
 * @typedef {import("./types.js").CompileResult} CompileResult
 * @type {Map<string, CompileResult>}
 */
export const compileResults = new Map();

/**
 * Compile the document and return diagnostics
 *
 * @typedef {import("vscode-languageserver").Diagnostic} Diagnostic
 * @typedef {import("./types.js").OrigamiPosition} OrigamiPosition
 * @typedef {import("vscode-languageserver").DiagnosticSeverity} DiagnosticSeverity
 * @typedef {import("vscode-languageserver-textdocument").TextDocument} TextDocument
 *
 * @param {TextDocument} document
 * @returns {Diagnostic[]}
 */
export function validate(document) {
  const text = document.getText();
  const compilers = {
    origami: compile.expression,
    "origami-html": compile.templateDocument,
    "origami-markdown": compile.templateDocument,
  };
  const compiler = compilers[document.languageId];
  if (!compiler) {
    throw new Error(`Unknown language ID: ${document.languageId}`);
  }

  let result;
  try {
    result = text.trim().length > 0 ? compiler(text).code : null;
  } catch (error) {
    result = /** @type {Error} */ (error);
  }
  compileResults.set(document.uri, result);

  return result instanceof Error ? errorDiagnostic(result) : [];
}

// Convert an Error to a diagnostic
function errorDiagnostic(error) {
  const { location, message } = error;
  const range = {
    start: origamiPositionToLSPPosition(location.start),
    end: origamiPositionToLSPPosition(location.end),
  };
  const diagnostic = {
    severity: DiagnosticSeverity.Error,
    range,
    message,
  };

  return [diagnostic];
}
