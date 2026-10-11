import { useEffect, useRef, useState, type ReactNode } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
  activePageId: string | null;
  onOpenBlock: (pageId: string, blockId: string) => void;
  onOpenSettings: () => void;
  /** Bumped by the parent after settings are saved, to reload status. */
  statusKey: number;
}

interface Turn {
  question: string;
  streaming: string;
  status: string | null;
  running: boolean;
  result: api.AiRunOutput | null;
  error: string | null;
  notConfigured: boolean;
}

const CITE_RE = /\[\[cite:([^\]]+)\]\]/g;

/** Hide citation markers (complete or still streaming in) from live text. */
function liveText(s: string): string {
  return s.replace(CITE_RE, "").replace(/\[\[?c?i?t?e?:?[^\]\s]*$/, "");
}

function money(n: number): string {
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function AskPanel({ open, onClose, activePageId, onOpenBlock, onOpenSettings, statusKey }: Props) {
  const [status, setStatus] = useState<api.AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const convRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const running = turns.some(t => t.running);

  useEffect(() => {
    if (!open) return;
    api.aiGetStatus().then(s => { setStatus(s); setStatusError(null); }).catch(e => setStatusError(String(e)));
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open, statusKey]);

  // One subscription for the panel's lifetime; events for other conversations are ignored.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    api.onAiEvent((e) => {
      if (e.conversation_id !== convRef.current) return;
      setTurns(prev => {
        if (prev.length === 0) return prev;
        const next = prev.slice();
        const t = { ...next[next.length - 1] };
        if (e.kind === "progress") {
          const ev = e.event;
          if (ev.type === "turn") t.streaming = "";
          else if (ev.type === "delta") t.streaming += ev.text;
          else if (ev.type === "status") t.status = ev.text;
        } else if (e.kind === "done") {
          t.running = false; t.result = e.result; t.status = null;
          setStatus(s => s ? { ...s, spend_this_month_usd: e.result.spend_this_month_usd } : s);
        } else {
          t.running = false; t.error = e.message; t.notConfigured = e.not_configured; t.status = null;
        }
        next[next.length - 1] = t;
        return next;
      });
    }).then(u => { if (disposed) u(); else unlisten = u; });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => {
    if (!open) return;
    // Escape closes AI settings first when they are open on top.
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !document.querySelector("[data-testid=ai-settings]")) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const ask = async () => {
    const q = input.trim();
    if (!q || running) return;
    setInput("");
    setTurns(prev => [...prev, { question: q, streaming: "", status: "Thinking…", running: true, result: null, error: null, notConfigured: false }]);
    try {
      // Set the id before events can arrive (the backend replies with the same id).
      if (!convRef.current) convRef.current = `conv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await api.aiAsk(q, convRef.current, activePageId);
    } catch (e) {
      setTurns(prev => prev.map((t, i) => i === prev.length - 1 ? { ...t, running: false, error: String(e), status: null } : t));
    }
  };

  const newConversation = () => {
    if (convRef.current) api.aiResetConversation(convRef.current).catch(() => {});
    convRef.current = null;
    setTurns([]);
    inputRef.current?.focus();
  };

  const stop = () => { if (convRef.current) api.aiCancel(convRef.current).catch(() => {}); };

  const renderAnswer = (r: api.AiRunOutput): ReactNode[] => {
    const order = r.citations.map(c => c.block_id);
    const out: ReactNode[] = [];
    let last = 0;
    let k = 0;
    for (const m of r.answer.matchAll(CITE_RE)) {
      out.push(<span key={k++}>{r.answer.slice(last, m.index)}</span>);
      const id = m[1];
      const c = r.citations.find(x => x.block_id === id);
      if (c) {
        out.push(
          <button key={k++} className="ai-cite" title={`${c.page_title}: ${c.snippet}`}
            onClick={() => onOpenBlock(c.page_id, c.block_id)} data-testid="ai-cite">
            {order.indexOf(id) + 1}
          </button>,
        );
      }
      last = (m.index ?? 0) + m[0].length;
    }
    out.push(<span key={k++}>{r.answer.slice(last)}</span>);
    return out;
  };

  const configured = status?.configured ?? false;

  return (
    <aside className="ask-panel" role="complementary" aria-label="Ask your notes" data-testid="ask-panel">
      <div className="ask-panel-header">
        <div className="ask-panel-heading">
          <span className="ask-panel-title">Ask your notes</span>
          {status && configured && (
            <span className="ask-panel-sub" title={status.data_notice}>
              {status.scope_label} · {status.effective_model}
            </span>
          )}
        </div>
        <div className="ask-panel-actions">
          {turns.length > 0 && (
            <button className="ai-icon-btn" onClick={newConversation} title="New conversation" aria-label="New conversation">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M8 3v10M3 8h10" /></svg>
            </button>
          )}
          <button className="ai-icon-btn" onClick={onOpenSettings} title="AI settings" aria-label="AI settings" data-testid="ai-open-settings">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></svg>
          </button>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
      </div>

      {statusError && <div className="ai-error">{statusError}</div>}

      {status && !configured ? (
        <div className="ai-empty" data-testid="ai-not-configured">
          <div className="ai-empty-title">{status.settings.provider === "off" ? "AI is off" : "AI isn't set up yet"}</div>
          <p>
            Ask questions about your notes and get answers that link to the blocks they came from.
            Nothing is sent anywhere until you choose a provider.
          </p>
          {status.problem && status.settings.provider !== "off" && <p className="ai-empty-problem">{status.problem}</p>}
          <button className="btn btn-primary" onClick={onOpenSettings} data-testid="ai-setup">Set up AI…</button>
        </div>
      ) : (
        <>
          <div className="ai-thread" ref={listRef} data-testid="ai-thread">
            {turns.length === 0 && status && (
              <div className="ai-hint">
                <p>Ask anything about your notes — “What did we decide about pricing?”, “What's still open for Project Alpha?”</p>
                <p className="ai-notice">{status.data_notice}</p>
              </div>
            )}
            {turns.map((t, i) => (
              <div className="ai-turn" key={i}>
                <div className="ai-question">{t.question}</div>
                <div className="ai-answer" data-testid={t.result ? "ai-answer" : undefined}>
                  {t.result ? (
                    <>
                      {t.result.answer && <div className="ai-answer-text">{renderAnswer(t.result)}</div>}
                      {t.result.notice && <div className="ai-notice-line">{t.result.notice}</div>}
                      {t.result.citations.length > 0 && (
                        <div className="ai-sources">
                          {t.result.citations.map((c, n) => (
                            <button key={c.block_id} className="ai-source" onClick={() => onOpenBlock(c.page_id, c.block_id)}
                              title={c.snippet} data-testid="ai-source">
                              <span className="ai-source-n">{n + 1}</span>
                              <span className="ai-source-title">{c.page_title || "Untitled"}</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="ai-meta" data-testid="ai-cost">
                        {money(t.result.cost_usd)} · {tokens(t.result.usage.prompt_tokens)} in
                        {t.result.usage.cached_tokens > 0 ? ` (${tokens(t.result.usage.cached_tokens)} cached)` : ""} / {tokens(t.result.usage.completion_tokens)} out
                        {t.result.tool_calls > 0 ? ` · ${t.result.tool_calls} lookup${t.result.tool_calls > 1 ? "s" : ""}` : ""}
                        {t.result.stripped_citations > 0 ? ` · ${t.result.stripped_citations} invalid citation${t.result.stripped_citations > 1 ? "s" : ""} removed` : ""}
                      </div>
                    </>
                  ) : t.error ? (
                    <div className="ai-error">
                      {t.error}
                      {t.notConfigured && <> <button className="ai-link" onClick={onOpenSettings}>Open AI settings</button></>}
                    </div>
                  ) : (
                    <>
                      {t.streaming && <div className="ai-answer-text ai-streaming">{liveText(t.streaming)}</div>}
                      {t.status && <div className="ai-status"><span className="ai-dot" />{t.status}</div>}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="ai-compose">
            <textarea
              ref={inputRef}
              className="ai-input"
              rows={2}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask your notes…"}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
              data-testid="ai-input"
            />
            <div className="ai-compose-row">
              <span className="ai-spend">
                {status?.settings.provider === "openrouter"
                  ? `${money(status.spend_this_month_usd)} of ${money(status.settings.monthly_cap_usd)} this month`
                  : status?.settings.provider === "local" ? "Local model · free" : ""}
              </span>
              {running
                ? <button className="btn" onClick={stop}>Stop</button>
                : <button className="btn btn-primary" onClick={ask} disabled={!input.trim()} data-testid="ai-send">Ask</button>}
            </div>
          </div>
        </>
      )}
    </aside>
  );
}
