//! AI settings, stored per notebook (in its database) in the `ai_settings` table.
//!
//! API keys are NOT part of these settings and never touch the database: the
//! desktop shell keeps the OpenRouter key in the OS keychain (or reads
//! `OPENROUTER_API_KEY`) and hands it to the provider directly.

use serde::{Deserialize, Serialize};

use super::AiError;
use crate::db::Database;

/// Which provider answers AI requests. `Off` is the default: nothing is sent
/// anywhere until the user configures a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    Off,
    /// OpenRouter (cloud): one key, many models.
    Openrouter,
    /// Any OpenAI-compatible server on this machine (Ollama, LM Studio, llama.cpp).
    Local,
    /// Deterministic scripted provider (tests only; never offered in the UI).
    Mock,
}

impl ProviderKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderKind::Off => "off",
            ProviderKind::Openrouter => "openrouter",
            ProviderKind::Local => "local",
            ProviderKind::Mock => "mock",
        }
    }
}

/// Task classes that can use different models (the user decides the trade-off).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskClass {
    /// Ask your notes, palette search, editor help.
    Interactive,
    /// Organise / bulk tagging (later phases).
    Bulk,
    /// Multi-step agent actions (later phases).
    Agent,
}

impl TaskClass {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskClass::Interactive => "interactive",
            TaskClass::Bulk => "bulk",
            TaskClass::Agent => "agent",
        }
    }
}

/// OpenRouter model id per task class. `None` = use the recommended model from
/// the cached catalogue (newest `anthropic/claude-opus*`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskModels {
    pub interactive: Option<String>,
    pub bulk: Option<String>,
    pub agent: Option<String>,
}

impl TaskModels {
    pub fn get(&self, class: TaskClass) -> Option<&str> {
        match class {
            TaskClass::Interactive => self.interactive.as_deref(),
            TaskClass::Bulk => self.bulk.as_deref(),
            TaskClass::Agent => self.agent.as_deref(),
        }
        .filter(|s| !s.trim().is_empty())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ScopeKind {
    /// Every visible page in this notebook.
    #[default]
    Notebook,
    /// Only pages inside the chosen folders (and their sub-folders).
    Folders,
    /// Only the page that is open when the question is asked.
    Page,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScopeSetting {
    pub kind: ScopeKind,
    /// Folder ids for `ScopeKind::Folders`.
    pub folder_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalSettings {
    /// OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` (Ollama).
    pub base_url: String,
    pub model: String,
    /// Whether the local model handles tool calling. When false (or when the
    /// server rejects `tools`), Ask falls back to retrieval-then-answer.
    pub supports_tools: bool,
}

impl Default for LocalSettings {
    fn default() -> Self {
        Self {
            base_url: "http://localhost:11434/v1".into(),
            model: String::new(),
            supports_tools: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiSettings {
    pub provider: ProviderKind,
    pub models: TaskModels,
    pub scope: ScopeSetting,
    /// Monthly spend cap in USD. 0 = no AI spend allowed (runs refuse to start).
    pub monthly_cap_usd: f64,
    /// Store question/answer/tool transcripts in `ai_runs.transcript`.
    pub keep_transcripts: bool,
    pub local: LocalSettings,
    /// OpenRouter's unified `reasoning.effort` ("low" | "medium" | "high"),
    /// or None to leave the model default.
    pub reasoning_effort: Option<String>,
    /// Max model calls per run (tool loop bound).
    pub max_tool_iterations: u32,
    /// Max prompt+completion tokens per run, summed over all calls.
    pub run_token_budget: u64,
    /// Max output tokens per call.
    pub max_output_tokens: u32,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: ProviderKind::Off,
            models: TaskModels::default(),
            scope: ScopeSetting::default(),
            monthly_cap_usd: 10.0,
            keep_transcripts: false,
            local: LocalSettings::default(),
            reasoning_effort: Some("medium".into()),
            max_tool_iterations: 8,
            run_token_budget: 300_000,
            max_output_tokens: 16_000,
        }
    }
}

impl AiSettings {
    /// Validate user-editable values (called before saving).
    pub fn validate(&self) -> Result<(), AiError> {
        if !(self.monthly_cap_usd.is_finite() && self.monthly_cap_usd >= 0.0) {
            return Err(AiError::InvalidInput("Monthly cap must be a number ≥ 0".into()));
        }
        if self.max_tool_iterations == 0 || self.max_tool_iterations > 32 {
            return Err(AiError::InvalidInput("Tool iterations must be between 1 and 32".into()));
        }
        if let Some(e) = &self.reasoning_effort {
            if !["low", "medium", "high"].contains(&e.as_str()) {
                return Err(AiError::InvalidInput(format!("Unknown reasoning effort: {e}")));
            }
        }
        if self.provider == ProviderKind::Local {
            let u = self.local.base_url.trim();
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err(AiError::InvalidInput("Local endpoint must start with http:// or https://".into()));
            }
        }
        if self.scope.kind == ScopeKind::Folders && self.scope.folder_ids.is_empty() {
            return Err(AiError::InvalidInput("Pick at least one folder for the AI scope".into()));
        }
        Ok(())
    }
}

pub(crate) const SETTINGS_KEY: &str = "settings";

pub fn load_settings(db: &Database) -> Result<AiSettings, AiError> {
    super::ensure_schema(db)?;
    match get_value(db, SETTINGS_KEY)? {
        Some(s) => Ok(serde_json::from_str(&s).unwrap_or_default()),
        None => Ok(AiSettings::default()),
    }
}

pub fn save_settings(db: &Database, settings: &AiSettings) -> Result<(), AiError> {
    settings.validate()?;
    super::ensure_schema(db)?;
    let json = serde_json::to_string(settings).map_err(|e| AiError::Internal(e.to_string()))?;
    set_value(db, SETTINGS_KEY, &json)
}

pub(crate) fn get_value(db: &Database, key: &str) -> Result<Option<String>, AiError> {
    use rusqlite::OptionalExtension;
    db.conn
        .query_row("SELECT value FROM ai_settings WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .map_err(AiError::from)
}

pub(crate) fn set_value(db: &Database, key: &str, value: &str) -> Result<(), AiError> {
    db.conn
        .execute(
            "INSERT INTO ai_settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map(|_| ())
        .map_err(AiError::from)
}
