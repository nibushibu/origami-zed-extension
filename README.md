# Origami for Zed

A [Zed](https://zed.dev) editor extension that adds language support for the
[Origami](https://weborigami.org) expression language.

This is an unofficial fork/port of the official VS Code extension,
[WebOrigami/origami-vscode-extension](https://github.com/WebOrigami/origami-vscode-extension).
It reuses that extension's editor-agnostic Language Server Protocol (LSP)
server code as-is, and adds the Zed-specific plumbing (a small Rust/WASM
wrapper, a Tree-sitter grammar, and Zed's `.toml` language configuration)
needed to run it inside Zed. See [SYNC.md](./SYNC.md) for how this repo
tracks upstream and stays up to date.

## Status

| Feature | Status |
| --- | --- |
| Diagnostics (syntax errors) | ✅ working |
| AutoComplete (builtins, paths, local declarations) | ✅ working |
| Go to Definition | ✅ working |
| Syntax highlighting | 🚧 placeholder only (comments/strings); see `grammars/origami/README.md` |
| `.ori.html` / `.ori.md` template documents | ⚠️ same LSP-only limitation as upstream (upstream doesn't support these for diagnostics/autocomplete/definition either) |

## Repository layout

```
origami-zed-extension/
├── extension.toml              # Zed extension manifest
├── Cargo.toml, src/lib.rs      # Rust/WASM wrapper: launches the language server
├── languages/
│   ├── origami/config.toml             # generated — see SYNC.md
│   ├── origami-html/config.toml        # generated
│   └── origami-markdown/config.toml    # generated
├── grammars/origami/           # placeholder Tree-sitter grammar (hand-written)
├── language-server/
│   ├── zed-entry.mjs           # hand-written composition layer (see file header)
│   ├── package.json            # generated — npm runtime deps
│   └── vendor/                 # generated — copied verbatim from upstream
├── upstream/                   # git submodule: WebOrigami/origami-vscode-extension
├── scripts/sync-upstream.mjs   # regenerates all "generated" files above
└── SYNC.md                     # generated/hand-written boundary + sync instructions
```

## Developing

Requires Rust installed via [rustup](https://rustup.rs) (not Homebrew — Zed's
dev extension loader specifically requires the rustup toolchain) with the
`wasm32-wasip2` target:

```sh
rustup target add wasm32-wasip2
cargo build --target wasm32-wasip2
```

To try it in Zed: open the command palette → `zed: install dev extension` →
select this directory.

Node.js is required at *runtime* (Zed provides its own managed Node binary
automatically; you don't need to install one yourself just to use the
extension).

## Updating from upstream

See [SYNC.md](./SYNC.md).

## License

MIT. See [LICENSE](./LICENSE) — this project vendors code from upstream
(also MIT) alongside new Zed-specific code.
