//! The launcher's own account: pairing with the site, and the token it keeps.
//!
//! The launcher never handles a password. It shows a short code, opens the real
//! browser at the pairing page, and swaps the code for a token of its own once
//! the person has confirmed there.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Default, Clone)]
pub struct Stored {
    pub token: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub plan: Option<String>,
    /// Where the Horizon launcher binary is, when the player pointed at it.
    pub horizon_path: Option<String>,
    /// The Horizon version whose game files were fetched from Mojang last.
    #[serde(default)]
    pub prepared_for: Option<String>,
}

pub fn site_url() -> String {
    std::env::var("AIM_SITE_URL")
        .unwrap_or_else(|_| "https://minecraft.westwardconsulting.ai".to_string())
}

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("no config folder: {error}"))?;
    std::fs::create_dir_all(&dir).map_err(|error| format!("could not make {dir:?}: {error}"))?;
    Ok(dir.join("account.json"))
}

pub fn load(app: &tauri::AppHandle) -> Stored {
    let Ok(path) = config_path(app) else {
        return Stored::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, stored: &Stored) -> Result<(), String> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(stored).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| format!("could not save your account: {error}"))
}

#[derive(Debug, Serialize)]
pub struct PairStart {
    pub code: String,
    pub url: String,
    pub minutes: u32,
}

#[derive(Debug, Deserialize)]
struct PairStartBody {
    code: String,
    minutes: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PairPollBody {
    token: Option<String>,
    waiting: Option<bool>,
    error: Option<String>,
    account: Option<PairAccount>,
}

#[derive(Debug, Deserialize)]
struct PairAccount {
    email: String,
    name: Option<String>,
    plan: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PairResult {
    pub paired: bool,
    pub waiting: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub error: Option<String>,
}

pub async fn pair_start(client: &reqwest::Client) -> Result<PairStart, String> {
    let base = site_url();
    let response = client
        .post(format!("{base}/api/launcher/pair"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|error| format!("could not reach {base}: {error}"))?;
    let body: PairStartBody = response
        .json()
        .await
        .map_err(|error| format!("the site answered oddly: {error}"))?;

    Ok(PairStart {
        url: format!("{base}/launcher/pair?code={}", body.code),
        code: body.code,
        minutes: body.minutes.unwrap_or(10),
    })
}

pub async fn pair_poll(
    app: &tauri::AppHandle,
    client: &reqwest::Client,
    code: &str,
) -> Result<PairResult, String> {
    let base = site_url();
    let response = client
        .post(format!("{base}/api/launcher/pair"))
        .json(&serde_json::json!({ "code": code }))
        .send()
        .await
        .map_err(|error| format!("could not reach {base}: {error}"))?;

    let status = response.status();
    let body: PairPollBody = response.json().await.map_err(|error| error.to_string())?;

    if body.waiting.unwrap_or(false) {
        return Ok(PairResult {
            paired: false,
            waiting: true,
            email: None,
            plan: None,
            error: None,
        });
    }
    if let Some(token) = body.token {
        let account = body.account;
        let mut stored = load(app);
        stored.token = Some(token);
        stored.email = account.as_ref().map(|a| a.email.clone());
        stored.name = account.as_ref().and_then(|a| a.name.clone());
        stored.plan = account.as_ref().and_then(|a| a.plan.clone());
        save(app, &stored)?;
        return Ok(PairResult {
            paired: true,
            waiting: false,
            email: stored.email.clone(),
            plan: stored.plan.clone(),
            error: None,
        });
    }

    Ok(PairResult {
        paired: false,
        waiting: false,
        email: None,
        plan: None,
        error: Some(
            body.error
                .unwrap_or_else(|| format!("the site answered {status}")),
        ),
    })
}
