// zed-entry.mjs
//
// HAND-WRITTEN — this file is NOT touched by scripts/sync-upstream.mjs.
//
// This is the entry point Zed launches (over stdio) to get Origami language
// support. It is a thin composition layer over the vendored, editor-agnostic
// LSP logic in `vendor/` (which IS regenerated verbatim from the upstream VS
// Code extension by the sync script).
//
// Why this file exists instead of launching upstream's own
// `src/server/server.mjs` directly:
//
//   In the original VS Code extension, the *client* (`src/client/extension.mjs`)
//   separately registers a completion provider for Origami's builtin function
//   names, using VS Code's own `registerCompletionItemProvider` API. Zed
//   extensions cannot provide completions directly — all language features
//   must come from a single external language server (see
//   `language_server_command` in ../src/lib.rs) — so that client-side logic
//   is reproduced here and merged into the single `onCompletion` handler.
//
// Everything else (diagnostics, go-to-definition, path/local autocomplete,
// file-watching for folder completions) delegates straight to the vendored
// upstream modules, unmodified.

import { fileURLToPath } from "node:url";
import { TextDocument } from "vscode-languageserver-textdocument";

import { autoComplete, folderChanged } from "./vendor/server/autoComplete.mjs";
import definition from "./vendor/server/definition.mjs";
import * as diagnostics from "./vendor/server/diagnostics.mjs";
import { getPathAtOffset } from "./vendor/utilities.mjs";
import builtinCompletions from "./vendor/builtins.json" with { type: "json" };

// vscode-languageserver is a CommonJS module; destructure via default import.
import languageServerPackage from "vscode-languageserver";
const {
  DidChangeWatchedFilesNotification,
  DocumentDiagnosticReportKind,
  FileChangeType,
  ProposedFeatures,
  TextDocumentSyncKind,
  TextDocuments,
  createConnection,
} = languageServerPackage;

// createConnection() auto-detects its transport from argv (e.g. `--stdio`),
// which is how Zed's Command (see language_server_command in ../src/lib.rs)
// invokes this script.
const connection = createConnection(ProposedFeatures.all);

let workspaceFolderPaths = [];

const documents = new TextDocuments(TextDocument);

connection.onInitialize((params) => {
  const workspaceFolders = params.workspaceFolders ?? [];
  workspaceFolderPaths = workspaceFolders.map((folder) =>
    fileURLToPath(folder.uri)
  );

  return {
    capabilities: {
      completionProvider: {
        triggerCharacters: ["/"],
      },
      definitionProvider: true,
      diagnosticProvider: {
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
      textDocumentSync: TextDocumentSyncKind.Incremental,
      workspace: {
        didChangeWatchedFiles: {
          dynamicRegistration: false,
        },
      },
    },
  };
});

connection.languages.diagnostics.on(async (params) => {
  const document = documents.get(params.textDocument.uri);
  let result;
  if (document !== undefined) {
    result = {
      kind: DocumentDiagnosticReportKind.Full,
      items: diagnostics.validate(document),
    };
  } else {
    result = {
      kind: DocumentDiagnosticReportKind.Full,
      items: [],
    };
  }
  return result;
});

connection.onCompletion(async (params) => {
  const { textDocument, position } = params;
  const uri = textDocument.uri;
  const document = documents.get(uri);
  const compileResult = diagnostics.compileResults.get(uri);
  if (document === undefined || compileResult === undefined) {
    // Called before diagnostics; shouldn't happen.
    return [];
  }

  const pathCompletions = await autoComplete(
    document,
    position,
    workspaceFolderPaths,
    compileResult
  );

  // Reproduce upstream's client-side builtins completion provider: if we're
  // touching a path, don't also suggest builtins (matches upstream's
  // provideCompletionItems in src/client/extension.mjs).
  const text = document.getText();
  const offset = document.offsetAt(position);
  const targetPath = getPathAtOffset(text, offset, {
    expandRight: false,
    requireSlash: true,
  });

  return targetPath ? pathCompletions : [...pathCompletions, ...builtinCompletions];
});

connection.onDefinition((params) => {
  const { textDocument, position } = params;
  const uri = textDocument.uri;
  const document = documents.get(uri);
  const compileResult = diagnostics.compileResults.get(uri);
  if (document === undefined || compileResult === undefined) {
    return [];
  }
  return definition(document, position, workspaceFolderPaths, compileResult);
});

connection.onNotification(DidChangeWatchedFilesNotification.type, (params) => {
  for (const change of params.changes) {
    const { uri, type } = change;
    if (type === FileChangeType.Created || type === FileChangeType.Deleted) {
      folderChanged(uri);
    }
  }
});

documents.listen(connection);
connection.listen();
