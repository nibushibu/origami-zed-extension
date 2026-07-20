//! Zed extension entry point for Origami language support.
//!
//! HAND-WRITTEN — not touched by scripts/sync-upstream.mjs.
//!
//! This wrapper's only job is to launch the Origami language server
//! (`language-server/zed-entry.mjs`, see that file and
//! `language-server/vendor/` for the actual language logic, which is
//! vendored verbatim from the upstream VS Code extension) as a Node child
//! process speaking LSP over stdio.
//!
//! ## Why the server's JS files are embedded via `include_str!`
//!
//! When Zed runs this extension, `env::current_dir()` does NOT point at this
//! extension's source directory. It points at a separate, initially-empty
//! per-extension working directory (e.g.
//! `~/Library/Application Support/Zed/extensions/work/origami/`) that Zed
//! sets up purely as a sandboxed scratch space for the extension to install
//! things into (this is also where `npm_install_package` installs
//! `node_modules`). Our own static JS files under `language-server/` are
//! *source* files checked into this repo, not something installed at
//! runtime, so they don't exist there by default.
//!
//! To work around this, the JS source is embedded into the compiled
//! extension binary at *build* time (when `cwd` really is this repo) via
//! `include_str!`, and written out into the working directory the first
//! time the language server is started. Runtime npm dependencies are parsed
//! from the same embedded `language-server/package.json` (itself
//! regenerated from upstream by scripts/sync-upstream.mjs), so dependency
//! versions have a single source of truth.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use zed_extension_api::{self as zed, serde_json, LanguageServerId, Result};

/// Path to the LSP server entry point, relative to the extension's working
/// directory, once `write_embedded_files` has run.
const SERVER_ENTRY_RELATIVE_PATH: &str = "language-server/zed-entry.mjs";

/// (path relative to the working directory, embedded file contents).
///
/// Must be kept in sync with the `import`/`require` graph rooted at
/// `language-server/zed-entry.mjs`. `language-server/vendor/server/types.ts`
/// is intentionally excluded: it's only referenced from JSDoc `@typedef`
/// comments (type-checking only), never actually imported at runtime.
const EMBEDDED_FILES: &[(&str, &str)] = &[
    (
        "language-server/package.json",
        include_str!("../language-server/package.json"),
    ),
    (
        "language-server/zed-entry.mjs",
        include_str!("../language-server/zed-entry.mjs"),
    ),
    (
        "language-server/vendor/utilities.mjs",
        include_str!("../language-server/vendor/utilities.mjs"),
    ),
    (
        "language-server/vendor/builtins.json",
        include_str!("../language-server/vendor/builtins.json"),
    ),
    (
        "language-server/vendor/server/autoComplete.mjs",
        include_str!("../language-server/vendor/server/autoComplete.mjs"),
    ),
    (
        "language-server/vendor/server/definition.mjs",
        include_str!("../language-server/vendor/server/definition.mjs"),
    ),
    (
        "language-server/vendor/server/diagnostics.mjs",
        include_str!("../language-server/vendor/server/diagnostics.mjs"),
    ),
    (
        "language-server/vendor/server/findInProjectScope.mjs",
        include_str!("../language-server/vendor/server/findInProjectScope.mjs"),
    ),
    (
        "language-server/vendor/server/localDeclarations.mjs",
        include_str!("../language-server/vendor/server/localDeclarations.mjs"),
    ),
];

/// The embedded `language-server/package.json` contents, used to look up
/// runtime npm dependencies without touching disk.
const SERVER_PACKAGE_JSON: &str = include_str!("../language-server/package.json");

struct OrigamiExtension {
    /// Avoids re-writing embedded files / re-checking npm dependencies on
    /// every call to `language_server_command` within the same extension
    /// session.
    server_ready: bool,
}

impl OrigamiExtension {
    fn ensure_server_ready(&mut self, language_server_id: &LanguageServerId) -> Result<()> {
        if self.server_ready {
            return Ok(());
        }

        let root = extension_root()?;
        write_embedded_files(&root)?;
        install_dependencies(language_server_id)?;

        self.server_ready = true;
        Ok(())
    }
}

/// Writes every entry of `EMBEDDED_FILES` into `root`, creating parent
/// directories as needed. Always overwrites, so an extension upgrade (new
/// embedded contents) can't get stuck behind stale files left over in a
/// working directory from a previous version.
fn write_embedded_files(root: &Path) -> Result<()> {
    for (relative_path, contents) in EMBEDDED_FILES {
        let dest = root.join(relative_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        fs::write(&dest, contents)
            .map_err(|error| format!("failed to write {}: {error}", dest.display()))?;
    }
    Ok(())
}

fn install_dependencies(language_server_id: &LanguageServerId) -> Result<()> {
    for (name, version) in read_server_dependencies()? {
        let installed_version = zed::npm_package_installed_version(&name)?;
        if installed_version.as_deref() != Some(version.as_str()) {
            zed::set_language_server_installation_status(
                language_server_id,
                &zed::LanguageServerInstallationStatus::Downloading,
            );
            zed::npm_install_package(&name, &version)?;
        }
    }
    Ok(())
}

/// Reads the `dependencies` object out of the embedded `package.json`.
fn read_server_dependencies() -> Result<Vec<(String, String)>> {
    let json: serde_json::Value =
        serde_json::from_str(SERVER_PACKAGE_JSON).map_err(|error| error.to_string())?;
    let dependencies = json
        .get("dependencies")
        .and_then(|value| value.as_object())
        .ok_or_else(|| {
            "embedded language-server/package.json has no \"dependencies\" object".to_string()
        })?;

    Ok(dependencies
        .iter()
        .filter_map(|(name, version)| {
            version
                .as_str()
                .map(|version| (name.clone(), version.to_string()))
        })
        .collect())
}

fn extension_root() -> Result<PathBuf> {
    env::current_dir().map_err(|error| error.to_string())
}

impl zed::Extension for OrigamiExtension {
    fn new() -> Self {
        Self {
            server_ready: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        self.ensure_server_ready(language_server_id)?;

        let entry_path = extension_root()?.join(SERVER_ENTRY_RELATIVE_PATH);

        Ok(zed::Command {
            command: zed::node_binary_path()?,
            args: vec![
                entry_path.to_string_lossy().to_string(),
                "--stdio".to_string(),
            ],
            env: Default::default(),
        })
    }
}

zed::register_extension!(OrigamiExtension);
