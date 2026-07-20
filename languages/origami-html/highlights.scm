; Placeholder highlighting query, matching the placeholder grammar in
; tree-sitter-origami (see extension.toml [grammars.origami]). Only comments
; and strings are recognized as distinct nodes today; everything else is an
; opaque token with no highlighting. See SYNC.md for the plan to flesh this
; out alongside a real grammar (Step 4).

(comment) @comment

(string) @string
