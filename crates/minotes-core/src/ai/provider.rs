//! Provider layer: one OpenAI-compatible chat-completions client shared by
//! OpenRouter (cloud) and local servers (Ollama / LM Studio / llama.cpp), plus
//! the streaming (SSE) parser. Messages are kept as raw JSON so provider
//! extras (e.g. OpenRouter `reasoning_details`) round-trip unchanged.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::settings::ProviderKind;
use super::AiError;

pub const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
/// Dev/test-only override of the OpenRouter base URL (e.g. a local mock server).
/// Honoured only in debug builds: the OpenRouter key is sent to this URL, so a
/// release build must never let the environment redirect it.
pub const OPENROUTER_URL_ENV: &str = "MINOTES_AI_OPENROUTER_URL";
pub const APP_REFERER: &str = "https://github.com/Cklaus1/MiNotes";
pub const APP_TITLE: &str = "MiNotes";

pub fn openrouter_base_url() -> String {
    #[cfg(debug_assertions)]
    if let Some(u) = std::env::var(OPENROUTER_URL_ENV).ok().filter(|s| !s.trim().is_empty()) {
        return u.trim_end_matches('/').to_string();
    }
    OPENROUTER_BASE_URL.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Raw JSON string as produced by the model. Parse with a JSON parser.
    pub arguments: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    /// Prompt tokens served from the provider's prompt cache.
    pub cached_tokens: u64,
    /// Cost in USD as reported by the provider (OpenRouter `usage.cost`).
    pub cost: Option<f64>,
}

impl Usage {
    pub fn add(&mut self, o: &Usage) {
        self.prompt_tokens += o.prompt_tokens;
        self.completion_tokens += o.completion_tokens;
        self.cached_tokens += o.cached_tokens;
        self.cost = match (self.cost, o.cost) {
            (Some(a), Some(b)) => Some(a + b),
            (a, b) => a.or(b),
        };
    }
    pub fn total(&self) -> u64 {
        self.prompt_tokens + self.completion_tokens
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ChatResponse {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    /// Provider-native finish reason (OpenRouter), e.g. "refusal".
    pub native_finish_reason: Option<String>,
    pub usage: Usage,
    pub model: Option<String>,
    /// OpenRouter reasoning details; must be echoed back on the assistant
    /// message when continuing a tool loop.
    pub reasoning_details: Option<Value>,
}

impl ChatResponse {
    /// The assistant message to append to the conversation.
    pub fn assistant_message(&self) -> Value {
        let mut m = json!({"role": "assistant", "content": self.content});
        if !self.tool_calls.is_empty() {
            m["tool_calls"] = Value::Array(
                self.tool_calls
                    .iter()
                    .map(|c| json!({"id": c.id, "type": "function",
                                    "function": {"name": c.name, "arguments": c.arguments}}))
                    .collect(),
            );
        }
        if let Some(rd) = &self.reasoning_details {
            m["reasoning_details"] = rd.clone();
        }
        m
    }

    pub fn is_refusal(&self) -> bool {
        matches!(self.finish_reason.as_deref(), Some("content_filter"))
            || matches!(self.native_finish_reason.as_deref(), Some("refusal"))
    }
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model: String,
    /// OpenAI-format messages; the first is the stable system prompt.
    pub messages: Vec<Value>,
    pub tools: Vec<Value>,
    /// "auto" or "none" (forced tool choice is never sent).
    pub tool_choice: &'static str,
    pub max_tokens: u32,
    pub reasoning_effort: Option<String>,
}

/// Anything that can answer a chat request. `on_text` receives streamed text.
pub trait ChatProvider {
    fn kind(&self) -> ProviderKind;
    fn chat(&self, req: &ChatRequest, on_text: &mut dyn FnMut(&str)) -> Result<ChatResponse, AiError>;
}

/// OpenAI-compatible chat-completions client (OpenRouter or local).
pub struct OpenAiCompatClient {
    pub kind: ProviderKind,
    pub base_url: String,
    api_key: Option<String>,
    agent: ureq::Agent,
}

impl OpenAiCompatClient {
    pub fn openrouter(api_key: String) -> Self {
        Self::new(ProviderKind::Openrouter, openrouter_base_url(), Some(api_key))
    }
    pub fn local(base_url: &str) -> Self {
        Self::new(ProviderKind::Local, base_url.trim_end_matches('/').to_string(), None)
    }
    fn new(kind: ProviderKind, base_url: String, api_key: Option<String>) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(15)))
            // Long silences happen while a model thinks; OpenRouter sends keep-alive comments.
            .timeout_recv_body(Some(Duration::from_secs(600)))
            .build();
        let api_key = api_key.filter(|k| !k.trim().is_empty());
        Self { kind, base_url, api_key, agent: ureq::Agent::new_with_config(config) }
    }

    /// The JSON body actually sent (exposed for tests).
    pub fn request_body(&self, req: &ChatRequest) -> Value {
        let mut messages = req.messages.clone();
        // Prompt caching: on Anthropic models via OpenRouter, mark the stable
        // system prompt (which follows the tool list) as a cache breakpoint.
        if self.kind == ProviderKind::Openrouter && req.model.starts_with("anthropic/") {
            if let Some(first) = messages.first_mut() {
                if first["role"] == "system" {
                    if let Some(text) = first["content"].as_str().map(String::from) {
                        first["content"] = json!([{"type": "text", "text": text,
                                                   "cache_control": {"type": "ephemeral"}}]);
                    }
                }
            }
        }
        let mut body = json!({
            "model": req.model,
            "messages": messages,
            "stream": true,
            "max_tokens": req.max_tokens,
            "stream_options": {"include_usage": true},
        });
        if !req.tools.is_empty() {
            body["tools"] = Value::Array(req.tools.clone());
            body["tool_choice"] = json!(req.tool_choice);
        }
        if self.kind == ProviderKind::Openrouter {
            body["usage"] = json!({"include": true});
            if let Some(e) = &req.reasoning_effort {
                body["reasoning"] = json!({"effort": e});
            }
        }
        body
    }

    pub fn get_json(&self, path: &str) -> Result<Value, AiError> {
        let url = format!("{}{}", self.base_url, path);
        let mut r = self.agent.get(&url).header("X-Title", APP_TITLE).header("HTTP-Referer", APP_REFERER);
        if let Some(k) = &self.api_key {
            r = r.header("Authorization", &format!("Bearer {k}"));
        }
        let mut resp = r.call().map_err(|e| self.transport_error(e))?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| AiError::Provider(format!("Reading the response failed: {e}")))?;
        if status >= 400 {
            return Err(http_error(self.kind, status, &text));
        }
        serde_json::from_str(&text).map_err(|e| AiError::Provider(format!("Invalid JSON from provider: {e}")))
    }

    fn transport_error(&self, e: ureq::Error) -> AiError {
        AiError::Provider(match self.kind {
            ProviderKind::Local => format!(
                "Couldn't reach the local model server at {} ({e}). Is it running?",
                self.base_url
            ),
            _ => format!("Couldn't reach {} ({e}). Check your internet connection.", self.base_url),
        })
    }
}

impl ChatProvider for OpenAiCompatClient {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    fn chat(&self, req: &ChatRequest, on_text: &mut dyn FnMut(&str)) -> Result<ChatResponse, AiError> {
        let body = self.request_body(req);
        let url = format!("{}/chat/completions", self.base_url);
        let mut r = self
            .agent
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream");
        if self.kind == ProviderKind::Openrouter {
            r = r.header("HTTP-Referer", APP_REFERER).header("X-Title", APP_TITLE);
        }
        if let Some(k) = &self.api_key {
            r = r.header("Authorization", &format!("Bearer {k}"));
        }
        let mut resp = r.send(body.to_string()).map_err(|e| self.transport_error(e))?;
        let status = resp.status().as_u16();
        if status >= 400 {
            let text = resp.body_mut().read_to_string().unwrap_or_default();
            if self.kind == ProviderKind::Local && status == 400 && !req.tools.is_empty() && text.to_lowercase().contains("tool") {
                return Err(AiError::ToolsUnsupported);
            }
            return Err(http_error(self.kind, status, &text));
        }
        let reader = std::io::BufReader::new(resp.body_mut().as_reader());
        parse_sse_stream(reader, on_text)
    }
}

/// Map an HTTP error (status + body) to a clear, user-facing message.
pub fn http_error(kind: ProviderKind, status: u16, body: &str) -> AiError {
    let detail = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body.chars().take(300).collect());
    let who = if kind == ProviderKind::Local { "The local model server" } else { "OpenRouter" };
    let msg = match status {
        401 => format!("{who} rejected the API key (401). Check the key in AI settings."),
        402 => "Your OpenRouter account is out of credits (402). Add credits at openrouter.ai/credits or choose a cheaper model in AI settings.".to_string(),
        403 => format!("The request was blocked by the provider's moderation (403): {detail}"),
        404 => format!("{who} doesn't know that model or endpoint (404): {detail}"),
        408 => format!("{who} timed out (408). Try again."),
        429 => format!("{who} is rate limiting requests (429). Wait a moment and try again."),
        502 | 503 => format!("The model provider is unavailable right now ({status}). Try again, or pick another model in AI settings."),
        _ => format!("{who} returned an error ({status}): {detail}"),
    };
    AiError::Http { status, message: msg }
}

/// Parse an OpenAI-compatible SSE chat-completions stream.
///
/// Handles: `data:` JSON chunks, `: comment` keep-alives (OpenRouter sends
/// `: OPENROUTER PROCESSING`), `[DONE]`, content deltas, tool-call deltas
/// accumulated by index, `reasoning_details` deltas merged by index, a final
/// usage chunk, and mid-stream `{"error": …}` objects.
pub fn parse_sse_stream<R: BufRead>(reader: R, on_text: &mut dyn FnMut(&str)) -> Result<ChatResponse, AiError> {
    let mut out = ChatResponse::default();
    let mut calls: BTreeMap<u64, ToolCall> = BTreeMap::new();
    let mut reasoning: BTreeMap<u64, Value> = BTreeMap::new();
    let mut data = String::new();
    let mut saw_any = false;

    let mut handle = |payload: &str, out: &mut ChatResponse| -> Result<bool, AiError> {
        let payload = payload.trim();
        if payload.is_empty() {
            return Ok(false);
        }
        if payload == "[DONE]" {
            return Ok(true);
        }
        let chunk: Value = serde_json::from_str(payload)
            .map_err(|e| AiError::Provider(format!("Malformed stream chunk: {e}")))?;
        if let Some(err) = chunk.get("error").filter(|e| !e.is_null()) {
            let msg = err["message"].as_str().unwrap_or("unknown error");
            let code = err["code"].as_u64().map(|c| c as u16);
            return Err(match code {
                Some(c) if c >= 400 => http_error(ProviderKind::Openrouter, c, &json!({"error": {"message": msg}}).to_string()),
                _ => AiError::Provider(format!("The provider reported an error mid-answer: {msg}")),
            });
        }
        if let Some(m) = chunk["model"].as_str() {
            out.model = Some(m.to_string());
        }
        if let Some(choice) = chunk["choices"].get(0) {
            let delta = &choice["delta"];
            if let Some(t) = delta["content"].as_str() {
                if !t.is_empty() {
                    out.content.push_str(t);
                    on_text(t);
                }
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for (pos, tc) in tcs.iter().enumerate() {
                    let idx = tc["index"].as_u64().unwrap_or(pos as u64);
                    let e = calls.entry(idx).or_insert_with(|| ToolCall {
                        id: String::new(),
                        name: String::new(),
                        arguments: String::new(),
                    });
                    if let Some(id) = tc["id"].as_str() {
                        e.id = id.to_string();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        e.name.push_str(n);
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        e.arguments.push_str(a);
                    }
                }
            }
            if let Some(rds) = delta["reasoning_details"].as_array() {
                for (pos, rd) in rds.iter().enumerate() {
                    let idx = rd["index"].as_u64().unwrap_or(pos as u64);
                    merge_reasoning(reasoning.entry(idx).or_insert_with(|| json!({})), rd);
                }
            }
            if let Some(f) = choice["finish_reason"].as_str() {
                out.finish_reason = Some(f.to_string());
            }
            if let Some(f) = choice["native_finish_reason"].as_str() {
                out.native_finish_reason = Some(f.to_string());
            }
        }
        if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
            out.usage = Usage {
                prompt_tokens: u["prompt_tokens"].as_u64().unwrap_or(0),
                completion_tokens: u["completion_tokens"].as_u64().unwrap_or(0),
                cached_tokens: u["prompt_tokens_details"]["cached_tokens"].as_u64().unwrap_or(0),
                cost: u["cost"].as_f64(),
            };
        }
        Ok(false)
    };

    let mut done = false;
    for line in reader.lines() {
        let line = line.map_err(|e| AiError::Provider(format!("The answer stream was interrupted: {e}")))?;
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !data.is_empty() {
                saw_any = true;
                let d = std::mem::take(&mut data);
                if handle(&d, &mut out)? {
                    done = true;
                    break;
                }
            }
            continue;
        }
        if line.starts_with(':') {
            continue; // SSE comment / keep-alive
        }
        if let Some(rest) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
        }
        // `event:` / `id:` / `retry:` fields are not used by this API.
    }
    if !done && !data.is_empty() {
        saw_any = true;
        let d = std::mem::take(&mut data);
        handle(&d, &mut out)?;
    }
    if !saw_any {
        return Err(AiError::Provider("The provider returned an empty response.".into()));
    }
    out.tool_calls = calls.into_values().filter(|c| !c.name.is_empty()).collect();
    for (i, c) in out.tool_calls.iter_mut().enumerate() {
        if c.id.is_empty() {
            c.id = format!("call_{i}");
        }
    }
    if !reasoning.is_empty() {
        out.reasoning_details = Some(Value::Array(reasoning.into_values().collect()));
    }
    Ok(out)
}

/// Merge one streamed reasoning_details fragment: strings concatenate (text,
/// summary), everything else (type, signature, format, id) is overwritten.
fn merge_reasoning(acc: &mut Value, frag: &Value) {
    let (Some(acc), Some(frag)) = (acc.as_object_mut(), frag.as_object()) else { return };
    for (k, v) in frag {
        match (acc.get_mut(k), v) {
            (Some(Value::String(a)), Value::String(b)) if k == "text" || k == "summary" => a.push_str(b),
            _ => {
                acc.insert(k.clone(), v.clone());
            }
        }
    }
}
