# grammars/origami (placeholder)

This is a **placeholder** Tree-sitter grammar. It exists only to satisfy
Zed's requirement that every registered language have a `grammar` (see
`extension.toml`), so the language server (diagnostics, autocomplete,
go-to-definition — see `../../language-server/`) can work without waiting on
a full grammar.

It currently recognizes only:
- Line comments (`// ...`) and block comments (`/* ... */`)
- Strings (`"..."`, `'...'`, `` `...` ``)

Everything else is treated as an opaque token, so there is effectively no
syntax highlighting yet beyond comments/strings.

## Regenerating after editing `grammar.js`

```sh
npx tree-sitter-cli generate --output grammars/origami/src grammars/origami/grammar.js
```

This overwrites `src/grammar.json`, `src/node-types.json`, and `src/parser.c`.
Commit the regenerated `src/` output — Zed compiles this C source directly
and does not run `tree-sitter generate` itself.

## Follow-up work (tracked separately from the upstream sync process)

Unlike `language-server/vendor/`, nothing here can be mechanically derived
from the upstream VS Code extension: VS Code uses a TextMate grammar
(`upstream/syntaxes/*.tmLanguage.json`), and TextMate grammars cannot be
automatically converted to Tree-sitter grammars. `scripts/sync-upstream.mjs`
will print a warning whenever upstream's TextMate grammar changes, as a
signal to revisit this grammar and the corresponding `languages/*/*.scm`
query files by hand.

A real grammar should cover Origami's actual expression syntax: object
literals, formulas/lambdas, spreads, paths, and template documents with
`${...}` interpolation (see `upstream/ReadMe.md` and
https://weborigami.org/language/ for the language reference).
