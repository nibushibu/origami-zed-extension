#!/usr/bin/env node
/**
 * sync-upstream.mjs
 *
 * Regenerates every "upstream-derived" (generated) file in this Zed
 * extension from the `upstream` git submodule, which tracks the original
 * VS Code extension:
 *
 *   https://github.com/WebOrigami/origami-vscode-extension
 *
 * This script NEVER touches hand-written Zed-specific files (Rust code,
 * tree-sitter grammar/queries, extension.toml, language-server/zed-entry.mjs).
 * See SYNC.md for the full generated/hand-written boundary.
 *
 * Usage:
 *   git submodule update --remote upstream   # move upstream to latest commit
 *   node scripts/sync-upstream.mjs           # regenerate derived files
 *   git diff                                 # review what changed before committing
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamDir = path.join(root, "upstream");
const vendorDir = path.join(root, "language-server", "vendor");
const languagesDir = path.join(root, "languages");
const lockFilePath = path.join(root, "scripts", "upstream-lock.json");

function readText(p) {
  return readFileSync(p, "utf8");
}

/** Minimal comment-stripper for the JSONC files VS Code uses (language-configuration.json). */
function parseJsonc(text) {
  let out = "";
  let inString = false;
  let stringChar = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === stringChar) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      stringChar = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip trailing '/'
      continue;
    }
    out += c;
  }
  return JSON.parse(out);
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function upstreamCommit() {
  return execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

function readLock() {
  if (!existsSync(lockFilePath)) return null;
  return JSON.parse(readText(lockFilePath));
}

// --- 1. Vendor the editor-agnostic LSP server code, verbatim -------------

const VENDOR_FILES = [
  ["src/server/autoComplete.mjs", "server/autoComplete.mjs"],
  ["src/server/definition.mjs", "server/definition.mjs"],
  ["src/server/diagnostics.mjs", "server/diagnostics.mjs"],
  ["src/server/findInProjectScope.mjs", "server/findInProjectScope.mjs"],
  ["src/server/localDeclarations.mjs", "server/localDeclarations.mjs"],
  ["src/server/types.ts", "server/types.ts"],
  ["src/utilities.mjs", "utilities.mjs"],
  ["src/client/builtins.json", "builtins.json"],
];

function syncVendorFiles() {
  const changed = [];
  const missing = [];
  for (const [from, to] of VENDOR_FILES) {
    const src = path.join(upstreamDir, from);
    const dest = path.join(vendorDir, to);
    if (!existsSync(src)) {
      missing.push(from);
      continue;
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    const content = readText(src);
    const before = existsSync(dest) ? readText(dest) : null;
    if (before !== content) {
      writeFileSync(dest, content);
      changed.push(to);
    }
  }
  return { changed, missing };
}

// --- 2. Generate languages/*/config.toml from upstream metadata ----------

// Zed language directory -> [upstream language id, tree-sitter grammar name]
const LANGUAGE_MAP = {
  origami: { upstreamId: "origami", grammar: "origami", name: null },
  "origami-html": {
    upstreamId: "origami-html",
    // TODO(step 4): ideally this should be its own grammar (HTML + Origami
    // expression injections) rather than reusing the plain "origami" grammar.
    grammar: "origami",
    name: null,
  },
  "origami-markdown": {
    upstreamId: "origami-markdown",
    // TODO(step 4): same as above, but for Markdown + Origami injections.
    grammar: "origami",
    name: null,
  },
};

function tomlString(value) {
  // JSON string escaping is compatible with TOML basic-string escaping for
  // the characters we care about here (\n, \t, \", \\).
  return JSON.stringify(value);
}

function tomlArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

function bracketEntry({ start, end, close, newline, notIn }) {
  const fields = [
    `start = ${tomlString(start)}`,
    `end = ${tomlString(end)}`,
    `close = ${close}`,
    `newline = ${newline}`,
  ];
  if (notIn && notIn.length > 0) {
    fields.push(`not_in = ${tomlArray(notIn)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

function generateLanguageConfigs() {
  const pkg = JSON.parse(readText(path.join(upstreamDir, "package.json")));
  const langConfig = parseJsonc(
    readText(path.join(upstreamDir, "language-configuration.json"))
  );

  const byId = new Map(
    pkg.contributes.languages.map((entry) => [entry.id, entry])
  );

  const lineComment = langConfig.comments?.lineComment;
  const blockComment = langConfig.comments?.blockComment;
  const autoCloseBefore = langConfig.autoCloseBefore;

  // Derive Zed's `brackets` (autoclose behavior) from VS Code's
  // autoClosingPairs. Doc-comment opener ("/**") is handled separately via
  // `documentation_comment`.
  const brackets = [];
  let documentationComment = null;
  for (const pair of langConfig.autoClosingPairs ?? []) {
    const { open, close: closeChar, notIn } = pair;
    if (open === "/**") {
      documentationComment = {
        start: open,
        end: closeChar.trim(),
        prefix: "* ",
        tab_size: 1,
      };
      continue;
    }
    const newline = open === "{" || open === "[";
    brackets.push(
      bracketEntry({ start: open, end: closeChar, close: true, newline, notIn })
    );
  }
  // VS Code's plain `brackets` (matching-only, e.g. Origami's "${...}"
  // interpolation) that aren't already covered by autoClosingPairs above.
  const autoCloseOpens = new Set((langConfig.autoClosingPairs ?? []).map((p) => p.open));
  for (const [open, close] of langConfig.brackets ?? []) {
    if (autoCloseOpens.has(open)) continue;
    brackets.push(bracketEntry({ start: open, end: close, close: false, newline: false }));
  }

  const changedFiles = [];

  for (const [dir, { upstreamId, grammar }] of Object.entries(LANGUAGE_MAP)) {
    const entry = byId.get(upstreamId);
    if (!entry) {
      console.warn(`  ! upstream package.json no longer declares language "${upstreamId}"`);
      continue;
    }
    const name = entry.aliases?.[0] ?? upstreamId;
    const pathSuffixes = (entry.extensions ?? []).map((ext) => ext.replace(/^\./, ""));

    const lines = [
      "# GENERATED FILE - do not hand-edit.",
      "# Regenerate with: node scripts/sync-upstream.mjs",
      `# Derived from upstream package.json ("${upstreamId}") + language-configuration.json.`,
      "",
      `name = ${tomlString(name)}`,
      `grammar = ${tomlString(grammar)}`,
      `path_suffixes = ${tomlArray(pathSuffixes)}`,
    ];
    if (lineComment) {
      lines.push(`line_comments = ${tomlArray([lineComment + " "])}`);
    }
    if (autoCloseBefore) {
      lines.push(`autoclose_before = ${tomlString(autoCloseBefore)}`);
    }
    if (brackets.length > 0) {
      lines.push("brackets = [");
      for (const b of brackets) lines.push(`  ${b},`);
      lines.push("]");
    }
    if (blockComment) {
      lines.push(
        `block_comment = { start = ${tomlString(blockComment[0])}, end = ${tomlString(
          blockComment[1]
        )}, prefix = "", tab_size = 2 }`
      );
    }
    if (documentationComment) {
      lines.push(
        `documentation_comment = { start = ${tomlString(
          documentationComment.start
        )}, end = ${tomlString(documentationComment.end)}, prefix = ${tomlString(
          documentationComment.prefix
        )}, tab_size = ${documentationComment.tab_size} }`
      );
    }
    lines.push("");

    const dest = path.join(languagesDir, dir, "config.toml");
    const content = lines.join("\n");
    mkdirSync(path.dirname(dest), { recursive: true });
    const before = existsSync(dest) ? readText(dest) : null;
    if (before !== content) {
      writeFileSync(dest, content);
      changedFiles.push(`languages/${dir}/config.toml`);
    }
  }

  return changedFiles;
}

// --- 3. Generate language-server/package.json runtime dependencies ------

// Only the runtime packages actually imported by the vendored server code
// (see VENDOR_FILES above) need to be listed here. vscode-languageclient is
// intentionally excluded: it is the VS Code *client* library and has no
// role in a standalone LSP server process.
const SERVER_RUNTIME_DEPENDENCIES = [
  "@weborigami/async-tree",
  "@weborigami/language",
  "vscode-languageserver",
  "vscode-languageserver-textdocument",
];

function generateServerPackageJson() {
  const upstreamPkg = JSON.parse(readText(path.join(upstreamDir, "package.json")));
  const dependencies = {};
  for (const name of SERVER_RUNTIME_DEPENDENCIES) {
    const version = upstreamPkg.dependencies?.[name];
    if (!version) {
      console.warn(`  ! upstream package.json no longer depends on "${name}"`);
      continue;
    }
    dependencies[name] = version;
  }

  const pkg = {
    name: "origami-zed-language-server",
    private: true,
    type: "module",
    description:
      "GENERATED FILE - do not hand-edit. Regenerate with: node scripts/sync-upstream.mjs. Runtime dependencies mirror upstream's src/server dependencies.",
    main: "zed-entry.mjs",
    dependencies,
  };

  const dest = path.join(root, "language-server", "package.json");
  const content = JSON.stringify(pkg, null, 2) + "\n";
  const before = existsSync(dest) ? readText(dest) : null;
  if (before !== content) {
    writeFileSync(dest, content);
    return ["language-server/package.json"];
  }
  return [];
}

// --- 4. Detect grammar-relevant (TextMate) changes for manual follow-up --

function grammarSourceHash() {
  const syntaxesDir = path.join(upstreamDir, "syntaxes");
  if (!existsSync(syntaxesDir)) return null;
  const files = readdirSync(syntaxesDir).sort();
  const combined = files
    .map((f) => `${f}:${sha256(readText(path.join(syntaxesDir, f)))}`)
    .join("\n");
  return sha256(combined);
}

// --- main ------------------------------------------------------------------

function main() {
  console.log(`Syncing from upstream submodule (${upstreamDir})...`);
  const commit = upstreamCommit();
  const pkg = JSON.parse(readText(path.join(upstreamDir, "package.json")));
  const lock = readLock();

  const { changed: vendorChanged, missing: vendorMissing } = syncVendorFiles();
  const configsChanged = generateLanguageConfigs();
  const serverPackageChanged = generateServerPackageJson();
  const grammarHash = grammarSourceHash();

  console.log(`\nupstream commit: ${commit}`);
  console.log(`upstream package version: ${pkg.version}`);

  if (vendorChanged.length > 0) {
    console.log(`\nUpdated vendor files (language-server/vendor/):`);
    for (const f of vendorChanged) console.log(`  - ${f}`);
  } else {
    console.log(`\nVendor files: no changes.`);
  }

  if (vendorMissing.length > 0) {
    console.log(`\nWARNING: upstream no longer has these files (check for renames):`);
    for (const f of vendorMissing) console.log(`  - ${f}`);
  }

  if (configsChanged.length > 0) {
    console.log(`\nRegenerated language configs:`);
    for (const f of configsChanged) console.log(`  - ${f}`);
  } else {
    console.log(`\nLanguage configs: no changes.`);
  }

  if (serverPackageChanged.length > 0) {
    console.log(`\nRegenerated:`);
    for (const f of serverPackageChanged) console.log(`  - ${f}`);
  } else {
    console.log(`\nlanguage-server/package.json: no changes.`);
  }

  if (lock && lock.grammarSourceHash && lock.grammarSourceHash !== grammarHash) {
    console.log(
      `\nWARNING: upstream's TextMate grammar (syntaxes/*.tmLanguage.json) changed.\n` +
        `  Zed uses a hand-written Tree-sitter grammar (separate repo:\n` +
        `  nibushibu/tree-sitter-origami) and queries (languages/*/highlights.scm etc.),\n` +
        `  which are NOT auto-derived.\n` +
        `  Please review upstream's syntax changes and update the Tree-sitter grammar/queries by hand.`
    );
  }

  writeFileSync(
    lockFilePath,
    JSON.stringify(
      {
        upstreamCommit: commit,
        upstreamPackageVersion: pkg.version,
        grammarSourceHash: grammarHash,
        syncedAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  );

  console.log(`\nWrote ${path.relative(root, lockFilePath)}`);
  console.log(`Done. Review with "git diff", then commit.`);
}

main();
