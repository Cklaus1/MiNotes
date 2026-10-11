//! AI platform (PRD-ai-assistant.md §4).
//!
//! Every AI feature goes through [`run`], which enforces the provider choice,
//! the scope (only pages the user allowed), the monthly cost cap, the tool-loop
//! bounds, citation validation, and logs each run to `ai_runs` (metadata only;
//! content only when "keep transcripts" is on).
//!
//! Providers: OpenRouter (cloud) and local OpenAI-compatible servers share one
//! client ([`provider::OpenAiCompatClient`]); [`mock::MockProvider`] is the
//! deterministic test double. API keys never enter this module's storage:
//! callers pass them in (the desktop shell keeps them in the OS keychain).

pub mod ask;
pub mod catalog;
pub mod mock;
pub mod provider;
pub mod scope;
pub mod settings;
pub mod tools;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use chrono::{Datelike, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::Database;
use ask::{Citation, NOT_FOUND_MESSAGE};
use catalog::ModelInfo;
use provider::{ChatProvider, ChatRequest, Usage};
use settings::{AiSettings, ProviderKind, ScopeKind, TaskClass};

pub use settings::{load_settings, save_settings};

/// Env var read as a fallback when no OS keychain is available.
pub const OPENROUTER_KEY_ENV: &str = "OPENROUTER_API_KEY";

#[derive(Debug, Clone, PartialEq)]
pub enum AiError {
    /// AI is off or incomplete (no key / no model). Message says what to do.
    NotConfigured(String),
    /// This month's spend already reached the cap.
    CostCap { spent: f64, cap: f64 },
    /// HTTP error from the provider, already phrased for the user.
    Http { status: u16, message: String },
    /// Transport / stream / protocol problem, phrased for the user.
    Provider(String),
    /// The local server rejected `tools` (triggers retrieval fallback).
    ToolsUnsupported,
    Cancelled,
    InvalidInput(String),
    Internal(String),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::NotConfigured(m) | AiError::Provider(m) | AiError::InvalidInput(m) => f.write_str(m),
            AiError::Http { message, .. } => f.write_str(message),
            AiError::CostCap { spent, cap } => write!(
                f,
                "This month's AI spending cap is reached (${spent:.2} of ${cap:.2}). Raise the cap in AI settings to continue."
            ),
            AiError::ToolsUnsupported => f.write_str("The model doesn't support tool calling."),
            AiError::Cancelled => f.write_str("Stopped."),
            AiError::Internal(m) => write!(f, "Internal error: {m}"),
        }
    }
}

impl std::error::Error for AiError {}

impl From<rusqlite::Error> for AiError {
    fn from(e: rusqlite::Error) -> Self {
        AiError::Internal(e.to_string())
    }
}
impl From<crate::error::Error> for AiError {
    fn from(e: crate::error::Error) -> Self {
        AiError::Internal(e.to_string())
    }
}

/// Create the AI tables (idempotent; safe on every open).
pub fn ensure_schema(db: &Database) -> Result<(), AiError> {
    db.conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_settings (
             key   TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS ai_runs (
             id            TEXT PRIMARY KEY,
             task          TEXT NOT NULL,
             scope         TEXT NOT NULL,
             provider      TEXT NOT NULL,
             model         TEXT NOT NULL,
             input_tokens  INTEGER NOT NULL DEFAULT 0,
             output_tokens INTEGER NOT NULL DEFAULT 0,
             cached_tokens INTEGER NOT NULL DEFAULT 0,
             tool_calls    INTEGER NOT NULL DEFAULT 0,
             cost_usd      REAL NOT NULL DEFAULT 0,
             started_at    TEXT NOT NULL,
             finished_at   TEXT,
             outcome       TEXT NOT NULL DEFAULT 'running',
             error         TEXT,
             transcript    TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_ai_runs_started ON ai_runs(started_at);",
    )?;
    Ok(())
}

// ── Key / status (what the frontend may see) ──

/// Where the API key comes from. The key itself is never part of this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyStatus {
    pub configured: bool,
    /// "keychain" | "env" | "none"
    pub source: String,
    pub keychain_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AiStatus {
    pub settings: AiSettings,
    pub key: KeyStatus,
    /// Ready to run (provider on, key/endpoint and model known).
    pub configured: bool,
    /// Why not configured, phrased for the user.
    pub problem: Option<String>,
    pub spend_this_month_usd: f64,
    pub data_notice: String,
    pub effective_model: Option<String>,
    pub recommended_model: Option<String>,
    pub scope_label: String,
    pub catalog_fetched_at: Option<String>,
}

/// Pick the OpenRouter key: the keychain entry, else `OPENROUTER_API_KEY`.
/// Returns the key (for the provider only) and a status that is safe to show.
pub fn resolve_key(keychain_key: Option<String>, keychain_available: bool) -> (Option<String>, KeyStatus) {
    let from_keychain = keychain_key.filter(|k| !k.trim().is_empty());
    let (key, source) = match from_keychain {
        Some(k) => (Some(k), "keychain"),
        None => match std::env::var(OPENROUTER_KEY_ENV).ok().filter(|k| !k.trim().is_empty()) {
            Some(k) => (Some(k), "env"),
            None => (None, "none"),
        },
    };
    let status = KeyStatus { configured: key.is_some(), source: source.into(), keychain_available };
    (key, status)
}

#[derive(Debug, Clone)]
pub struct ModelChoice {
    pub id: String,
    pub pricing: Option<ModelInfo>,
}

/// Which model a task class uses: the user's pick, else the recommended model
/// from the cached catalogue.
pub fn resolve_model(db: &Database, s: &AiSettings, class: TaskClass) -> Result<ModelChoice, AiError> {
    match s.provider {
        ProviderKind::Off => Err(AiError::NotConfigured("AI is off. Turn it on in AI settings.".into())),
        ProviderKind::Local => {
            let m = s.local.model.trim();
            if m.is_empty() {
                return Err(AiError::NotConfigured("Choose the local model name in AI settings.".into()));
            }
            Ok(ModelChoice { id: m.to_string(), pricing: None })
        }
        ProviderKind::Openrouter | ProviderKind::Mock => {
            let cat = catalog::cached(db);
            let models = cat.as_ref().map(|c| c.models.as_slice()).unwrap_or_default();
            let id = s
                .models
                .get(class)
                .map(String::from)
                .or_else(|| catalog::recommended(models))
                .ok_or_else(|| AiError::NotConfigured("Choose a model in AI settings.".into()))?;
            let pricing = catalog::find(models, &id).cloned();
            Ok(ModelChoice { id, pricing })
        }
    }
}

fn scope_phrase(db: &Database, s: &AiSettings) -> String {
    match s.scope.kind {
        ScopeKind::Notebook => "this notebook".into(),
        ScopeKind::Page => "the page you have open".into(),
        ScopeKind::Folders => {
            let names = scope::folder_names(db, &s.scope.folder_ids);
            if names.is_empty() { "the selected folders".into() } else { names.join(", ") }
        }
    }
}

pub fn status(db: &Database, key: KeyStatus) -> Result<AiStatus, AiError> {
    let settings = load_settings(db)?;
    let spend = month_spend(db)?;
    let cat = catalog::cached(db);
    let recommended = cat.as_ref().and_then(|c| catalog::recommended(&c.models));
    let model = resolve_model(db, &settings, TaskClass::Interactive).ok();
    let scope_label = scope_phrase(db, &settings);
    let problem = match settings.provider {
        ProviderKind::Off => Some("AI is off.".to_string()),
        ProviderKind::Openrouter if !key.configured => Some(if key.keychain_available {
            "Add your OpenRouter API key.".to_string()
        } else {
            format!("No OS keychain is available here. Set {OPENROUTER_KEY_ENV} in the environment and restart MiNotes.")
        }),
        _ if model.is_none() => Some("Choose a model.".to_string()),
        _ => None,
    };
    let data_notice = match settings.provider {
        ProviderKind::Off => "AI is off: no note content leaves this device.".to_string(),
        ProviderKind::Local => format!(
            "Your notes in {scope_label} are sent only to the local model server at {} when you use AI features.",
            settings.local.base_url
        ),
        _ => {
            let who = model
                .as_ref()
                .map(|m| catalog::provider_name_for(&m.id))
                .unwrap_or_else(|| "the model's provider".into());
            format!("Your notes in {scope_label} are sent to OpenRouter and {who} when you use AI features.")
        }
    };
    Ok(AiStatus {
        configured: problem.is_none(),
        problem,
        settings,
        key,
        spend_this_month_usd: spend,
        data_notice,
        effective_model: model.map(|m| m.id),
        recommended_model: recommended,
        scope_label,
        catalog_fetched_at: cat.map(|c| c.fetched_at),
    })
}

// ── Run log ──

fn month_start() -> String {
    let now = Utc::now();
    Utc.with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0).unwrap().to_rfc3339()
}

/// USD spent on AI runs since the start of this calendar month (UTC).
pub fn month_spend(db: &Database) -> Result<f64, AiError> {
    ensure_schema(db)?;
    Ok(db.conn.query_row(
        "SELECT COALESCE(SUM(cost_usd), 0) FROM ai_runs WHERE started_at >= ?1",
        [month_start()],
        |r| r.get(0),
    )?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunRecord {
    pub id: String,
    pub task: String,
    pub scope: String,
    pub provider: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub tool_calls: i64,
    pub cost_usd: f64,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub outcome: String,
    pub error: Option<String>,
    pub has_transcript: bool,
}

pub fn list_runs(db: &Database, limit: i64) -> Result<Vec<RunRecord>, AiError> {
    ensure_schema(db)?;
    let mut stmt = db.conn.prepare(
        "SELECT id, task, scope, provider, model, input_tokens, output_tokens, cached_tokens, tool_calls,
                cost_usd, started_at, finished_at, outcome, error, transcript IS NOT NULL
         FROM ai_runs ORDER BY started_at DESC LIMIT ?1",
    )?;
    let rows = stmt.query_map([limit], |r| {
        Ok(RunRecord {
            id: r.get(0)?,
            task: r.get(1)?,
            scope: r.get(2)?,
            provider: r.get(3)?,
            model: r.get(4)?,
            input_tokens: r.get(5)?,
            output_tokens: r.get(6)?,
            cached_tokens: r.get(7)?,
            tool_calls: r.get(8)?,
            cost_usd: r.get(9)?,
            started_at: r.get(10)?,
            finished_at: r.get(11)?,
            outcome: r.get(12)?,
            error: r.get(13)?,
            has_transcript: r.get(14)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

// ── Running a task ──

/// A conversation (Ask follow-ups). Kept by the caller between runs.
#[derive(Debug, Clone, Default)]
pub struct Conversation {
    /// OpenAI-format messages after the system prompt.
    pub messages: Vec<Value>,
    /// Block ids returned by tools in this conversation (citation whitelist).
    pub seen: HashSet<Uuid>,
    /// Scope the conversation was built under. If the scope setting changes,
    /// the history (which may hold notes from the old scope) is dropped.
    pub scope_key: Option<String>,
}

pub enum Task<'a> {
    Ask { question: &'a str, current_page: Option<Uuid> },
}

impl Task<'_> {
    fn name(&self) -> &'static str {
        match self {
            Task::Ask { .. } => "ask",
        }
    }
}

/// Progress events streamed to the caller.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    Started { run_id: String, model: String },
    /// A new model call begins; text deltas that follow belong to it.
    Turn { n: u32 },
    Delta { text: String },
    /// A tool is being run (no note content, just what is happening).
    Status { text: String },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RunOutput {
    pub run_id: String,
    /// Validated answer; contains only `[[cite:<id>]]` markers that are valid.
    pub answer: String,
    pub citations: Vec<Citation>,
    pub stripped_citations: usize,
    /// ok | not_found | refused | max_tokens | max_iterations | token_budget | cost_cap
    pub outcome: String,
    /// User-facing note about the outcome (refusal, truncation, limits…).
    pub notice: Option<String>,
    pub model: String,
    pub usage: Usage,
    pub cost_usd: f64,
    pub iterations: u32,
    pub tool_calls: u32,
    pub spend_this_month_usd: f64,
    pub cap_usd: f64,
}

struct RunLog<'a> {
    db: &'a Database,
    id: String,
}

impl<'a> RunLog<'a> {
    fn start(db: &'a Database, task: &str, scope: &str, provider: &str, model: &str) -> Result<Self, AiError> {
        let id = Uuid::now_v7().to_string();
        db.conn.execute(
            "INSERT INTO ai_runs(id, task, scope, provider, model, started_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, task, scope, provider, model, Utc::now().to_rfc3339()],
        )?;
        Ok(Self { db, id })
    }
    fn finish(&self, usage: &Usage, cost: f64, tool_calls: u32, outcome: &str, error: Option<&str>, transcript: Option<String>) {
        let _ = self.db.conn.execute(
            "UPDATE ai_runs SET input_tokens = ?2, output_tokens = ?3, cached_tokens = ?4, tool_calls = ?5,
                    cost_usd = ?6, finished_at = ?7, outcome = ?8, error = ?9, transcript = ?10
             WHERE id = ?1",
            rusqlite::params![
                self.id,
                usage.prompt_tokens as i64,
                usage.completion_tokens as i64,
                usage.cached_tokens as i64,
                tool_calls as i64,
                cost,
                Utc::now().to_rfc3339(),
                outcome,
                error,
                transcript
            ],
        );
    }
}

fn call_cost(model: &ModelChoice, u: &Usage) -> f64 {
    u.cost.unwrap_or_else(|| {
        model
            .pricing
            .as_ref()
            .map(|p| p.cost(u.prompt_tokens, u.completion_tokens, u.cached_tokens))
            .unwrap_or(0.0)
    })
}

/// The single entry point for AI work. See the module docs for what it enforces.
///
/// `conv` is updated only when the run produces an answer, so a failed run
/// leaves the conversation as it was.
#[allow(clippy::too_many_arguments)]
pub fn run(
    db: &Database,
    settings: &AiSettings,
    provider: &dyn ChatProvider,
    model: &ModelChoice,
    task: Task<'_>,
    conv: &mut Conversation,
    sink: &mut dyn FnMut(AiEvent),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<RunOutput, AiError> {
    ensure_schema(db)?;
    // Provider choice: AI is off until configured, and only the configured
    // provider may run.
    if settings.provider == ProviderKind::Off {
        return Err(AiError::NotConfigured("AI is off. Turn it on in AI settings.".into()));
    }
    if provider.kind() != settings.provider {
        return Err(AiError::Internal(format!(
            "provider mismatch: configured {}, got {}",
            settings.provider.as_str(),
            provider.kind().as_str()
        )));
    }
    let Task::Ask { question, current_page } = &task;
    let question = question.trim();
    if question.is_empty() {
        return Err(AiError::InvalidInput("Type a question first.".into()));
    }
    let scope = scope::resolve(db, &settings.scope, *current_page)?;
    let paid = settings.provider != ProviderKind::Local;
    let cap = settings.monthly_cap_usd;
    let spent_before = month_spend(db)?;
    if paid && spent_before >= cap {
        let log = RunLog::start(db, task.name(), &scope.log_desc, provider.kind().as_str(), &model.id)?;
        log.finish(&Usage::default(), 0.0, 0, "blocked_cost_cap", None, None);
        return Err(AiError::CostCap { spent: spent_before, cap });
    }

    let log = RunLog::start(db, task.name(), &scope.log_desc, provider.kind().as_str(), &model.id)?;
    sink(AiEvent::Started { run_id: log.id.clone(), model: model.id.clone() });

    let scope_key = serde_json::to_string(&settings.scope).unwrap_or_default();
    if conv.scope_key.as_deref() != Some(scope_key.as_str()) {
        *conv = Conversation { scope_key: Some(scope_key), ..Default::default() };
    }
    let mut tools = tools::NoteTools::new(db, &scope);
    tools.seen = conv.seen.clone();
    let mut messages = conv.messages.clone();
    let new_from = messages.len();
    let today = Utc::now().format("%Y-%m-%d (%A)").to_string();
    let use_tools = !(settings.provider == ProviderKind::Local && !settings.local.supports_tools);

    let mut usage = Usage::default();
    let mut cost = 0.0;
    let mut tool_calls = 0u32;
    let mut iterations = 0u32;

    let finish_err = |e: AiError, usage: &Usage, cost: f64, tool_calls: u32| -> AiError {
        let outcome = if e == AiError::Cancelled { "cancelled" } else { "error" };
        log.finish(usage, cost, tool_calls, outcome, Some(&e.to_string()), None);
        e
    };

    let first_turn = !messages.iter().any(|m| m["role"] == "user");
    messages.push(json!({"role": "user", "content": ask::user_turn(question, &scope, &today, first_turn)}));

    let max_iter = settings.max_tool_iterations.max(1);
    let mut final_resp = None;
    let mut stop_outcome: Option<(&str, String)> = None;
    let mut retrieval_mode = !use_tools;

    loop {
        if is_cancelled() {
            return Err(finish_err(AiError::Cancelled, &usage, cost, tool_calls));
        }
        if retrieval_mode {
            // Retrieval-then-answer: search for the model, paste results as data.
            let results = tools.search(question, 15).map_err(AiError::Internal);
            let results = match results {
                Ok(r) => r,
                Err(e) => return Err(finish_err(e, &usage, cost, tool_calls)),
            };
            messages.truncate(new_from);
            messages.push(json!({"role": "user",
                "content": ask::retrieval_turn(question, &scope, &today, &results.to_string())}));
        }
        iterations += 1;
        sink(AiEvent::Turn { n: iterations });
        let last_call = iterations >= max_iter;
        let req = ChatRequest {
            model: model.id.clone(),
            messages: std::iter::once(json!({"role": "system", "content": ask::SYSTEM_PROMPT}))
                .chain(messages.iter().cloned())
                .collect(),
            tools: if retrieval_mode { vec![] } else { tools::definitions() },
            // On the last allowed call, ask for an answer instead of more tools.
            tool_choice: if last_call { "none" } else { "auto" },
            max_tokens: settings.max_output_tokens,
            reasoning_effort: settings.reasoning_effort.clone(),
        };
        let result = {
            let mut on_text = |t: &str| sink(AiEvent::Delta { text: t.to_string() });
            provider.chat(&req, &mut on_text)
        };
        let resp = match result {
            Ok(r) => r,
            Err(AiError::ToolsUnsupported) if !retrieval_mode => {
                retrieval_mode = true;
                iterations -= 1;
                continue;
            }
            Err(e) => return Err(finish_err(e, &usage, cost, tool_calls)),
        };
        usage.add(&resp.usage);
        cost += call_cost(model, &resp.usage);

        if resp.is_refusal() {
            stop_outcome = Some((
                "refused",
                "The model declined to answer this. Try rephrasing the question, or choose a different model in AI settings.".into(),
            ));
            break;
        }
        if resp.finish_reason.as_deref() == Some("error") {
            return Err(finish_err(
                AiError::Provider("The model provider reported an error while answering. Try again.".into()),
                &usage,
                cost,
                tool_calls,
            ));
        }
        if resp.tool_calls.is_empty() || retrieval_mode {
            final_resp = Some(resp);
            break;
        }
        // Tool loop bounds.
        if last_call {
            stop_outcome = Some(("max_iterations", format!(
                "Stopped after {max_iter} steps without an answer. Try a more specific question."
            )));
            break;
        }
        if usage.total() >= settings.run_token_budget {
            stop_outcome = Some(("token_budget", "Stopped: this question used up the per-question token budget.".into()));
            break;
        }
        if paid && spent_before + cost >= cap {
            stop_outcome = Some(("cost_cap", format!(
                "Stopped: this month's AI spending cap (${cap:.2}) was reached."
            )));
            break;
        }
        messages.push(resp.assistant_message());
        for call in &resp.tool_calls {
            tool_calls += 1;
            // Parse arguments with a JSON parser; never string-match.
            let parsed: Result<Value, String> = if call.arguments.trim().is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_str(&call.arguments).map_err(|e| format!("Invalid JSON arguments: {e}"))
            };
            sink(AiEvent::Status { text: status_text(&call.name, parsed.as_ref().ok()) });
            let result = parsed.and_then(|args| tools.execute(&call.name, &args));
            let content = match result {
                Ok(v) => json!({"untrusted_note_content": true, "result": v}).to_string(),
                Err(e) => json!({"error": e}).to_string(),
            };
            messages.push(json!({"role": "tool", "tool_call_id": call.id, "content": content}));
        }
    }

    let (answer, citations, stripped, outcome, notice, assistant_text) = match (&final_resp, stop_outcome) {
        (_, Some((outcome, msg))) => (String::new(), vec![], 0, outcome.to_string(), Some(msg), None),
        (Some(resp), None) => {
            let v = ask::validate_citations(&resp.content, &tools.seen, db, &scope);
            let (outcome, notice) = if resp.finish_reason.as_deref() == Some("length") {
                ("max_tokens".to_string(), Some("The answer was cut off at the length limit.".to_string()))
            } else if v.replaced {
                ("not_found".to_string(), None)
            } else {
                ("ok".to_string(), None)
            };
            (v.answer, v.citations, v.stripped, outcome, notice, Some(resp.content.clone()))
        }
        (None, None) => unreachable!("loop exits with a response or an outcome"),
    };

    // Commit to the conversation only when there is an answer to continue from.
    if let Some(text) = assistant_text {
        let mut msg = final_resp.as_ref().map(|r| r.assistant_message()).unwrap_or_default();
        msg["content"] = json!(text);
        messages.push(msg);
        conv.messages = messages.clone();
        conv.seen = tools.seen.clone();
    }

    let transcript = settings.keep_transcripts.then(|| {
        json!({"question": question, "messages": &messages[new_from.min(messages.len())..], "answer": answer}).to_string()
    });
    log.finish(&usage, cost, tool_calls, &outcome, None, transcript);
    Ok(RunOutput {
        run_id: log.id.clone(),
        answer: if answer.is_empty() && notice.is_none() { NOT_FOUND_MESSAGE.into() } else { answer },
        citations,
        stripped_citations: stripped,
        outcome,
        notice,
        model: final_resp.and_then(|r| r.model).unwrap_or_else(|| model.id.clone()),
        usage,
        cost_usd: cost,
        iterations,
        tool_calls,
        spend_this_month_usd: spent_before + cost,
        cap_usd: cap,
    })
}

fn status_text(tool: &str, args: Option<&Value>) -> String {
    let arg = |k: &str| args.and_then(|a| a[k].as_str()).map(|s| s.chars().take(60).collect::<String>());
    match tool {
        "search" => format!("Searching notes for “{}”", arg("query").unwrap_or_default()),
        "get_page" => format!("Reading “{}”", arg("title_or_id").unwrap_or_default()),
        "get_blocks" => "Reading blocks".into(),
        "backlinks" => format!("Finding links to “{}”", arg("page").unwrap_or_default()),
        "list_pages" => "Listing pages".into(),
        "recent" => "Looking at recent edits".into(),
        "todos" => "Collecting open TODOs".into(),
        other => format!("Running {other}"),
    }
}

/// Build the configured provider. `api_key` is only needed for OpenRouter.
pub fn provider_for(settings: &AiSettings, api_key: Option<String>) -> Result<Box<dyn ChatProvider + Send>, AiError> {
    match settings.provider {
        ProviderKind::Off => Err(AiError::NotConfigured("AI is off. Turn it on in AI settings.".into())),
        ProviderKind::Openrouter => {
            let key = api_key.filter(|k| !k.trim().is_empty()).ok_or_else(|| {
                AiError::NotConfigured("Add your OpenRouter API key in AI settings.".into())
            })?;
            Ok(Box::new(provider::OpenAiCompatClient::openrouter(key)))
        }
        ProviderKind::Local => Ok(Box::new(provider::OpenAiCompatClient::local(&settings.local.base_url))),
        ProviderKind::Mock => Err(AiError::NotConfigured("The mock provider is for tests only.".into())),
    }
}
