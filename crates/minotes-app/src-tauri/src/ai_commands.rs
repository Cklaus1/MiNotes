//! Tauri commands for the AI platform (see minotes-core `ai`).
//!
//! - The OpenRouter key lives in the OS keychain (`keyring`); if no keychain
//!   is available nothing is stored and `OPENROUTER_API_KEY` is used instead.
//!   The key is never returned to the webview — only a `KeyStatus`.
//! - `ai_ask` runs on a background thread with its own read connection to the
//!   active graph (so the UI's DB lock is never held during network calls)
//!   and streams progress as `ai://event` events.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use minotes_core::ai::{self, catalog, settings::{AiSettings, ProviderKind, TaskClass}, AiError, AiEvent, AiStatus, Conversation, KeyStatus, RunOutput, RunRecord};
use minotes_core::db::Database;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::AppState;

const KEYRING_SERVICE: &str = "minotes-ai";
const KEYRING_USER: &str = "openrouter";

#[derive(Default)]
struct Runtime {
    conversations: Mutex<HashMap<String, Conversation>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(Runtime::default)
}

// ── Keychain ──

/// (key, keychain usable). A missing entry still means the keychain works.
#[cfg(not(target_os = "android"))]
fn keychain_read() -> (Option<String>, bool) {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| e.get_password()) {
        Ok(k) => (Some(k), true),
        Err(keyring::Error::NoEntry) => (None, true),
        Err(_) => (None, false),
    }
}

#[cfg(not(target_os = "android"))]
fn keychain_write(key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "android"))]
fn keychain_delete() {
    if let Ok(e) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = e.delete_credential();
    }
}

// Android: no keychain backend yet (an Android Keystore-backed store is a
// follow-up). Report it as unavailable rather than pretend to store the key.
#[cfg(target_os = "android")]
fn keychain_read() -> (Option<String>, bool) {
    let _ = (KEYRING_SERVICE, KEYRING_USER);
    (None, false)
}

#[cfg(target_os = "android")]
fn keychain_write(_key: &str) -> Result<(), String> {
    Err("no keychain on Android".into())
}

#[cfg(target_os = "android")]
fn keychain_delete() {}

fn current_key() -> (Option<String>, KeyStatus) {
    let (k, available) = keychain_read();
    ai::resolve_key(k, available)
}

fn err(e: AiError) -> String {
    e.to_string()
}

// ── Commands ──

#[tauri::command]
pub fn ai_get_status(state: State<'_, AppState>) -> Result<AiStatus, String> {
    let (_, ks) = current_key();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    ai::status(&db, ks).map_err(err)
}

#[tauri::command]
pub fn ai_save_settings(state: State<'_, AppState>, settings: AiSettings) -> Result<AiStatus, String> {
    if settings.provider == ProviderKind::Mock {
        return Err("The mock provider is for tests only.".into());
    }
    let (_, ks) = current_key();
    let db = state.db.lock().map_err(|e| e.to_string())?;
    ai::save_settings(&db, &settings).map_err(err)?;
    ai::status(&db, ks).map_err(err)
}

/// Store the OpenRouter key in the OS keychain. Returns only the status.
#[tauri::command]
pub fn ai_set_api_key(key: String) -> Result<KeyStatus, String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err("The key is empty.".into());
    }
    keychain_write(&key).map_err(|_| {
        format!(
            "No OS keychain is available on this system, so the key was not stored. \
             Set {} in the environment and restart MiNotes.",
            ai::OPENROUTER_KEY_ENV
        )
    })?;
    Ok(current_key().1)
}

#[tauri::command]
pub fn ai_clear_api_key() -> Result<KeyStatus, String> {
    keychain_delete();
    Ok(current_key().1)
}

#[derive(Serialize)]
pub struct ModelList {
    models: Vec<catalog::ModelInfo>,
    recommended: Option<String>,
    fetched_at: Option<String>,
    /// Set when a refresh failed and a cached copy (or nothing) is returned.
    error: Option<String>,
}

/// OpenRouter model catalogue (tool-capable models), cached for a day.
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>, refresh: Option<bool>) -> Result<ModelList, String> {
    let cached = {
        let db = state.db.lock().map_err(|e| e.to_string())?;
        ai::ensure_schema(&db).map_err(err)?;
        catalog::cached(&db)
    };
    let need = refresh.unwrap_or(false) || cached.as_ref().map(catalog::is_stale).unwrap_or(true);
    let mut error = None;
    let mut cat = cached;
    if need {
        let key = current_key().0;
        let fetched = tauri::async_runtime::spawn_blocking(move || {
            let client = match key {
                Some(k) => ai::provider::OpenAiCompatClient::openrouter(k),
                None => ai::provider::OpenAiCompatClient::openrouter(String::new()),
            };
            catalog::fetch(&client)
        })
        .await
        .map_err(|e| e.to_string())?;
        match fetched {
            Ok(models) => {
                let db = state.db.lock().map_err(|e| e.to_string())?;
                cat = Some(catalog::store(&db, models).map_err(err)?);
            }
            Err(e) => error = Some(e.to_string()),
        }
    }
    let models = cat.as_ref().map(|c| c.models.clone()).unwrap_or_default();
    Ok(ModelList {
        recommended: catalog::recommended(&models),
        fetched_at: cat.map(|c| c.fetched_at),
        models,
        error,
    })
}

#[derive(Clone, Serialize)]
struct EventPayload {
    conversation_id: String,
    #[serde(flatten)]
    event: StreamEvent,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StreamEvent {
    Progress { event: AiEvent },
    Done { result: RunOutput },
    Error { message: String, not_configured: bool },
}

/// Ask a question. Returns the conversation id immediately; progress, the
/// answer and errors arrive as `ai://event` events for that id.
#[tauri::command]
pub fn ai_ask(
    app: AppHandle,
    question: String,
    conversation_id: Option<String>,
    current_page_id: Option<String>,
) -> Result<String, String> {
    let conv_id = conversation_id
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    let current_page = current_page_id.and_then(|p| uuid::Uuid::parse_str(&p).ok());
    let cancel = Arc::new(AtomicBool::new(false));
    runtime().cancels.lock().unwrap().insert(conv_id.clone(), cancel.clone());
    // The open notebook's database (a legacy graph or a notebook folder).
    let path = {
        use tauri::Manager;
        let state = app.state::<super::AppState>();
        let s = state.session.lock().map_err(|e| e.to_string())?;
        s.notebook.db_path()
    };
    let id = conv_id.clone();
    std::thread::spawn(move || {
        let emit = |event: StreamEvent| {
            let _ = app.emit("ai://event", EventPayload { conversation_id: id.clone(), event });
        };
        let result = (|| -> Result<RunOutput, AiError> {
            let db = Database::open(&path).map_err(|e| AiError::Internal(e.to_string()))?;
            let settings = ai::load_settings(&db)?;
            let model = ai::resolve_model(&db, &settings, TaskClass::Interactive)?;
            let provider = ai::provider_for(&settings, current_key().0)?;
            let mut conv = runtime().conversations.lock().unwrap().get(&id).cloned().unwrap_or_default();
            let out = ai::run(
                &db,
                &settings,
                provider.as_ref(),
                &model,
                ai::Task::Ask { question: &question, current_page },
                &mut conv,
                &mut |e| emit(StreamEvent::Progress { event: e }),
                &|| cancel.load(Ordering::Relaxed),
            )?;
            runtime().conversations.lock().unwrap().insert(id.clone(), conv);
            Ok(out)
        })();
        match result {
            Ok(r) => emit(StreamEvent::Done { result: r }),
            Err(e) => emit(StreamEvent::Error {
                not_configured: matches!(e, AiError::NotConfigured(_)),
                message: e.to_string(),
            }),
        }
        runtime().cancels.lock().unwrap().remove(&id);
    });
    Ok(conv_id)
}

/// Stop a running question (takes effect before the next model call).
#[tauri::command]
pub fn ai_cancel(conversation_id: String) -> Result<(), String> {
    if let Some(c) = runtime().cancels.lock().unwrap().get(&conversation_id) {
        c.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub fn ai_reset_conversation(conversation_id: String) -> Result<(), String> {
    runtime().conversations.lock().unwrap().remove(&conversation_id);
    Ok(())
}

#[tauri::command]
pub fn ai_list_runs(state: State<'_, AppState>, limit: Option<i64>) -> Result<Vec<RunRecord>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    ai::list_runs(&db, limit.unwrap_or(20).clamp(1, 200)).map_err(err)
}
