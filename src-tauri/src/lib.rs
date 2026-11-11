//! The Anything launcher.
//!
//! Your account, the game, the servers you can join, and a box to build a mod.
//! The game itself is Horizon, driven through its own launcher CLI, so nothing
//! about Minecraft accounts or game files is reinvented here.

mod account;
mod horizon;
mod firewall;
mod local_mod;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

struct App {
    http: reqwest::Client,
}

/// Where our own copy of Horizon's launcher lives.
fn engine_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|dir| dir.join("horizon"))
}

fn binary(app: &AppHandle) -> Option<PathBuf> {
    let stored = account::load(app);
    horizon::find_binary(stored.horizon_path.as_deref(), engine_dir(app).as_deref())
}

fn binary_or_error(app: &AppHandle) -> Result<PathBuf, String> {
    binary(app).ok_or_else(|| "the game engine is not installed yet".to_string())
}

#[derive(Debug, Serialize)]
struct Overview {
    site: String,
    paired: bool,
    email: Option<String>,
    name: Option<String>,
    plan: Option<String>,
    game: horizon::GameStatus,
    /// Game files fetched for the version that plays.
    prepared: bool,
}

#[tauri::command]
async fn overview(app: AppHandle) -> Overview {
    let stored = account::load(&app);
    let game = horizon::status(binary(&app)).await;
    let prepared = game.selected.is_some() && stored.prepared_for == game.selected;
    Overview {
        site: account::site_url(),
        paired: stored.token.is_some(),
        email: stored.email.clone(),
        name: stored.name.clone(),
        plan: stored.plan.clone(),
        game,
        prepared,
    }
}

// --- the Anything account -------------------------------------------------------

#[tauri::command]
async fn start_pairing(state: State<'_, App>) -> Result<account::PairStart, String> {
    let start = account::pair_start(&state.http).await?;
    // The real browser, where their Google sign-in already is.
    tauri_plugin_opener::open_url(&start.url, None::<&str>)
        .map_err(|error| format!("could not open your browser: {error}"))?;
    Ok(start)
}

#[tauri::command]
async fn poll_pairing(
    app: AppHandle,
    state: State<'_, App>,
    code: String,
) -> Result<account::PairResult, String> {
    account::pair_poll(&app, &state.http, &code).await
}

#[tauri::command]
fn sign_out(app: AppHandle) -> Result<(), String> {
    let mut stored = account::load(&app);
    stored.token = None;
    stored.email = None;
    stored.name = None;
    stored.plan = None;
    account::save(&app, &stored)
}

#[tauri::command]
fn set_horizon_path(app: AppHandle, path: String) -> Result<(), String> {
    let mut stored = account::load(&app);
    stored.horizon_path = Some(path).filter(|path| !path.trim().is_empty());
    account::save(&app, &stored)
}

// --- servers and mods -----------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct Server {
    id: String,
    name: String,
    address: String,
    engine: String,
    kind: String,
    up: bool,
    players: u32,
    /// Who is on it right now, by name.
    #[serde(default)]
    playing: Vec<String>,
    mods: u32,
}

#[derive(Debug, Deserialize)]
struct ServersBody {
    servers: Option<Vec<Server>>,
    error: Option<String>,
}

fn token(app: &AppHandle) -> Result<String, String> {
    account::load(app)
        .token
        .ok_or_else(|| "connect your account first".to_string())
}

async fn json_or_error<T: for<'de> Deserialize<'de>>(response: reqwest::Response) -> Result<(bool, u16, T), String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    match serde_json::from_str::<T>(&text) {
        Ok(body) => Ok((status.is_success(), status.as_u16(), body)),
        Err(_) if status.as_u16() == 401 => Err("your sign-in ran out, connect your account again".to_string()),
        Err(_) => Err(format!("the site is having trouble right now ({})", status.as_u16())),
    }
}

#[tauri::command]
async fn servers(app: AppHandle, state: State<'_, App>) -> Result<Vec<Server>, String> {
    let token = token(&app)?;
    let base = account::site_url();
    let response = state
        .http
        .get(format!("{base}/api/launcher/servers"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let (_, _, body): (bool, u16, ServersBody) = json_or_error(response).await?;
    if let Some(error) = body.error {
        return Err(error);
    }
    Ok(body.servers.unwrap_or_default())
}

#[derive(Debug, Deserialize, Serialize)]
struct ModView {
    id: String,
    name: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    rules: u32,
}

#[derive(Debug, Deserialize)]
struct ModsBody {
    #[serde(default)]
    mods: Vec<ModView>,
    error: Option<String>,
}

#[tauri::command]
async fn world_mods(app: AppHandle, state: State<'_, App>, world: String) -> Result<Vec<ModView>, String> {
    let token = token(&app)?;
    let base = account::site_url();
    let response = state
        .http
        .get(format!("{base}/api/mods"))
        .query(&[("world", world.as_str())])
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let (ok, _, body): (bool, u16, ModsBody) = json_or_error(response).await?;
    if !ok {
        return Err(body.error.unwrap_or_else(|| "could not read that world's mods".to_string()));
    }
    Ok(body.mods)
}

#[derive(Debug, Deserialize)]
struct BuildBody {
    #[serde(default)]
    note: String,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    seconds: f64,
    #[serde(rename = "nextIdeas", default)]
    next_ideas: Vec<String>,
    #[serde(default)]
    r#mod: Option<ModView>,
}

#[derive(Debug, Serialize)]
struct BuildOutcome {
    note: String,
    seconds: f64,
    next_ideas: Vec<String>,
    name: Option<String>,
    summary: Option<String>,
}

#[tauri::command]
async fn build_mod(
    app: AppHandle,
    state: State<'_, App>,
    world: String,
    prompt: String,
    effort: String,
) -> Result<BuildOutcome, String> {
    let token = token(&app)?;
    let base = account::site_url();
    let response = state
        .http
        .post(format!("{base}/api/mods"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "world": world, "prompt": prompt, "effort": effort }))
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let (ok, _, body): (bool, u16, BuildBody) = json_or_error(response).await?;
    if !ok {
        return Err(body.error.unwrap_or_else(|| "that one did not land".to_string()));
    }
    Ok(BuildOutcome {
        note: body.note,
        seconds: body.seconds,
        next_ideas: body.next_ideas,
        name: body.r#mod.as_ref().map(|m| m.name.clone()),
        summary: body.r#mod.map(|m| m.summary),
    })
}

/// Has Windows' firewall question about the game been answered (or is there none)?
#[tauri::command]
async fn firewall_answered() -> bool {
    firewall::answered().await
}

/// The mod idea saved on their account (typed on the website), if any.
#[tauri::command]
async fn my_idea(app: AppHandle, state: State<'_, App>) -> Result<Option<String>, String> {
    let Ok(token) = token(&app) else { return Ok(None) };
    let base = account::site_url();
    let response = state
        .http
        .get(format!("{base}/api/me"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    Ok(body
        .get("idea")
        .and_then(|i| i.get("prompt"))
        .and_then(|p| p.as_str())
        .map(str::to_string))
}

#[derive(Debug, Serialize)]
struct LocalOutcome {
    name: String,
    note: String,
}

/// "Play your mod": the site builds it, this writes it into the single-player
/// world, then the game opens straight into that world.
#[tauri::command]
async fn play_my_mod(
    app: AppHandle,
    state: State<'_, App>,
    prompt: Option<String>,
) -> Result<LocalOutcome, String> {
    let binary = binary_or_error(&app)?;
    let token = token(&app)?;
    let base = account::site_url();
    let response = state
        .http
        .post(format!("{base}/api/mods/local"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "prompt": prompt.unwrap_or_default() }))
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let (ok, _, build): (bool, u16, local_mod::LocalBuild) = json_or_error(response).await?;
    if !ok {
        return Err(build.error.unwrap_or_else(|| "that one did not build".to_string()));
    }
    let saves = local_mod::saves_dir(&binary)
        .await
        .ok_or("could not find where your worlds are kept")?;
    local_mod::install(&saves, &build)?;

    let log = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&log).map_err(|e| e.to_string())?;
    horizon::launch(&binary, &["play", "--world", local_mod::WORLD], &log.join("last-play.log")).await?;
    Ok(LocalOutcome { name: build.name, note: build.note })
}

// --- the game -------------------------------------------------------------------

/// Gets the game ready to fetch files: our own copy of Horizon's launcher (from
/// its GitHub releases, checksum-checked), then the newest Horizon release.
#[tauri::command]
async fn setup_engine(app: AppHandle, state: State<'_, App>) -> Result<(), String> {
    let binary = match binary(&app) {
        Some(binary) => binary,
        None => {
            let dir = engine_dir(&app).ok_or("no folder to install into")?;
            let _ = app.emit("setup-progress", ("Downloading Horizon", 0u32));
            let emitter = app.clone();
            horizon::download(&state.http, &dir, move |pct| {
                let _ = emitter.emit("setup-progress", ("Downloading Horizon", pct));
            })
            .await?
        }
    };

    let status = horizon::status(Some(binary.clone())).await;
    if status.installed.is_empty() {
        let _ = app.emit("setup-progress", ("Installing Minecraft 26.3 on Horizon", 0u32));
        let emitter = app.clone();
        let output = horizon::run_streaming(&binary, &["install", "latest"], move |line| {
            let line = line.trim();
            if !line.is_empty() {
                let _ = emitter.emit("setup-progress", (line.to_string(), 0u32));
            }
        })
        .await?;
        if !output.ok {
            return Err(output.problem());
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
struct DeviceCode {
    url: String,
    code: String,
}

/// Back on the Microsoft step: stops the sign-in that is waiting for its code.
static SIGN_IN_CANCEL: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

#[tauri::command]
async fn microsoft_sign_in(app: AppHandle) -> Result<(), String> {
    let binary = binary_or_error(&app)?;
    let emitter = app.clone();
    let mut opened = false;
    // Made before the sign-in starts, so a Back pressed at any point reaches it.
    let cancelled = SIGN_IN_CANCEL.notified();
    let run = horizon::run_streaming(&binary, &["account", "sign-in"], move |line| {
        if opened {
            return;
        }
        if let Some((url, code)) = horizon::device_code(line) {
            opened = true;
            let _ = emitter.emit("ms-code", DeviceCode { url: url.clone(), code });
            let _ = tauri_plugin_opener::open_url(&url, None::<&str>);
        }
    });
    // Dropping `run` kills the engine's sign-in process (kill_on_drop).
    let output = tokio::select! {
        output = run => output?,
        _ = cancelled => return Err("cancelled".to_string()),
    };
    if output.ok { Ok(()) } else { Err(output.problem()) }
}

#[tauri::command]
fn cancel_sign_in() {
    SIGN_IN_CANCEL.notify_waiters();
}

#[tauri::command]
async fn microsoft_sign_out(app: AppHandle, who: String) -> Result<(), String> {
    let binary = binary_or_error(&app)?;
    let output = horizon::run(&binary, &["account", "sign-out", &who]).await?;
    if output.ok { Ok(()) } else { Err(output.problem()) }
}

#[tauri::command]
async fn prepare_game(app: AppHandle) -> Result<(), String> {
    let binary = binary_or_error(&app)?;
    let emitter = app.clone();
    // `--download` takes the files from Mojang for the signed-in account that
    // owns the game, so nobody needs the official launcher first.
    let output = horizon::run_streaming(&binary, &["prepare", "--download"], move |line| {
        let line = line.trim().trim_start_matches("Horizon:").trim();
        if !line.is_empty() {
            let _ = emitter.emit("game-progress", line.to_string());
        }
    })
    .await?;
    if !output.ok {
        return Err(output.problem());
    }
    let status = horizon::status(Some(binary)).await;
    let mut stored = account::load(&app);
    stored.prepared_for = status.selected;
    account::save(&app, &stored)
}

#[tauri::command]
async fn play(app: AppHandle, server: Option<String>, world: Option<String>) -> Result<(), String> {
    let binary = binary_or_error(&app)?;
    let mut args: Vec<String> = vec!["play".to_string()];
    if let Some(server) = server.filter(|value| !value.trim().is_empty()) {
        args.push("--server".to_string());
        args.push(server);
    } else if let Some(world) = world.filter(|value| !value.trim().is_empty()) {
        args.push("--world".to_string());
        args.push(world);
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    let log = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&log).map_err(|error| error.to_string())?;
    horizon::launch(&binary, &borrowed, &log.join("last-play.log")).await
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://localhost")) {
        return Err("only web links open from here".to_string());
    }
    tauri_plugin_opener::open_url(&url, None::<&str>).map_err(|error| error.to_string())
}


// --- friends ---------------------------------------------------------------

/// What one friend looks like on the Friends page. Mirrors the site's
/// `FriendView`, minus the bits the launcher has no screen for.
#[derive(Debug, Serialize, Deserialize)]
struct Friend {
    id: String,
    #[serde(rename = "accountId")]
    account_id: String,
    name: String,
    email: String,
    #[serde(rename = "mcName", default)]
    mc_name: Option<String>,
    status: String,
    #[serde(rename = "waitingOnThem", default)]
    waiting_on_them: bool,
    #[serde(rename = "playingIn", default)]
    playing_in: Option<String>,
    #[serde(default)]
    worlds: Vec<FriendWorld>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FriendWorld {
    id: String,
    name: String,
    address: String,
    #[serde(default)]
    up: bool,
    #[serde(default)]
    players: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct FriendsBody {
    #[serde(default)]
    friends: Vec<Friend>,
    #[serde(default)]
    me: Option<Me>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Me {
    #[serde(rename = "mcName", default)]
    mc_name: Option<String>,
    #[serde(default)]
    email: String,
}

/// The friend id is `<account>:<account>`. A bare colon is legal in a path
/// segment, but proxies have opinions, so spell it out rather than find out.
fn path_safe(id: &str) -> String {
    id.replace('%', "%25").replace(':', "%3A").replace('/', "%2F")
}

/// One place to send a friends call, so every one of them reports a dead
/// network the same way instead of four slightly different sentences.
async fn friends_call<T: for<'de> Deserialize<'de>>(
    app: &AppHandle,
    state: &State<'_, App>,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<T, String> {
    let token = token(app)?;
    let base = account::site_url();
    let mut request = state
        .http
        .request(method, format!("{base}{path}"))
        .bearer_auth(token)
        .timeout(std::time::Duration::from_secs(30));
    if let Some(value) = body {
        request = request.json(&value);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "could not reach the site, check your internet".to_string())?;
    let (_, _, parsed): (bool, u16, T) = json_or_error(response).await?;
    Ok(parsed)
}

#[tauri::command]
async fn friends(app: AppHandle, state: State<'_, App>) -> Result<FriendsBody, String> {
    let body: FriendsBody = friends_call(&app, &state, reqwest::Method::GET, "/api/friends", None).await?;
    if let Some(error) = body.error {
        return Err(error);
    }
    Ok(body)
}

#[derive(Debug, Deserialize)]
struct Plain {
    error: Option<String>,
}

#[tauri::command]
async fn add_friend(app: AppHandle, state: State<'_, App>, email: String) -> Result<(), String> {
    let body: Plain = friends_call(
        &app,
        &state,
        reqwest::Method::POST,
        "/api/friends",
        Some(serde_json::json!({ "email": email })),
    )
    .await?;
    match body.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[tauri::command]
async fn accept_friend(app: AppHandle, state: State<'_, App>, id: String) -> Result<(), String> {
    let path = format!("/api/friends/{}", path_safe(&id));
    let body: Plain = friends_call(&app, &state, reqwest::Method::PATCH, &path, None).await?;
    match body.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[tauri::command]
async fn remove_friend(app: AppHandle, state: State<'_, App>, id: String) -> Result<(), String> {
    let path = format!("/api/friends/{}", path_safe(&id));
    let body: Plain = friends_call(&app, &state, reqwest::Method::DELETE, &path, None).await?;
    match body.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Your Minecraft name, which is what lets friends see where you are standing.
#[tauri::command]
async fn set_mc_name(app: AppHandle, state: State<'_, App>, name: String) -> Result<(), String> {
    let body: Plain = friends_call(
        &app,
        &state,
        reqwest::Method::PATCH,
        "/api/me",
        Some(serde_json::json!({ "mcName": name })),
    )
    .await?;
    match body.error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();
    // A second launch (a join link clicked while the launcher is open) hands
    // its link to this one instead of opening another window. Must be first.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // The installer registers anything:// already; this repairs it if
            // something else took the scheme, and covers portable copies.
            #[cfg(any(windows, target_os = "linux"))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = _app.deep_link().register_all();
            }
            Ok(())
        })
        .manage(App {
            http: reqwest::Client::builder()
                .user_agent(concat!("anything-launcher/", env!("CARGO_PKG_VERSION")))
                .timeout(std::time::Duration::from_secs(900))
                .build()
                .expect("http client"),
        })
        .invoke_handler(tauri::generate_handler![
            overview,
            start_pairing,
            poll_pairing,
            sign_out,
            set_horizon_path,
            servers,
            friends,
            add_friend,
            accept_friend,
            remove_friend,
            set_mc_name,
            world_mods,
            build_mod,
            my_idea,
            firewall_answered,
            play_my_mod,
            setup_engine,
            microsoft_sign_in,
            cancel_sign_in,
            microsoft_sign_out,
            prepare_game,
            play,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running the launcher");
}
