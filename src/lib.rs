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
//! Runtime npm dependencies are read from `language-server/package.json`
//! (itself regenerated from upstream by scripts/sync-upstream.mjs) rather
//! than hard-coded here, so that dependency versions have a single source
//! of truth.

use std::env;
use std::fs;
use std::path::PathBuf;

use zed_extension_api::{self as zed, serde_json, LanguageServerId, Result};

/// Path to the LSP server entry point, relative to the extension's root
/// directory.
const SERVER_ENTRY_RELATIVE_PATH: &str = "language-server/zed-entry.mjs";

/// Path to the generated package.json listing the server's npm runtime
/// dependencies, relative to the extension's root directory.
const SERVER_PACKAGE_JSON_RELATIVE_PATH: &str = "language-server/package.json";

struct OrigamiExtension {
    /// Avoids re-checking/re-installing npm dependencies on every call to
    /// `language_server_command` within the same extension session.
    dependencies_installed: bool,
}

impl OrigamiExtension {
    fn ensure_dependencies_installed(
        &mut self,
        language_server_id: &LanguageServerId,
    ) -> Result<()> {
        if self.dependencies_installed {
            return Ok(());
        }

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

        self.dependencies_installed = true;
        Ok(())
    }
}

/// Reads the `dependencies` object out of `language-server/package.json`.
fn read_server_dependencies() -> Result<Vec<(String, String)>> {
    let path = extension_root()?.join(SERVER_PACKAGE_JSON_RELATIVE_PATH);
    let contents = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let json: serde_json::Value =
        serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    let dependencies = json
        .get("dependencies")
        .and_then(|value| value.as_object())
        .ok_or_else(|| format!("{} has no \"dependencies\" object", path.display()))?;

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
            dependencies_installed: false,
        }
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        _worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        self.ensure_dependencies_installed(language_server_id)?;

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
