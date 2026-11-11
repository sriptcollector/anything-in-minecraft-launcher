//! Windows Defender Firewall asks about the game the first time each Horizon
//! version starts ("Windows Defender Firewall has blocked some features of
//! this app"). Single player and joining servers work whatever the answer, so
//! the launcher tells the player to press Cancel (Allow needs an administrator)
//! and watches for the answer: Windows writes a rule for that exact program.

use std::path::{Path, PathBuf};

/// The newest Horizon game program, which is the one that just started.
fn newest_client() -> Option<PathBuf> {
    let run = PathBuf::from(std::env::var_os("APPDATA")?).join("horizon-launcher").join("run");
    std::fs::read_dir(run)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path().join("game").join("horizon-client.exe"))
        .filter(|path| path.is_file())
        .max_by_key(|path| path.metadata().and_then(|m| m.modified()).ok())
}

/// The folder name Horizon gives each version (a long hash), which is in the
/// rule's program path even when Windows rewrites the rest of it.
fn version_key(client: &Path) -> Option<String> {
    Some(client.parent()?.parent()?.file_name()?.to_string_lossy().to_lowercase())
}

/// True once Windows has an answer on file for the current game program, or
/// when there is nothing to ask (not Windows, or no game installed yet).
pub async fn answered() -> bool {
    if !cfg!(windows) {
        return true;
    }
    let Some(key) = newest_client().as_deref().and_then(version_key) else { return true };
    let mut command = tokio::process::Command::new("netsh");
    command.args(["advfirewall", "firewall", "show", "rule", "name=horizon-client.exe", "verbose"]);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    match command.output().await {
        Ok(out) => String::from_utf8_lossy(&out.stdout).to_lowercase().contains(&key),
        // If Windows will not say, do not keep the player waiting on a guess.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(windows)]
    fn key_is_the_version_folder() {
        let p = Path::new(r"C:\x\horizon-launcher\run\ABC123\game\horizon-client.exe");
        assert_eq!(version_key(p).as_deref(), Some("abc123"));
    }

    /// On this PC: prints whether the current Horizon version has an answer.
    #[tokio::test]
    #[ignore]
    async fn this_pc() {
        println!("newest {:?} answered {}", newest_client(), answered().await);
    }
}
