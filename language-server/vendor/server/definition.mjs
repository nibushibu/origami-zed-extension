import { FileMap, trailingSlash } from "@weborigami/async-tree";
import { ops } from "@weborigami/language";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as utilities from "../utilities.mjs";
import findInProjectScope from "./findInProjectScope.mjs";
import localDeclarations from "./localDeclarations.mjs";

/**
 * Compile the document and return diagnostics
 *
 * @typedef {import("@weborigami/language").AnnotatedCode} AnnotatedCode
 * @typedef {import("./types.js").OrigamiPosition} OrigamiPosition
 * @typedef {import("vscode-languageserver").Location} Location
 * @typedef {import("vscode-languageserver").Position} LSPPosition
 * @typedef {import("vscode-languageserver-textdocument").TextDocument} TextDocument
 *
 * @param {TextDocument} document
 * @param {LSPPosition} lspPosition
 * @param {string[]} workspaceFolderPaths
 * @param {import("./types.js").CompileResult} compileResult
 * @returns {Promise<Location | null>}
 */
export default async function definition(
  document,
  lspPosition,
  workspaceFolderPaths,
  compileResult,
) {
  // Get the path the cursor is inside of
  const text = document.getText();
  const offset = document.offsetAt(lspPosition);
  const targetPath = utilities.getPathAtOffset(text, offset);

  // If the position isn't inside a path, return null. Also return null if the
  // path includes a colon -- we don't handle protocols (or port numbers).
  if (targetPath === null || targetPath.includes(":")) {
    return null;
  }

  const uri = document.uri;

  // Find path root in project scope, might be a file or a folder
  const keys = targetPath.split("/");
  const rootKey = keys.shift();
  if (rootKey === undefined) {
    return null;
  }

  const didCompile = compileResult && !(compileResult instanceof Error);

  // If the key contains a period, try entire thing as a local
  if (didCompile) {
    const range = localDeclarationRange(compileResult, rootKey, lspPosition);
    if (range !== null) {
      return { uri, range };
    }

    // If the key contains a period, try just the head of the key as a local
    if (rootKey.includes(".")) {
      const keyHead = rootKey.split(".")[0];
      const range = localDeclarationRange(compileResult, keyHead, lspPosition);
      if (range !== null) {
        return { uri, range };
      }
    }
  }

  const location = await externalLocation(
    uri,
    rootKey,
    keys,
    workspaceFolderPaths,
  );
  return location;
}

async function externalLocation(uri, rootKey, keys, workspaceFolderPaths) {
  if (!uri.startsWith("file:")) {
    // Document may be unsaved or use some other schema, so we can't find any
    // external definitions.
    return null;
  }

  const documentPath = fileURLToPath(uri);
  const folderPath = path.dirname(documentPath);

  const root = await findInProjectScope(
    rootKey,
    folderPath,
    workspaceFolderPaths,
  );

  if (root === null) {
    return null;
  }

  // Follow as many keys as possible until we find a file
  let { path: filePath, value: current } = root;
  while (current instanceof FileMap && keys.length > 0) {
    /** @type {string} */
    // @ts-ignore always defined
    const key = keys.shift();
    const value = await current.get(key);
    if (value === undefined) {
      break;
    } else if (!(value instanceof FileMap)) {
      filePath = path.join(current.path, key);
    }
    current = value;
  }

  if (current instanceof FileMap) {
    // Path pointed to a folder, which we can't navigate to
    return null;
  }

  const resultHref = pathToFileURL(filePath).href;
  return {
    uri: resultHref,
    // Insertion point will be at the start of the file
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
}

/**
 * If the key corresponds to a local declaration in the code, return the range
 * of the declaration. Otherwise, return null.
 *
 * @param {AnnotatedCode} code
 * @param {string} key
 * @param {LSPPosition} lspPosition
 * @returns {import("vscode-languageserver").Range | null}
 */
function localDeclarationRange(code, key, lspPosition) {
  const origamiPosition = utilities.lspPositionToOrigamiPosition(lspPosition);
  // Walk up from the current position to visit all declarations in scope
  for (const declaration of localDeclarations(code, origamiPosition)) {
    const fn = declaration[0];
    let location;
    switch (fn) {
      case ops.object:
        const properties = declaration.slice(1);
        const normalizedKey = trailingSlash.remove(key);
        const entry = properties.find((property) =>
          matchProperty(normalizedKey, property),
        );
        location = entry?.location;
        break;

      case ops.lambda:
        const parameters = declaration[2];
        const parameter = parameters.find((arg) => arg[0] === key);
        if (parameter) {
          location = parameter.location;
        }
        break;
    }

    if (location) {
      const range = {
        start: utilities.origamiPositionToLSPPosition(location.start),
        end: utilities.origamiPositionToLSPPosition(location.end),
      };
      return range;
    }
  }

  return null;
}

// Return true if the key matches the given property
function matchProperty(key, property) {
  let name = property[0];
  // Ignore parentheses around the names of non-enumerable properties
  if (name.startsWith("(") && name.endsWith(")")) {
    name = name.slice(1, -1);
  }
  // Ignore trailing slashes in property names
  name = trailingSlash.remove(name);

  if (key !== name) {
    return false;
  }

  // Possible match

  // Are we looking at a shorthand property referencing an external file? We
  // can't tell this from the code, so we resort to looking at the source code
  // for the property. If the entire property is a name, it's a shorthand.
  const { location } = property;
  const source = location?.source.text.slice(
    location.start.offset,
    location.end.offset,
  );
  const isShorthand = source === name;
  return !isShorthand;
}
