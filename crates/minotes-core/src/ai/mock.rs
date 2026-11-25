//! Deterministic mock provider for tests: plays back scripted turns (text,
//! tool calls, refusals, …) and records every request it receives so tests can
//! assert exactly what would have been sent to a model.

use std::cell::RefCell;
use std::collections::VecDeque;

use serde_json::Value;

use super::provider::{ChatProvider, ChatRequest, ChatResponse, ToolCall, Usage};
use super::settings::ProviderKind;
use super::AiError;

pub type DynamicTurn = Box<dyn Fn(&ChatRequest) -> ChatResponse>;

pub enum MockTurn {
    /// Final answer text (streamed word by word).
    Text(String),
    /// Tool calls: (name, JSON arguments string).
    Tools(Vec<(String, String)>),
    /// `finish_reason: content_filter` / native `refusal`, with partial text.
    Refusal(String),
    /// `finish_reason: length` with the truncated text.
    Length(String),
    /// Provider error.
    Error(AiError),
    /// Computed from the request (e.g. cite a block a tool just returned).
    Dynamic(DynamicTurn),
}

pub struct MockProvider {
    turns: RefCell<VecDeque<MockTurn>>,
    /// Repeated forever once the script runs out (None = error).
    pub repeat_last: Option<Vec<(String, String)>>,
    pub usage_per_call: Usage,
    pub requests: RefCell<Vec<ChatRequest>>,
}

impl MockProvider {
    pub fn new(turns: Vec<MockTurn>) -> Self {
        Self {
            turns: RefCell::new(turns.into()),
            repeat_last: None,
            usage_per_call: Usage { prompt_tokens: 1000, completion_tokens: 100, cached_tokens: 0, cost: None },
            requests: RefCell::new(Vec::new()),
        }
    }

    /// A provider that requests the same tool calls forever.
    pub fn always_tools(calls: Vec<(String, String)>) -> Self {
        let mut p = Self::new(vec![]);
        p.repeat_last = Some(calls);
        p
    }

    /// All tool-result message contents the provider was shown, in order.
    pub fn tool_results(&self) -> Vec<String> {
        let reqs = self.requests.borrow();
        let Some(last) = reqs.last() else { return vec![] };
        last.messages
            .iter()
            .filter(|m| m["role"] == "tool")
            .map(|m| m["content"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    fn tool_response(calls: &[(String, String)], n: usize) -> ChatResponse {
        ChatResponse {
            tool_calls: calls
                .iter()
                .enumerate()
                .map(|(i, (name, args))| ToolCall { id: format!("call_{n}_{i}"), name: name.clone(), arguments: args.clone() })
                .collect(),
            finish_reason: Some("tool_calls".into()),
            ..Default::default()
        }
    }
}

/// Block ids that appear in tool results of a request (for dynamic turns).
pub fn block_ids_in_tool_results(req: &ChatRequest) -> Vec<String> {
    let mut ids = Vec::new();
    for m in &req.messages {
        let content = m["content"].as_str().unwrap_or("");
        let json = if m["role"] == "tool" {
            Some(content)
        } else if m["role"] == "user" {
            // Retrieval fallback: results pasted between <search_results> tags.
            content
                .split_once("<search_results>")
                .and_then(|(_, r)| r.split_once("</search_results>"))
                .map(|(j, _)| j)
        } else {
            None
        };
        if let Some(v) = json.and_then(|j| serde_json::from_str::<Value>(j.trim()).ok()) {
            collect_ids(&v, &mut ids);
        }
    }
    ids
}

fn collect_ids(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(o) => {
            if let Some(Value::String(id)) = o.get("block_id") {
                if !out.contains(id) && o.get("error").is_none() {
                    out.push(id.clone());
                }
            }
            o.values().for_each(|x| collect_ids(x, out));
        }
        Value::Array(a) => a.iter().for_each(|x| collect_ids(x, out)),
        _ => {}
    }
}

impl ChatProvider for MockProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Mock
    }

    fn chat(&self, req: &ChatRequest, on_text: &mut dyn FnMut(&str)) -> Result<ChatResponse, AiError> {
        self.requests.borrow_mut().push(req.clone());
        let n = self.requests.borrow().len();
        let turn = self.turns.borrow_mut().pop_front();
        let mut resp = match turn {
            Some(MockTurn::Text(t)) => ChatResponse { content: t, finish_reason: Some("stop".into()), ..Default::default() },
            Some(MockTurn::Tools(calls)) => Self::tool_response(&calls, n),
            Some(MockTurn::Refusal(t)) => ChatResponse {
                content: t,
                finish_reason: Some("content_filter".into()),
                native_finish_reason: Some("refusal".into()),
                ..Default::default()
            },
            Some(MockTurn::Length(t)) => ChatResponse { content: t, finish_reason: Some("length".into()), ..Default::default() },
            Some(MockTurn::Error(e)) => return Err(e),
            Some(MockTurn::Dynamic(f)) => f(req),
            None => match &self.repeat_last {
                Some(calls) => Self::tool_response(calls, n),
                None => return Err(AiError::Provider("mock script exhausted".into())),
            },
        };
        for w in resp.content.split_inclusive(' ') {
            on_text(w);
        }
        resp.usage = self.usage_per_call.clone();
        resp.model = Some(req.model.clone());
        Ok(resp)
    }
}
