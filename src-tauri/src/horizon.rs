//! Driving `horizon-launcher`.
//!
//! Horizon ships a complete launcher CLI (docs/launcher-commands.md): it installs
//! releases, prepares the game files from Mojang, signs a Microsoft account in by
//! device code, and starts the game on a given server. Every command takes
//! `--json`.
//!
//! So this launcher does not reimplement any of that. It fetches that one
//! program from Horizon's own GitHub releases (checked against the release's
//! SHA256SUMS), keeps it in its own data folder, and asks it.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const BINARY: &str = if cfg!(windows) {
    "horizon-launcher.exe"
} else {
    "horizon-launcher"
};

/// Where the program sits inside Horizon's macOS download: a whole app bundle,
/// kept intact so its code signature still matches.
const MAC_BUNDLE_BINARY: &str = "Horizon.app/Contents/MacOS/horizon-launcher";

const RELEASES: &str = "https://api.github.com/repos/horizon-rust/horizon/releases?per_page=30";

#[derive(Debug, Serialize)]
pub struct CommandOutput {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
    /// `stdout` parsed, when the command answered with JSON.
    pub json: Option<serde_json::Value>,
}

impl CommandOutput {
    /// The one line a person should read when it failed: the last thing the
    /// program said, without its `error:` prefix.
    pub fn problem(&self) -> String {
        let line = self
            .stderr
            .lines()
            .chain(self.stdout.lines())
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with('{') && !line.starts_with('}'))
            .last()
            .unwrap_or("that did not finish");
        line.trim_start_matches("error:")
            .trim_start_matches("Error:")
            .trim()
            .to_string()
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Account {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub selected: bool,
}

#[derive(Debug, Serialize)]
pub struct GameStatus {
    /// Where the Horizon launcher binary is, if we have one.
    pub binary: Option<String>,
    /// Installed Horizon versions, and the one that plays.
    pub installed: Vec<String>,
    pub selected: Option<String>,
    /// Microsoft accounts the launcher has signed in.
    pub accounts: Vec<Account>,
    /// Whether one of them owns Minecraft: Java Edition.
    pub owner: bool,
}

/// Looks for the Horizon launcher: the path the player gave, our own copy,
/// then the places its own installers use.
pub fn find_binary(hint: Option<&str>, managed: Option<&Path>) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(hint) = hint {
        candidates.push(PathBuf::from(hint));
    }
    if let Some(managed) = managed {
        candidates.push(managed.join(BINARY));
        if cfg!(target_os = "macos") {
            candidates.push(managed.join(MAC_BUNDLE_BINARY));
        }
    }
    if let Ok(from_env) = std::env::var("HORIZON_LAUNCHER") {
        candidates.push(PathBuf::from(from_env));
    }
    if let Ok(paths) = std::env::var("PATH") {
        candidates.extend(std::env::split_paths(&paths).map(|entry| entry.join(BINARY)));
    }
    candidates.extend(default_install_dirs().into_iter().map(|base| base.join(BINARY)));
    candidates.into_iter().find(|path| path.is_file())
}

fn default_install_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = home {
        if cfg!(windows) {
            dirs.push(home.join("AppData/Local/Horizon"));
            dirs.push(home.join("AppData/Local/Programs/Horizon"));
            dirs.push(home.join("AppData/Local/Programs/horizon-launcher"));
        } else if cfg!(target_os = "macos") {
            dirs.push(PathBuf::from("/Applications/Horizon.app/Contents/MacOS"));
            dirs.push(home.join("Applications/Horizon.app/Contents/MacOS"));
        } else {
            dirs.push(home.join(".local/share/horizon"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
    }
    dirs
}

/// `json` asks the launcher for machine-readable output. Leave it off when the
/// point is to stream progress at a person: with `--json` every line is a JSON
/// object, which reads like nothing at all while a long download runs.
fn command(binary: &Path, args: &[&str], json: bool) -> Command {
    let mut command = Command::new(binary);
    command.args(args);
    if json {
        command.arg("--json");
    }
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: do not flash a console at the player.
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Runs one `horizon-launcher` command and hands back what it printed.
pub async fn run(binary: &Path, args: &[&str]) -> Result<CommandOutput, String> {
    let output = command(binary, args, true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|error| format!("could not run the game engine: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let json = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
    Ok(CommandOutput {
        ok: output.status.success(),
        stdout,
        stderr,
        json,
    })
}

/// Like [`run`], but hands every line to `on_line` as it is printed, so the
/// window can show progress and the sign-in code while the command is still
/// going.
/// Runs a command and hands every line to `on_line` as it arrives. Output is
/// plain text, so the lines are the ones a person would want to read.
pub async fn run_streaming(
    binary: &Path,
    args: &[&str],
    mut on_line: impl FnMut(&str),
) -> Result<CommandOutput, String> {
    // kill_on_drop: a caller that gives up (Back during Microsoft sign-in)
    // drops this future, and the engine process must not linger behind it.
    let mut child = command(binary, args, false)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not run the game engine: {error}"))?;

    let mut out_lines = BufReader::new(child.stdout.take().expect("stdout")).lines();
    let mut err_lines = BufReader::new(child.stderr.take().expect("stderr")).lines();
    let mut stdout = String::new();
    let mut stderr = String::new();
    let (mut out_done, mut err_done) = (false, false);

    while !(out_done && err_done) {
        tokio::select! {
            line = out_lines.next_line(), if !out_done => match line {
                Ok(Some(line)) => { on_line(&line); stdout.push_str(&line); stdout.push('\n'); }
                _ => out_done = true,
            },
            line = err_lines.next_line(), if !err_done => match line {
                Ok(Some(line)) => { on_line(&line); stderr.push_str(&line); stderr.push('\n'); }
                _ => err_done = true,
            },
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|error| format!("the game engine stopped oddly: {error}"))?;
    let json = serde_json::from_str::<serde_json::Value>(stdout.trim()).ok();
    Ok(CommandOutput {
        ok: status.success(),
        stdout,
        stderr,
        json,
    })
}

/// Starts the game and lets it run on its own. Its output goes to a log file,
/// not a pipe, so it keeps running after this returns. Waits a few seconds to
/// catch a refusal (no account, no game files) and report it.
pub async fn launch(binary: &Path, args: &[&str], log: &Path) -> Result<(), String> {
    let file = std::fs::File::create(log).map_err(|error| format!("could not write {log:?}: {error}"))?;
    let file_err = file.try_clone().map_err(|error| error.to_string())?;
    let mut child = command(binary, args, false)
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(file_err))
        .spawn()
        .map_err(|error| format!("could not start the game: {error}"))?;

    match tokio::time::timeout(std::time::Duration::from_secs(8), child.wait()).await {
        // Still going after 8 s: the game is up.
        Err(_) => Ok(()),
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => {
            let text = std::fs::read_to_string(log).unwrap_or_default();
            let output = CommandOutput {
                ok: false,
                stdout: String::new(),
                stderr: text,
                json: None,
            };
            Err(output.problem())
        }
    }
}

/// Picks the device-code link and code out of `account sign-in`'s line:
/// "To sign in, open https://www.microsoft.com/link in a browser and enter the code ABCD1234".
pub fn device_code(line: &str) -> Option<(String, String)> {
    let url = line
        .split_whitespace()
        .find(|word| word.starts_with("https://"))?
        .trim_end_matches(['.', ','])
        .to_string();
    let lower = line.to_lowercase();
    let at = lower.find("the code")?;
    let code = line[at + "the code".len()..]
        .split_whitespace()
        .next()?
        .trim_end_matches(['.', ','])
        .to_string();
    if code.len() < 6 {
        return None;
    }
    Some((url, code))
}

/// Everything the first screen needs: is the game there, who is signed in.
pub async fn status(binary: Option<PathBuf>) -> GameStatus {
    let Some(binary) = binary else {
        return GameStatus {
            binary: None,
            installed: Vec::new(),
            selected: None,
            accounts: Vec::new(),
            owner: false,
        };
    };

    let (versions, accounts) = tokio::join!(
        run(&binary, &["versions", "--installed"]),
        run(&binary, &["account", "list"])
    );

    let versions = versions.ok().and_then(|output| output.json).unwrap_or_default();
    let installed = versions
        .get("installed")
        .and_then(|value| value.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let selected = versions
        .get("selected")
        .and_then(|value| value.as_str())
        .map(str::to_string);

    let accounts = accounts.ok().and_then(|output| output.json).unwrap_or_default();
    let owner = accounts
        .get("owner")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let list = accounts
        .get("accounts")
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<Account>>(value).ok())
        .unwrap_or_default();

    GameStatus {
        binary: Some(binary.to_string_lossy().to_string()),
        installed,
        selected,
        accounts: list,
        owner,
    }
}

// --- fetching the engine ------------------------------------------------------

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    assets: Vec<Asset>,
}

#[derive(Debug, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn asset_name() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "aarch64") => "horizon-launcher-windows-arm64.zip",
        ("windows", _) => "horizon-launcher-windows-x64.zip",
        ("macos", "aarch64") => "horizon-launcher-macos-arm64.zip",
        ("macos", _) => "horizon-launcher-macos-x64.zip",
        _ => "horizon-launcher-linux-x86_64.tar.gz",
    }
}

const MIRROR_MANIFEST: &str = "https://storage.googleapis.com/anything-launcher/engine/launcher/manifest.json";

#[derive(Debug, Deserialize)]
struct MirrorManifest {
    assets: std::collections::HashMap<String, MirrorAsset>,
}

#[derive(Debug, Deserialize)]
struct MirrorAsset {
    url: String,
    sha256: String,
}

/// Our own copy (infra/mirror-engine.mjs): no rate limit, no GitHub needed.
async fn mirror_source(client: &reqwest::Client, wanted: &str) -> Result<(String, String), String> {
    let manifest: MirrorManifest = client
        .get(MIRROR_MANIFEST)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("the mirror did not answer: {error}"))?
        .json()
        .await
        .map_err(|error| format!("the mirror answered oddly: {error}"))?;
    let asset = manifest.assets.get(wanted).ok_or("the mirror has no build for this computer")?;
    if !asset.url.starts_with("https://storage.googleapis.com/anything-launcher/") {
        return Err("the mirror pointed somewhere else".to_string());
    }
    if asset.sha256.len() != 64 || !asset.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("the mirror has no checksum for it".to_string());
    }
    Ok((asset.url.clone(), asset.sha256.to_lowercase()))
}

/// Horizon's own newest `launcher@` release on GitHub and its SHA256SUMS.
async fn github_source(client: &reqwest::Client, wanted: &str) -> Result<(String, String), String> {
    let mut request = client
        .get(RELEASES)
        .header("accept", "application/vnd.github+json");
    // CI only: shared runners hit GitHub's anonymous rate limit. Players never
    // have this set, and it goes to the API call alone.
    if let Ok(token) = std::env::var("HORIZON_GITHUB_TOKEN") {
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
    }
    let releases: Vec<Release> = request
        .send()
        .await
        .map_err(|_| "could not reach GitHub to fetch the game engine".to_string())?
        .error_for_status()
        .map_err(|error| format!("GitHub said no: {error}"))?
        .json()
        .await
        .map_err(|error| format!("GitHub answered oddly: {error}"))?;

    let release = releases
        .iter()
        .filter(|release| !release.draft && release.tag_name.starts_with("launcher@"))
        .find(|release| release.assets.iter().any(|asset| asset.name == wanted))
        .ok_or("no Horizon launcher release for this computer yet")?;
    let url_of = |name: &str| {
        release
            .assets
            .iter()
            .find(|asset| asset.name == name)
            .map(|asset| asset.browser_download_url.clone())
    };
    let zip_url = url_of(wanted).ok_or("the release lost its download")?;
    let sums_url = url_of("SHA256SUMS").ok_or("the release has no checksums, so it is not safe to use")?;

    let sums = client
        .get(&sums_url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("could not fetch the checksums: {error}"))?
        .text()
        .await
        .map_err(|error| error.to_string())?;
    let expected = sums
        .lines()
        .find(|line| line.trim_end().ends_with(wanted))
        .and_then(|line| line.split_whitespace().next())
        .ok_or("the checksums do not list this download")?
        .to_lowercase();

    Ok((zip_url, expected))
}

/// Downloads `url` and keeps it only if it matches `expected` (SHA-256).
async fn fetch_checked(
    client: &reqwest::Client,
    url: &str,
    expected: &str,
    progress: &mut impl FnMut(u32),
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| format!("could not download the game engine: {error}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut last = 0;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("the download broke off: {error}"))?
    {
        bytes.extend_from_slice(&chunk);
        if total > 0 {
            let pct = ((bytes.len() as u64 * 100) / total) as u32;
            if pct != last {
                last = pct;
                progress(pct);
            }
        }
    }

    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected.to_lowercase() {
        return Err("the download did not match Horizon's checksum, so it was thrown away".to_string());
    }

    Ok(bytes)
}

/// Downloads Horizon's own launcher into `dir`, checked against its SHA-256:
/// from our mirror first, from GitHub if the mirror fails. `progress` gets
/// 0..=100.
pub async fn download(
    client: &reqwest::Client,
    dir: &Path,
    mut progress: impl FnMut(u32),
) -> Result<PathBuf, String> {
    let wanted = asset_name();
    if wanted.ends_with(".tar.gz") {
        return Err("this computer needs Horizon from playhorizon.dev for now".to_string());
    }
    let from_mirror = match mirror_source(client, wanted).await {
        Ok((url, sha)) => fetch_checked(client, &url, &sha, &mut progress).await,
        Err(problem) => Err(problem),
    };
    let bytes = match from_mirror {
        Ok(bytes) => bytes,
        Err(_) => {
            let (url, sha) = github_source(client, wanted).await?;
            fetch_checked(client, &url, &sha, &mut progress).await?
        }
    };

    std::fs::create_dir_all(dir).map_err(|error| format!("could not make {dir:?}: {error}"))?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|error| format!("the download is not a zip: {error}"))?;
    if cfg!(target_os = "macos") {
        return unpack_mac_bundle(&mut archive, dir);
    }
    let mut entry = archive
        .by_name(BINARY)
        .map_err(|_| "the download did not hold the launcher program".to_string())?;
    let mut program = Vec::new();
    entry
        .read_to_end(&mut program)
        .map_err(|error| error.to_string())?;
    let target = dir.join(BINARY);
    let partial = dir.join(format!("{BINARY}.part"));
    std::fs::write(&partial, program).map_err(|error| format!("could not save it: {error}"))?;
    make_executable(&partial)?;
    std::fs::rename(&partial, &target).map_err(|error| format!("could not save it: {error}"))?;
    Ok(target)
}

/// macOS: Horizon ships `Horizon.app`. Unpack the whole bundle (modes kept, so
/// the program stays runnable and its signature intact) beside a fresh copy,
/// then swap it in.
fn unpack_mac_bundle(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    dir: &Path,
) -> Result<PathBuf, String> {
    archive
        .by_name(MAC_BUNDLE_BINARY)
        .map_err(|_| "the download did not hold the launcher program".to_string())?;
    let staging = dir.join("Horizon.app.part");
    let _ = std::fs::remove_dir_all(&staging);
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(relative) = entry.enclosed_name() else {
            return Err("the download held an unsafe path, so it was thrown away".to_string());
        };
        let Ok(inside) = relative.strip_prefix("Horizon.app") else {
            continue;
        };
        let out = staging.join(inside);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|error| format!("could not save it: {error}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("could not save it: {error}"))?;
        }
        let mut data = Vec::new();
        entry.read_to_end(&mut data).map_err(|error| error.to_string())?;
        std::fs::write(&out, data).map_err(|error| format!("could not save it: {error}"))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(|error| format!("could not save it: {error}"))?;
        }
    }
    let program = staging.join("Contents/MacOS/horizon-launcher");
    make_executable(&program)?;
    let bundle = dir.join("Horizon.app");
    let _ = std::fs::remove_dir_all(&bundle);
    std::fs::rename(&staging, &bundle).map_err(|error| format!("could not save it: {error}"))?;
    Ok(dir.join(MAC_BUNDLE_BINARY))
}

/// Zip extraction loses the executable bit on macOS and Linux; put it back.
fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("could not make it runnable: {error}"))?;
    }
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_device_code_line() {
        let line = "To sign in, open https://www.microsoft.com/link in a browser and enter the code FJLCLPEQ";
        assert_eq!(
            device_code(line),
            Some(("https://www.microsoft.com/link".to_string(), "FJLCLPEQ".to_string()))
        );
        assert_eq!(device_code("Horizon: Play: reading the sign-in…"), None);
    }

    #[test]
    fn problem_drops_the_prefix() {
        let output = CommandOutput {
            ok: false,
            stdout: String::new(),
            stderr: "Horizon: Play: reading the sign-in…\nerror: Sign in with a Microsoft account.\n".to_string(),
            json: None,
        };
        assert_eq!(output.problem(), "Sign in with a Microsoft account.");
    }

    /// Our mirror alone (no GitHub): the manifest lists this computer's build,
    /// and the bytes match its checksum. Network: `cargo test -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn the_mirror_serves_this_computer() {
        let client = reqwest::Client::builder().user_agent("anything-launcher-ci").build().unwrap();
        let (url, sha) = mirror_source(&client, asset_name()).await.expect("mirror manifest");
        let bytes = fetch_checked(&client, &url, &sha, &mut |_| {}).await.expect("mirror download");
        assert!(bytes.len() > 1_000_000, "suspiciously small: {}", bytes.len());
        // A wrong checksum must throw the download away.
        let wrong = "0".repeat(64);
        assert!(fetch_checked(&client, &url, &wrong, &mut |_| {}).await.is_err());
    }

    /// Fetches the real engine for this machine and runs it. Needs the network,
    /// so it only runs when asked: `cargo test -- --ignored`. CI runs it on macOS.
    #[tokio::test]
    #[ignore]
    async fn installs_and_runs_the_engine() {
        let dir = std::env::temp_dir().join(format!("aim-engine-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let client = reqwest::Client::builder()
            .user_agent("anything-launcher-ci")
            .build()
            .unwrap();
        let binary = download(&client, &dir, |_| {}).await.expect("engine download");
        assert!(binary.is_file(), "{binary:?} missing");
        assert_eq!(find_binary(None, Some(&dir)), Some(binary.clone()));
        let output = std::process::Command::new(&binary)
            .arg("--help")
            .output()
            .expect("the engine program runs");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
