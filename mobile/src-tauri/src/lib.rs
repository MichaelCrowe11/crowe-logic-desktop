// Crowe Logic mobile.
//
// The desktop app is Electron with 54 IPC handlers - PTY, git, filesystem walk,
// child-process plugins, an auto-updater. Almost none of that has a meaning on
// a phone, so this is not a port of that shell. It is the part of Crowe Logic
// that is *better* on a phone: you are standing in front of a grow bag with a
// camera in your hand, and you want to know whether what you are looking at is
// contamination.
//
// The HTTP call lives here rather than in the webview on purpose. A Tauri
// webview is served from tauri://localhost, so a fetch() to the analysis host
// is cross-origin and dies on CORS preflight unless that host is configured to
// allow a scheme it has never heard of. Going through Rust sidesteps the
// browser security model entirely, and keeps the API key out of a context that
// any injected script could read.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct AnalyzeRequest {
    /// Full endpoint URL. Configurable because the backend is still moving:
    /// tools/vision.py posts to `/api/crowe-vision/analyze` on the hosted app,
    /// while domain/vision mounts a FastAPI router at `/vision/*`. Pinning
    /// either one here would just bake in today's guess.
    pub endpoint: String,
    #[serde(default)]
    pub api_key: String,
    pub body: serde_json::Value,
}

/// Post an image payload to a Crowe Vision endpoint and hand back whatever it says.
///
/// Errors are returned as strings rather than swallowed: a grow-room call that
/// silently reports "no contamination" because the request 404'd is worse than
/// no answer at all.
#[tauri::command]
async fn vision_analyze(req: AnalyzeRequest) -> Result<serde_json::Value, String> {
    let url = req.endpoint.trim();
    // The frontend is bundled, not remote, so this is a guard against our own
    // mistakes rather than against an attacker - but a cleartext upload of a
    // customer's grow-room photo is worth refusing outright.
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err(format!(
            "refusing to send an image to {url} - use https, or localhost for a dev backend"
        ));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("could not build http client: {e}"))?;

    let mut rb = client.post(url).json(&req.body);
    if !req.api_key.is_empty() {
        rb = rb.bearer_auth(&req.api_key);
    }

    let res = rb
        .send()
        .await
        .map_err(|e| format!("could not reach {url}: {e}"))?;

    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("could not read the response body: {e}"))?;

    if !status.is_success() {
        let detail = text.chars().take(400).collect::<String>();
        return Err(format!("{url} returned HTTP {}: {detail}", status.as_u16()));
    }

    // A 200 carrying HTML means we hit a web page, not the API - report that
    // rather than letting it surface as a confusing parse error.
    serde_json::from_str(&text).map_err(|_| {
        let detail = text.chars().take(200).collect::<String>();
        format!("{url} answered with something that is not JSON: {detail}")
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![vision_analyze])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
