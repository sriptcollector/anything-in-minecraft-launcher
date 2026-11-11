//! A mod for the player's own single-player world.
//!
//! The site plans and compiles the mod (the same planner and forge that build
//! into linked worlds) and hands back the data pack. This writes it into the
//! world's `datapacks` folder; the game switches a pack on when the world
//! opens, so there is no server and no reload to run.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The single-player world the launcher plays and builds into.
pub const WORLD: &str = "Anything";

#[derive(Debug, Deserialize)]
pub struct PackFile {
    pub path: String,
    pub text: String,
}

#[derive(Debug, Deserialize)]
pub struct LocalBuild {
    #[serde(rename = "packName", default)]
    pub pack_name: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub files: Vec<PackFile>,
    #[serde(default)]
    pub core: Vec<PackFile>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Where Horizon keeps single-player worlds. Asks the engine first (it knows
/// any folder the player moved it to), then falls back to its default.
pub async fn saves_dir(binary: &Path) -> Option<PathBuf> {
    if let Ok(out) = crate::horizon::run(binary, &["worlds", "list"]).await {
        if let Some(list) = out.json.as_ref().and_then(|v| v.as_array()) {
            if let Some(path) = list
                .iter()
                .filter_map(|w| w.get("path").and_then(|p| p.as_str()))
                .map(PathBuf::from)
                .find_map(|p| p.parent().map(Path::to_path_buf))
            {
                return Some(path);
            }
        }
    }
    default_saves_dir()
}

fn default_saves_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("horizon").join("saves"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/Application Support/horizon/saves"))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/horizon/saves"))
    }
}

/// Only plain relative paths inside the pack: no `..`, no roots, no drives.
fn safe(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let parts: Vec<&str> = relative.split('/').collect();
    if parts
        .iter()
        .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains(':') || p.contains('\\'))
    {
        return Err(format!("refusing to write {relative}"));
    }
    Ok(parts.iter().fold(root.to_path_buf(), |acc, p| acc.join(p)))
}

fn write_pack(dir: &Path, files: &[PackFile]) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    for file in files {
        let target = safe(dir, &file.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &file.text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Writes the mod and the shared core pack into `<saves>/Anything/datapacks`.
pub fn install(saves: &Path, build: &LocalBuild) -> Result<PathBuf, String> {
    let name = &build.pack_name;
    if !name.starts_with("aim_") || name == "aim_core" || name.contains(['/', '\\', '.']) {
        return Err("the site sent a pack name this launcher will not write".to_string());
    }
    let datapacks = saves.join(WORLD).join("datapacks");
    write_pack(&datapacks.join("aim_core"), &build.core)?;
    write_pack(&datapacks.join(name), &build.files)?;
    Ok(datapacks.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_that_escape() {
        let root = Path::new("x");
        assert!(safe(root, "data/a.json").is_ok());
        assert!(safe(root, "../evil").is_err());
        assert!(safe(root, "C:/evil").is_err());
        assert!(safe(root, "a//b").is_err());
    }

    #[test]
    fn writes_pack_and_core() {
        let saves = std::env::temp_dir().join(format!("aim-local-{}", std::process::id()));
        let build = LocalBuild {
            pack_name: "aim_test".into(),
            name: "Test".into(),
            note: String::new(),
            files: vec![PackFile { path: "pack.mcmeta".into(), text: "{}".into() }],
            core: vec![PackFile { path: "pack.mcmeta".into(), text: "{}".into() }],
            error: None,
        };
        let dir = install(&saves, &build).unwrap();
        assert!(dir.join("pack.mcmeta").is_file());
        assert!(saves.join(WORLD).join("datapacks/aim_core/pack.mcmeta").is_file());
        let bad = LocalBuild { pack_name: "../x".into(), ..build };
        assert!(install(&saves, &bad).is_err());
        let _ = std::fs::remove_dir_all(saves);
    }

    /// The real thing on this computer: the site builds the mod, it is written
    /// into the single-player world, and the game opens there. Needs
    /// AIM_SITE_URL, AIM_TEST_TOKEN (a launcher token) and HORIZON_BIN.
    ///   cargo test --lib local_mod -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn builds_into_this_pcs_world_and_opens_it() {
        let site = std::env::var("AIM_SITE_URL").expect("AIM_SITE_URL");
        let token = std::env::var("AIM_TEST_TOKEN").expect("AIM_TEST_TOKEN");
        let binary = PathBuf::from(std::env::var("HORIZON_BIN").expect("HORIZON_BIN"));
        let response = reqwest::Client::new()
            .post(format!("{site}/api/mods/local"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "prompt": "" }))
            .timeout(std::time::Duration::from_secs(900))
            .send()
            .await
            .unwrap();
        let status = response.status();
        let build: LocalBuild = response.json().await.unwrap();
        assert!(status.is_success(), "site said {status}: {:?}", build.error);
        println!("built {} ({}), {} files", build.name, build.pack_name, build.files.len());
        let saves = saves_dir(&binary).await.expect("saves dir");
        let dir = install(&saves, &build).unwrap();
        println!("wrote {}", dir.display());
        let log = std::env::temp_dir().join("aim-local-play.log");
        crate::horizon::launch(&binary, &["play", "--world", WORLD], &log).await.unwrap();
        println!("game started, log at {}", log.display());
    }
}
