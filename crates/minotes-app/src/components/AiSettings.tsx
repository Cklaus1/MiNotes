import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { remoteHost } from "../lib/aiEndpoint";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type TaskClass = "interactive" | "bulk" | "agent";

const TASK_CLASSES: Array<{ key: TaskClass; label: string; hint: string }> = [
  { key: "interactive", label: "Ask & editor", hint: "Questions about your notes" },
  { key: "bulk", label: "Bulk", hint: "Organising many notes (later)" },
  { key: "agent", label: "Agent", hint: "Multi-step actions (later)" },
];

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", "meta-llama": "Meta", mistralai: "Mistral AI",
  "x-ai": "xAI", deepseek: "DeepSeek", qwen: "Alibaba (Qwen)",
};

function perMillion(perToken: number): string {
  const v = perToken * 1_000_000;
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

function flattenFolders(nodes: api.FolderTree[], depth = 0): Array<{ id: string; name: string; depth: number }> {
  return nodes.flatMap(n => [{ id: n.id, name: n.name, depth }, ...flattenFolders(n.children ?? [], depth + 1)]);
}

export default function AiSettings({ open, onClose, onSaved }: Props) {
  const [status, setStatus] = useState<api.AiStatus | null>(null);
  const [draft, setDraft] = useState<api.AiSettings | null>(null);
  const [models, setModels] = useState<api.AiModelList | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [folders, setFolders] = useState<Array<{ id: string; name: string; depth: number }>>([]);
  const [keyInput, setKeyInput] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [encrypted, setEncrypted] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.getNotebookSession().then(s => setEncrypted(!!s?.encrypted)).catch(() => setEncrypted(false));
    setMessage(null);
    setKeyInput("");
    api.aiGetStatus().then(s => { setStatus(s); setDraft(structuredClone(s.settings)); }).catch(e => setMessage({ text: String(e), error: true }));
    api.getFolderTree().then(t => setFolders(flattenFolders(t?.folders ?? []))).catch(() => setFolders([]));
  }, [open]);

  const loadModels = (refresh: boolean) => {
    setModelsLoading(true);
    api.aiListModels(refresh)
      .then(setModels)
      .catch(e => setModels({ models: [], recommended: null, fetched_at: null, error: String(e) }))
      .finally(() => setModelsLoading(false));
  };

  useEffect(() => {
    if (open && draft?.provider === "openrouter" && !models && !modelsLoading) loadModels(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.provider]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  const recommended = models?.recommended ?? null;
  const modelFor = (k: TaskClass) => draft?.models[k] || recommended || "";

  // Plain-language notice for what is about to be saved.
  const notice = useMemo(() => {
    if (!draft) return "";
    const scope = draft.scope.kind === "notebook" ? "this notebook"
      : draft.scope.kind === "page" ? "the page you have open"
      : (folders.filter(f => draft.scope.folder_ids.includes(f.id)).map(f => f.name).join(", ") || "the selected folders");
    if (draft.provider === "off") return "AI is off: no note content leaves this device.";
    if (draft.provider === "local") {
      const remote = remoteHost(draft.local.base_url);
      return remote
        ? `Your notes in ${scope} are sent to ${remote}, a custom endpoint that is NOT on this computer, when you use AI features.`
        : `Your notes in ${scope} are sent only to the local model server at ${draft.local.base_url} when you use AI features.`;
    }
    const prefix = (modelFor("interactive") || "").split("/")[0];
    const who = PROVIDER_NAMES[prefix] ?? (prefix ? prefix[0].toUpperCase() + prefix.slice(1) : "the model's provider");
    return `Your notes in ${scope} are sent to OpenRouter and ${who} when you use AI features.`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, folders, recommended]);

  if (!open) return null;

  // A "local" endpoint that isn't on this computer needs explicit confirmation.
  const remote = draft?.provider === "local" ? remoteHost(draft.local.base_url) : null;

  const update = (fn: (d: api.AiSettings) => void) => {
    setDraft(prev => {
      if (!prev) return prev;
      const next = structuredClone(prev);
      fn(next);
      return next;
    });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const toSave = structuredClone(draft);
      // Pin the preselected recommendation so the choice is explicit.
      if (toSave.provider === "openrouter" && recommended && !toSave.models.interactive) toSave.models.interactive = recommended;
      const s = await api.aiSaveSettings(toSave);
      setStatus(s);
      setDraft(structuredClone(s.settings));
      setMessage({ text: s.configured ? "Saved. AI is ready." : `Saved. ${s.problem ?? ""}`, error: false });
      onSaved();
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async () => {
    try {
      const ks = await api.aiSetApiKey(keyInput);
      setKeyInput("");
      setStatus(s => s ? { ...s, key: ks } : s);
      setMessage({ text: "Key stored in the OS keychain.", error: false });
      if (!models?.models.length) loadModels(true);
      onSaved();
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  const clearKey = async () => {
    try {
      const ks = await api.aiClearApiKey();
      setStatus(s => s ? { ...s, key: ks } : s);
      setMessage({ text: ks.configured ? "Keychain entry removed (the environment variable is still used)." : "Key removed.", error: false });
      onSaved();
    } catch (e) {
      setMessage({ text: String(e), error: true });
    }
  };

  const key = status?.key;
  const keyLine = !key ? "" : key.source === "keychain" ? "Stored in the OS keychain."
    : key.source === "env" ? "Using OPENROUTER_API_KEY from the environment."
    : "No key yet.";

  return (
    <>
      <div className="settings-backdrop" onClick={onClose} />
      <div className="settings-slide-panel ai-settings" role="dialog" aria-label="AI settings" data-testid="ai-settings">
        <div className="settings-header">
          <span className="settings-title">AI</span>
          <button className="settings-close-btn" onClick={onClose} aria-label="Close">×</button>
        </div>

        {!draft ? (
          <div className="settings-section">{message?.text ?? "Loading…"}</div>
        ) : (
          <>
            <div className="settings-section">
              <div className="settings-section-title">Provider</div>
              <div className="ai-provider-options" role="radiogroup">
                {([
                  ["off", "Off", "No AI features. Nothing leaves this device."],
                  ["openrouter", "OpenRouter", "Cloud models (Claude, GPT, Gemini…) with your OpenRouter key."],
                  ["local", "Local model", "An OpenAI-compatible server on this computer (Ollama, LM Studio)."],
                ] as const).map(([value, label, hint]) => (
                  <label key={value} className={`ai-provider-option${draft.provider === value ? " selected" : ""}`}>
                    <input type="radio" name="ai-provider" value={value} checked={draft.provider === value}
                      onChange={() => update(d => { d.provider = value; })} data-testid={`ai-provider-${value}`} />
                    <span className="ai-provider-label">{label}</span>
                    <span className="ai-provider-hint">{hint}</span>
                  </label>
                ))}
              </div>
            </div>

            {draft.provider === "openrouter" && (
              <>
                <div className="settings-section">
                  <div className="settings-section-title">OpenRouter API key</div>
                  <p className={`ai-key-line${key?.configured ? " ok" : ""}`} data-testid="ai-key-status">{keyLine}</p>
                  {key && !key.keychain_available && (
                    <p className="ai-help">
                      No OS keychain is available on this system, so MiNotes can't store a key. Set
                      {" "}<code>OPENROUTER_API_KEY</code> in the environment and restart MiNotes.
                    </p>
                  )}
                  {key?.keychain_available && (
                    <div className="ai-key-row">
                      <input type="password" className="ai-text" placeholder="sk-or-…" value={keyInput} autoComplete="off"
                        onChange={e => setKeyInput(e.target.value)} data-testid="ai-key-input" />
                      <button className="btn" onClick={saveKey} disabled={!keyInput.trim()}>Save key</button>
                      {key.source === "keychain" && <button className="btn" onClick={clearKey}>Remove</button>}
                    </div>
                  )}
                  <p className="ai-help">Get a key at openrouter.ai/keys. The key stays in the backend; it is never shown again or stored in your notes.</p>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title ai-title-row">
                    <span>Models</span>
                    <button className="ai-link" onClick={() => loadModels(true)} disabled={modelsLoading}>
                      {modelsLoading ? "Loading…" : "Refresh list"}
                    </button>
                  </div>
                  {models?.error && <p className="ai-error">Couldn't load the model list: {models.error}</p>}
                  {TASK_CLASSES.map(tc => (
                    <div className="ai-model-row" key={tc.key}>
                      <div>
                        <div className="settings-row-label">{tc.label}</div>
                        <div className="ai-help">{tc.hint}</div>
                      </div>
                      <select className="settings-select ai-model-select" value={modelFor(tc.key)}
                        onChange={e => update(d => { d.models[tc.key] = e.target.value || null; })} data-testid={`ai-model-${tc.key}`}>
                        {!models?.models.length && <option value={modelFor(tc.key)}>{modelFor(tc.key) || "Loading models…"}</option>}
                        {models?.models.map(m => (
                          <option key={m.id} value={m.id}>
                            {m.name}{m.id === recommended ? " (recommended)" : ""} — {perMillion(m.prompt_price)} in / {perMillion(m.completion_price)} out per M
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <p className="ai-help">Only models that support tool calling are listed. Prices are per million tokens, from OpenRouter's catalogue.</p>
                </div>
              </>
            )}

            {draft.provider === "local" && (
              <div className="settings-section">
                <div className="settings-section-title">Local model</div>
                <label className="ai-field">
                  <span>Endpoint (OpenAI-compatible)</span>
                  <input className="ai-text" value={draft.local.base_url} onChange={e => update(d => { d.local.base_url = e.target.value; })}
                    data-testid="ai-local-url" />
                </label>
                {remote && (
                  <div className="ai-remote-warning" data-testid="ai-remote-warning" role="alert">
                    <p><strong>{remote} is not on this computer.</strong> Notes will be sent to {remote} whenever you use AI features.</p>
                    <label className="ai-check">
                      <input type="checkbox" checked={draft.local.confirmed_remote_host === remote}
                        onChange={e => update(d => { d.local.confirmed_remote_host = e.target.checked ? remote : null; })}
                        data-testid="ai-remote-confirm" />
                      Send my notes to {remote}
                    </label>
                  </div>
                )}
                <label className="ai-field">
                  <span>Model name</span>
                  <input className="ai-text" placeholder="e.g. llama3.1:8b" value={draft.local.model}
                    onChange={e => update(d => { d.local.model = e.target.value; })} data-testid="ai-local-model" />
                </label>
                <label className="ai-check">
                  <input type="checkbox" checked={draft.local.supports_tools} onChange={e => update(d => { d.local.supports_tools = e.target.checked; })} />
                  Model supports tool calling (otherwise MiNotes searches first and sends the results)
                </label>
              </div>
            )}

            {draft.provider !== "off" && (
              <>
                <div className="settings-section">
                  <div className="settings-section-title">What AI can read</div>
                  {([
                    ["notebook", "Whole notebook"],
                    ["folders", "Only these folders"],
                    ["page", "Only the page I have open"],
                  ] as const).map(([value, label]) => (
                    <label key={value} className="ai-check">
                      <input type="radio" name="ai-scope" checked={draft.scope.kind === value}
                        onChange={() => update(d => { d.scope.kind = value; })} />
                      {label}
                    </label>
                  ))}
                  {draft.scope.kind === "folders" && (
                    <div className="ai-folder-list">
                      {folders.length === 0 && <p className="ai-help">No folders yet.</p>}
                      {folders.map(f => (
                        <label key={f.id} className="ai-check" style={{ paddingLeft: 18 + f.depth * 14 }}>
                          <input type="checkbox" checked={draft.scope.folder_ids.includes(f.id)}
                            onChange={e => update(d => {
                              d.scope.folder_ids = e.target.checked
                                ? [...d.scope.folder_ids, f.id]
                                : d.scope.folder_ids.filter(x => x !== f.id);
                            })} />
                          {f.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">Cost and privacy</div>
                  {draft.provider === "openrouter" && (
                    <div className="settings-row">
                      <span className="settings-row-label">Monthly cap (USD)</span>
                      <input type="number" min={0} step={1} className="ai-text ai-number" value={draft.monthly_cap_usd}
                        onChange={e => update(d => { d.monthly_cap_usd = Number(e.target.value); })} data-testid="ai-cap" />
                    </div>
                  )}
                  {draft.provider === "openrouter" && status && (
                    <p className="ai-help">Spent this month: ${status.spend_this_month_usd.toFixed(2)}. Questions stop when the cap is reached.</p>
                  )}
                  <label className="ai-check">
                    <input type="checkbox" checked={draft.keep_transcripts} onChange={e => update(d => { d.keep_transcripts = e.target.checked; })} />
                    Keep transcripts (store questions and answers in the run log)
                  </label>
                  <button className="settings-advanced-toggle" onClick={() => setShowAdvanced(v => !v)}>
                    {showAdvanced ? "▾" : "▸"} Advanced
                  </button>
                  {showAdvanced && (
                    <div className="settings-row">
                      <span className="settings-row-label">Reasoning effort</span>
                      <select className="settings-select" value={draft.reasoning_effort ?? ""}
                        onChange={e => update(d => { d.reasoning_effort = (e.target.value || null) as api.AiSettings["reasoning_effort"]; })}>
                        <option value="">Model default</option>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="settings-section">
              {encrypted && (
                <div className="ai-notice-box" data-testid="ai-encrypted-notice">
                  This notebook is encrypted. Turning AI on sends the notes in scope to the provider you choose,
                  outside the encryption — a local model keeps them on this computer.
                </div>
              )}
              <div className="ai-notice-box" data-testid="ai-data-notice">{notice}</div>
              {message && <p className={message.error ? "ai-error" : "ai-saved"} role="status">{message.text}</p>}
              <div className="ai-settings-actions">
                <button className="btn" onClick={onClose}>Close</button>
                <button className="btn btn-primary" onClick={save} disabled={saving} data-testid="ai-save">
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
