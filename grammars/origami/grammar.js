// PLACEHOLDER Tree-sitter grammar for the Origami expression language.
//
// This is intentionally minimal: it only tokenizes comments and strings, and
// treats everything else as opaque, whitespace-separated tokens. This is
// enough to satisfy Zed's requirement that every registered language have a
// `grammar` (see ../../extension.toml), so that the language server (Steps
// 1-3: diagnostics, autocomplete, go-to-definition) works right away.
//
// A real grammar covering Origami's actual expression syntax (object
// literals, formulas, spreads, templates, `${...}` interpolation, etc.) is
// tracked as a follow-up. See grammars/origami/README.md.
//
// HAND-WRITTEN — not touched by scripts/sync-upstream.mjs. Upstream doesn't
// have a Tree-sitter grammar to derive this from in the first place (VS Code
// uses a TextMate grammar instead); see syntaxes/*.tmLanguage.json in the
// upstream submodule for the highlighting rules to eventually port over.

module.exports = grammar({
  name: "origami",

  extras: ($) => [/\s/],

  rules: {
    source_file: ($) => repeat(choice($.comment, $.string, $._token)),

    comment: ($) =>
      token(
        choice(
          seq("//", /[^\n]*/),
          seq("/*", /[^*]*\*+(?:[^/*][^*]*\*+)*/, "/")
        )
      ),

    string: ($) =>
      token(
        choice(
          seq('"', /[^"\\]*(?:\\.[^"\\]*)*/, '"'),
          seq("'", /[^'\\]*(?:\\.[^'\\]*)*/, "'"),
          seq("`", /[^`\\]*(?:\\.[^`\\]*)*/, "`")
        )
      ),

    // Catch-all: any run of non-whitespace characters not already claimed by
    // `comment` or `string` above.
    _token: ($) => /[^\s]+/,
  },
});
