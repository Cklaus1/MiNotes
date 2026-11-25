//! OpenRouter model catalogue: fetched from `GET /models`, filtered to models
//! that support tool calling, cached in `ai_settings`. Model ids are never
//! hardcoded; the recommended default is the newest `anthropic/claude-opus*`.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::provider::OpenAiCompatClient;
use super::settings::{get_value, set_value};
use super::AiError;
use crate::db::Database;

const CATALOG_KEY: &str = "openrouter_catalog";
/// Refetch the catalogue when the cached copy is older than this.
const MAX_AGE_HOURS: i64 = 24;
pub const RECOMMENDED_PREFIX: &str = "anthropic/claude-opus";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    /// Unix seconds the model was added to OpenRouter (newest = highest).
    pub created: i64,
    pub context_length: Option<u64>,
    /// USD per token.
    pub prompt_price: f64,
    pub completion_price: f64,
    pub cache_read_price: Option<f64>,
}

impl ModelInfo {
    /// Provider display name from the id prefix (`anthropic/…` → "Anthropic").
    pub fn provider_name(&self) -> String {
        provider_name_for(&self.id)
    }
    /// Cost of a call in USD from catalogue prices.
    pub fn cost(&self, prompt: u64, completion: u64, cached: u64) -> f64 {
        let cached = cached.min(prompt);
        let cache_price = self.cache_read_price.unwrap_or(self.prompt_price);
        (prompt - cached) as f64 * self.prompt_price
            + cached as f64 * cache_price
            + completion as f64 * self.completion_price
    }
}

pub fn provider_name_for(model_id: &str) -> String {
    let prefix = model_id.split('/').next().unwrap_or("");
    match prefix {
        "anthropic" => "Anthropic".into(),
        "openai" => "OpenAI".into(),
        "google" => "Google".into(),
        "meta-llama" => "Meta".into(),
        "mistralai" => "Mistral AI".into(),
        "x-ai" => "xAI".into(),
        "deepseek" => "DeepSeek".into(),
        "qwen" => "Alibaba (Qwen)".into(),
        "cohere" => "Cohere".into(),
        "amazon" => "Amazon".into(),
        "microsoft" => "Microsoft".into(),
        "" => "the model's provider".into(),
        other => {
            let mut c = other.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalog {
    pub fetched_at: String,
    pub models: Vec<ModelInfo>,
}

fn price(v: &Value) -> Option<f64> {
    match v {
        Value::String(s) => s.parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Parse the `/models` response, keeping models that support tool calling and
/// have known non-negative prices. Sorted newest first.
pub fn parse_catalog(json: &Value) -> Vec<ModelInfo> {
    let mut out: Vec<ModelInfo> = json["data"]
        .as_array()
        .map(|a| a.as_slice())
        .unwrap_or_default()
        .iter()
        .filter(|m| {
            m["supported_parameters"]
                .as_array()
                .map(|p| p.iter().any(|x| x == "tools"))
                .unwrap_or(false)
        })
        .filter_map(|m| {
            let prompt = price(&m["pricing"]["prompt"])?;
            let completion = price(&m["pricing"]["completion"])?;
            if prompt < 0.0 || completion < 0.0 {
                return None; // variable-price routers
            }
            Some(ModelInfo {
                id: m["id"].as_str()?.to_string(),
                name: m["name"].as_str().unwrap_or_else(|| m["id"].as_str().unwrap_or("")).to_string(),
                created: m["created"].as_i64().unwrap_or(0),
                context_length: m["context_length"].as_u64(),
                prompt_price: prompt,
                completion_price: completion,
                cache_read_price: price(&m["pricing"]["input_cache_read"]).filter(|p| *p >= 0.0),
            })
        })
        .collect();
    out.sort_by(|a, b| b.created.cmp(&a.created).then(a.id.cmp(&b.id)));
    out
}

/// Newest Claude Opus in the list (by `created`), the preselected default.
pub fn recommended(models: &[ModelInfo]) -> Option<String> {
    models
        .iter()
        .filter(|m| m.id.starts_with(RECOMMENDED_PREFIX))
        .max_by(|a, b| a.created.cmp(&b.created).then(a.id.cmp(&b.id)))
        .map(|m| m.id.clone())
}

pub fn cached(db: &Database) -> Option<Catalog> {
    get_value(db, CATALOG_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok())
}

pub fn store(db: &Database, models: Vec<ModelInfo>) -> Result<Catalog, AiError> {
    let c = Catalog { fetched_at: Utc::now().to_rfc3339(), models };
    set_value(db, CATALOG_KEY, &serde_json::to_string(&c).map_err(|e| AiError::Internal(e.to_string()))?)?;
    Ok(c)
}

pub fn is_stale(c: &Catalog) -> bool {
    chrono::DateTime::parse_from_rfc3339(&c.fetched_at)
        .map(|t| Utc::now().signed_duration_since(t).num_hours() >= MAX_AGE_HOURS)
        .unwrap_or(true)
}

/// Fetch the catalogue over HTTP (no DB access, so it can run off the UI thread).
pub fn fetch(client: &OpenAiCompatClient) -> Result<Vec<ModelInfo>, AiError> {
    let json = client.get_json("/models")?;
    let models = parse_catalog(&json);
    if models.is_empty() {
        return Err(AiError::Provider("OpenRouter returned no models that support tool calling.".into()));
    }
    Ok(models)
}

pub fn find<'a>(models: &'a [ModelInfo], id: &str) -> Option<&'a ModelInfo> {
    models.iter().find(|m| m.id == id)
}
