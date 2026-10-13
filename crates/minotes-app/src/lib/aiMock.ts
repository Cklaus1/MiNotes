/**
 * Browser-mode mock of the AI platform (minotes-core `ai` + src-tauri ai_commands.rs).
 *
 * Mirrors the real command shapes so the Ask panel and AI settings work in a
 * plain browser: a fake OpenRouter catalogue, a scripted "model" that searches
 * the mock notes and answers with [[cite:<block-id>]] markers, citation
 * validation identical in spirit to the Rust side (invented ids are stripped,
 * no valid citation → "I couldn't find that in your notes."), and progress
 * delivered as events on `aiMockEvents` (the Tauri build uses `ai://event`).
 */

import type {
  AiSettings, AiStatus, AiKeyStatus, AiModelInfo, AiRunOutput, AiCitation, AiStreamEvent, AiRunRecord, Block, Page,
} from "./api";
import { endpointHost, remoteHost } from "./aiEndpoint";

export const aiMockEvents = new EventTarget();

const NOT_FOUND = "I couldn't find that in your notes.";

const defaultSettings = (): AiSettings => ({
  provider: "off",
  models: { interactive: null, bulk: null, agent: null },
  scope: { kind: "notebook", folder_ids: [] },
  monthly_cap_usd: 10,
  keep_transcripts: false,
  local: { base_url: "http://localhost:11434/v1", model: "", supports_tools: true, confirmed_remote_host: null },
  reasoning_effort: "medium",
  max_tool_iterations: 8,
  run_token_budget: 300000,
  max_output_tokens: 16000,
});

// Clearly fake catalogue entries (the real list comes from OpenRouter's /models).
const MOCK_MODELS: AiModelInfo[] = [
  { id: "anthropic/claude-opus-mock", name: "Claude Opus (mock)", created: 300, context_length: 1000000,
    prompt_price: 4e-6, completion_price: 2e-5, cache_read_price: 2e-7 },
  { id: "anthropic/claude-sonnet-mock", name: "Claude Sonnet (mock)", created: 290, context_length: 1000000,
    prompt_price: 2e-6, completion_price: 1e-5, cache_read_price: 2e-7 },
  { id: "openai/gpt-mock", name: "GPT (mock)", created: 280, context_length: 400000,
    prompt_price: 1.25e-6, completion_price: 1e-5, cache_read_price: null },
];

const STOPWORDS = new Set(("the and for what when where which who whom why how did does was were are is about with that this " +
  "these those from have has had our your you they them their there any all can could would should will into onto over " +
  "under notes note tell know find show list give please decide decided something some").split(" "));

function keywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const w = raw.replace(/^-+|-+$/g, "");
    if (w.length < 3 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

function providerName(modelId: string | null | undefined): string {
  const p = (modelId ?? "").split("/")[0];
  const known: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "meta-llama": "Meta",
    mistralai: "Mistral AI", "x-ai": "xAI", deepseek: "DeepSeek", qwen: "Alibaba (Qwen)" };
  return known[p] ?? (p ? p[0].toUpperCase() + p.slice(1) : "the model's provider");
}

type Handlers = Record<string, (args: any) => any>;

export function createAiMockHandlers(h: Handlers): Handlers {
  let settings = defaultSettings();
  let keyStored = false;
  let catalogFetchedAt: string | null = null;
  const runs: AiRunRecord[] = [];
  const conversations = new Map<string, { seen: Set<string>; turns: number }>();
  const cancelled = new Set<string>();

  const keyStatus = (): AiKeyStatus => ({ configured: keyStored, source: keyStored ? "keychain" : "none", keychain_available: true });
  const recommended = () => MOCK_MODELS.filter(m => m.id.startsWith("anthropic/claude-opus"))
    .sort((a, b) => b.created - a.created)[0]?.id ?? null;
  const effectiveModel = () => settings.provider === "local"
    ? (settings.local.model || null)
    : settings.provider === "openrouter" ? (settings.models.interactive || (catalogFetchedAt ? recommended() : null)) : null;
  const monthSpend = () => runs.reduce((s, r) => s + r.cost_usd, 0);

  const folderNames = (ids: string[]): string[] => {
    const names: string[] = [];
    const walk = (nodes: any[]) => nodes.forEach(n => { if (ids.includes(n.id)) names.push(n.name); walk(n.children ?? []); });
    try { walk((h.get_folder_tree({}) as any)?.folders ?? h.get_folder_tree({}) ?? []); } catch { /* ignore */ }
    return names;
  };
  const scopeLabel = () => settings.scope.kind === "notebook" ? "this notebook"
    : settings.scope.kind === "page" ? "the page you have open"
    : (folderNames(settings.scope.folder_ids).join(", ") || "the selected folders");

  const status = (): AiStatus => {
    const model = effectiveModel();
    const ks = keyStatus();
    const remote = settings.provider === "local" ? remoteHost(settings.local.base_url) : null;
    const problem = settings.provider === "off" ? "AI is off."
      : settings.provider === "openrouter" && !ks.configured ? "Add your OpenRouter API key."
      : remote && settings.local.confirmed_remote_host !== remote ? `Confirm the custom endpoint ${remote} in AI settings: it is not on this computer.`
      : !model ? "Choose a model." : null;
    const label = scopeLabel();
    const data_notice = settings.provider === "off" ? "AI is off: no note content leaves this device."
      : settings.provider === "local" ? (remote
        ? `Your notes in ${label} are sent to ${remote}, a custom endpoint that is NOT on this computer, when you use AI features.`
        : `Your notes in ${label} are sent only to the local model server at ${settings.local.base_url} when you use AI features.`)
      : `Your notes in ${label} are sent to OpenRouter and ${providerName(model)} when you use AI features.`;
    return {
      settings: structuredClone(settings), key: ks, configured: problem === null, problem,
      spend_this_month_usd: monthSpend(), data_notice, effective_model: model, recommended_model: catalogFetchedAt ? recommended() : null,
      scope_label: label, catalog_fetched_at: catalogFetchedAt,
    };
  };

  const emit = (e: AiStreamEvent) => aiMockEvents.dispatchEvent(new CustomEvent("event", { detail: e }));
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  /** Pages the run may read (visible + in scope). */
  const scopedPages = (currentPageId: string | null): Map<string, Page> => {
    const all: Page[] = h.list_pages({ limit: 100000 }) ?? [];
    const out = new Map<string, Page>();
    for (const p of all) {
      if (settings.scope.kind === "page" && p.id !== currentPageId) continue;
      if (settings.scope.kind === "folders" && !(p.folder_id && settings.scope.folder_ids.includes(p.folder_id))) continue;
      out.set(p.id, p);
    }
    return out;
  };

  async function runAsk(convId: string, question: string, currentPageId: string | null) {
    const conv = conversations.get(convId) ?? { seen: new Set<string>(), turns: 0 };
    const model = effectiveModel() ?? "mock";
    const runId = `run-${Date.now().toString(36)}`;
    const started = new Date().toISOString();
    const progress = (event: any) => emit({ conversation_id: convId, kind: "progress", event });
    const fail = (message: string, not_configured = false) => emit({ conversation_id: convId, kind: "error", message, not_configured });

    const st = status();
    if (!st.configured) return fail(st.problem ?? "AI is not configured.", true);
    if (settings.scope.kind === "page" && !currentPageId) return fail("The AI scope is “current page”: open a page first.");
    if (settings.provider !== "local" && monthSpend() >= settings.monthly_cap_usd) {
      return fail(`This month's AI spending cap is reached ($${monthSpend().toFixed(2)} of $${settings.monthly_cap_usd.toFixed(2)}). Raise the cap in AI settings to continue.`);
    }
    const pages = scopedPages(currentPageId);
    progress({ type: "started", run_id: runId, model });
    progress({ type: "turn", n: 1 });
    await sleep(120);

    // "Tool calls": one search per keyword, scoped.
    const hits: Block[] = [];
    for (const kw of keywords(question).slice(0, 3)) {
      if (cancelled.has(convId)) break;
      progress({ type: "status", text: `Searching notes for “${kw}”` });
      await sleep(80);
      for (const b of (h.search_blocks({ query: kw, limit: 50 }) as Block[]) ?? []) {
        if (pages.has(b.page_id) && b.content.trim() && !hits.some(x => x.id === b.id)) hits.push(b);
      }
    }
    if (cancelled.has(convId)) { cancelled.delete(convId); return fail("Stopped."); }
    hits.slice(0, 10).forEach(b => conv.seen.add(b.id));

    progress({ type: "turn", n: 2 });
    let raw: string;
    if (hits.length === 0) {
      raw = NOT_FOUND;
    } else {
      const strip = (s: string) => s.replace(/^#+\s*/, "").replace(/^(TODO|DOING|DONE)\s+/, "").trim();
      const parts = hits.slice(0, 2).map(b => `“${strip(b.content)}” [[cite:${b.id}]]`);
      // The scripted model also "hallucinates" one id; validation must strip it.
      raw = `Here is what your notes say: ${parts.join(" Also: ")} (see also [[cite:mock-invented-id]])`;
    }
    for (const w of raw.split(/(?<= )/)) {
      if (cancelled.has(convId)) { cancelled.delete(convId); return fail("Stopped."); }
      progress({ type: "delta", text: w });
      await sleep(15);
    }

    // Citation validation (mirror of ask::validate_citations).
    const citations: AiCitation[] = [];
    let stripped = 0;
    let answer = raw.replace(/\[\[cite:([^\]]*)\]\]/g, (_m, ids: string) => {
      const kept: string[] = [];
      for (const id of ids.split(",").map(s => s.trim())) {
        const b: Block | null = conv.seen.has(id) ? h.get_block({ id }) : null;
        if (b && pages.has(b.page_id)) {
          kept.push(`[[cite:${id}]]`);
          if (!citations.some(c => c.block_id === id)) {
            citations.push({ block_id: id, page_id: b.page_id, page_title: pages.get(b.page_id)!.title, snippet: b.content.slice(0, 200) });
          }
        } else stripped++;
      }
      return kept.join("");
    }).replace(/\s*\(see also \)/, "").trim();
    let outcome = "ok";
    if (citations.length === 0) { answer = NOT_FOUND; outcome = "not_found"; }

    const usage = { prompt_tokens: 1800 + conv.turns * 600, completion_tokens: 120, cached_tokens: conv.turns ? 1500 : 0, cost: null };
    const m = MOCK_MODELS.find(x => x.id === model);
    const cost = settings.provider === "local" || !m ? 0
      : (usage.prompt_tokens - usage.cached_tokens) * m.prompt_price + usage.cached_tokens * (m.cache_read_price ?? m.prompt_price)
        + usage.completion_tokens * m.completion_price;
    conv.turns++;
    conversations.set(convId, conv);
    runs.unshift({
      id: runId, task: "ask", scope: settings.scope.kind, provider: settings.provider, model,
      input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, cached_tokens: usage.cached_tokens,
      tool_calls: Math.min(3, keywords(question).length), cost_usd: cost, started_at: started,
      finished_at: new Date().toISOString(), outcome, error: null, has_transcript: settings.keep_transcripts,
    });
    const result: AiRunOutput = {
      run_id: runId, answer, citations, stripped_citations: stripped, outcome, notice: null, model, usage,
      cost_usd: cost, iterations: 2, tool_calls: runs[0].tool_calls, spend_this_month_usd: monthSpend(),
      cap_usd: settings.monthly_cap_usd,
    };
    emit({ conversation_id: convId, kind: "done", result });
  }

  return {
    ai_get_status: () => status(),
    ai_save_settings: ({ settings: s }: { settings: AiSettings }) => {
      if (!(s.monthly_cap_usd >= 0)) throw new Error("Monthly cap must be a number ≥ 0");
      if (s.provider === "local" && !/^https?:\/\//.test(s.local.base_url.trim())) {
        throw new Error("Local endpoint must start with http:// or https://");
      }
      if (s.provider === "local") {
        if (!endpointHost(s.local.base_url)) throw new Error("The endpoint URL has no host name");
        const remote = remoteHost(s.local.base_url);
        if (remote && (s.local.confirmed_remote_host ?? "").trim().toLowerCase() !== remote) {
          throw new Error(`${remote} is not on this computer: your notes would be sent to it. Confirm the custom endpoint in AI settings first.`);
        }
      }
      if (s.scope.kind === "folders" && s.scope.folder_ids.length === 0) throw new Error("Pick at least one folder for the AI scope");
      settings = structuredClone(s);
      return status();
    },
    ai_set_api_key: ({ key }: { key: string }) => {
      if (!key?.trim()) throw new Error("The key is empty.");
      keyStored = true; // the mock never keeps the key itself
      return keyStatus();
    },
    ai_clear_api_key: () => { keyStored = false; return keyStatus(); },
    ai_list_models: () => {
      catalogFetchedAt = catalogFetchedAt ?? new Date().toISOString();
      return { models: MOCK_MODELS, recommended: recommended(), fetched_at: catalogFetchedAt, error: null };
    },
    ai_ask: ({ question, conversationId, currentPageId }: { question: string; conversationId?: string | null; currentPageId?: string | null }) => {
      const id = conversationId || `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      setTimeout(() => { runAsk(id, question, currentPageId ?? null); }, 0);
      return id;
    },
    ai_cancel: ({ conversationId }: { conversationId: string }) => { cancelled.add(conversationId); },
    ai_reset_conversation: ({ conversationId }: { conversationId: string }) => { conversations.delete(conversationId); },
    ai_list_runs: ({ limit }: { limit?: number }) => runs.slice(0, limit ?? 20),
  };
}
