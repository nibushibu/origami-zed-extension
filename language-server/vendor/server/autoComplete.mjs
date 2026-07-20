import { FileMap, trailingSlash } from "@weborigami/async-tree";
import { ops } from "@weborigami/language";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as utilities from "../utilities.mjs";
import findInProjectScope from "./findInProjectScope.mjs";
import localDeclarations from "./localDeclarations.mjs";

import languageServerPackage from "vscode-languageserver";
const { CompletionItemKind } = languageServerPackage;

/**
 * @typedef {import("./types.js").OrigamiPosition} OrigamiPosition
 * @typedef {import("@weborigami/language").AnnotatedCode} AnnotatedCode
 * @typedef {import("vscode-languageserver").CompletionItemKind} CompletionItemKind
 * @typedef {import("vscode-languageserver").CompletionItem} CompletionItem
 * @typedef {import("vscode-languageserver").Position} LSPPosition
 * @typedef {import("vscode-languageserver").TextDocument} TextDocument
 */

// Maps a folder URI to a set of completions for that folder's files
// @ts-ignore - not sure why TS complains about this line
const cachedFolderCompletions = new Map();

/**
 * Return completion items applicable to the given document
 *
 * @param {TextDocument} document
 * @param {LSPPosition} lspPosition
 * @param {string[]} workspaceFolderPaths
 * @param {import("./types.js").CompileResult} compileResult
 * @returns {Promise<CompletionItem[]>}
 */
export async function autoComplete(
  document,
  lspPosition,
  workspaceFolderPaths,
  compileResult,
) {
  const uri = new URL(document.uri);
  if (uri.protocol !== "file:") {
    return [];
  }
  const documentPath = fileURLToPath(uri);
  const folderPath = path.dirname(documentPath);

  // Are we touching a path?
  const text = document.getText();
  const offset = document.offsetAt(lspPosition);
  const targetPath = utilities.getPathAtOffset(text, offset, {
    expandRight: false,
    requireSlash: true,
  });
  if (targetPath) {
    // Yes, we're touching a path
    const pathCompletions = await getPathCompletions(
      targetPath,
      folderPath,
      workspaceFolderPaths,
    );
    return pathCompletions;
  }

  let positionCompletions = [];
  if (utilities && compileResult && !(compileResult instanceof Error)) {
    positionCompletions = getPositionCompletions(compileResult, lspPosition);
  }

  // Get completions based on the scope available in the folder
  const scopeCompletions = await getFolderScopeCompletions(
    folderPath,
    workspaceFolderPaths,
  );

  return positionCompletions.concat(scopeCompletions);
}

/**
 * A file was created or deleted; forget the cached completions for that folder
 *
 * @param {string} uri
 */
export function folderChanged(uri) {
  const folderPath = path.dirname(fileURLToPath(new URL(uri)));
  cachedFolderCompletions.delete(folderPath);
}

/**
 * Return the completions for files (including subfolders) in the given folder
 *
 * @param {string} folderPath
 */
async function getFolderCompletions(folderPath) {
  if (cachedFolderCompletions.has(folderPath)) {
    return cachedFolderCompletions.get(folderPath);
  }

  const tree = new FileMap(folderPath);
  const keys = [...tree.keys()];
  const completions = keys.map((key) => ({
    label: trailingSlash.remove(key),
    kind: trailingSlash.has(key)
      ? CompletionItemKind.Folder
      : CompletionItemKind.File,
  }));

  cachedFolderCompletions.set(folderPath, completions);
  return completions;
}

/**
 * Given a folder, return completions for the files in that folder and its
 * parent folders up to one of the workspace roots or the file system root.
 *
 * @param {string} folderPath
 * @param {string[]} workspaceFolderPaths
 */
async function getFolderScopeCompletions(folderPath, workspaceFolderPaths) {
  let parentCompletions;
  const isWorkspaceFolder = workspaceFolderPaths.some(
    (workspaceFolder) =>
      path.resolve(workspaceFolder) === path.resolve(folderPath),
  );
  if (!isWorkspaceFolder && folderPath !== "/") {
    // Get parent folder completions
    const parentFolder = path.dirname(folderPath);
    parentCompletions = await getFolderScopeCompletions(
      parentFolder,
      workspaceFolderPaths,
    );
  } else {
    parentCompletions = [];
  }

  const folderCompetions = await getFolderCompletions(folderPath);
  const completions = parentCompletions.concat(folderCompetions);
  return completions;
}

/**
 * Given a path, see if resolves to a folder. If so, return completions for the
 * files in that folder.
 *
 * @param {string} targetPath
 * @param {string} folderPath
 * @param {string[]} workspaceFolderPaths
 */
async function getPathCompletions(
  targetPath,
  folderPath,
  workspaceFolderPaths,
) {
  const keys = targetPath.split("/");
  // Completions are based on the path up to the last slash
  keys.pop();
  const rootKey = keys.shift();
  if (rootKey === undefined) {
    return null; // No key to complete on
  }

  // Find the root in the project scope
  const root = await findInProjectScope(
    rootKey,
    folderPath,
    workspaceFolderPaths,
  );

  // We're only interested if the root is a folder
  if (root === null || !(root.value instanceof FileMap)) {
    return null;
  }

  // If there are more keys, we need to find the next folder in the path
  let current = root.value;
  for (const key of keys) {
    const next = await current.get(key);
    if (next instanceof FileMap) {
      current = next;
    } else {
      return null; // The path doesn't resolve to a folder
    }
  }

  // Get the completions for the files in the folder
  const targetFolderPath = current.path;
  const completions = await getFolderCompletions(targetFolderPath);
  return completions;
}

/**
 * Return completions for the given position, returning null if the source
 * didn't compile, or if the start position doesn't fall within the source that
 * produced the compiled result
 *
 * @param {AnnotatedCode} code
 * @param {LSPPosition} lspPosition
 * @returns {CompletionItem[]}
 */
function getPositionCompletions(code, lspPosition) {
  const origamiPosition = utilities.lspPositionToOrigamiPosition(lspPosition);
  const completions = [];
  for (const declaration of localDeclarations(code, origamiPosition)) {
    const fn = declaration[0];
    switch (fn) {
      case ops.object:
        // Add each of the object keys
        const entries = declaration.slice(1);
        for (const entry of entries) {
          let key = entry[0];
          // Remove parentheses from non-enumerable keys
          if (key.startsWith("(") && key.endsWith(")")) {
            key = key.slice(1, -1);
          }
          completions.push({
            label: key,
            kind: CompletionItemKind.Property,
          });
        }
        break;

      case ops.lambda:
        // Add the lambda parameters
        const parameters = declaration[2];
        for (const parameter of parameters) {
          const label = parameter[0];
          completions.push({
            label,
            kind: CompletionItemKind.Variable,
          });
        }
        break;
    }
  }
  return completions;
}
