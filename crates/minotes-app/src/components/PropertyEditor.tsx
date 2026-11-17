import { useEffect, useRef, useState } from "react";
import type { Property } from "../lib/api";
import * as api from "../lib/api";
import { showToast } from "../lib/toast";
import { isInternalProperty, notePropertyKey, propertyKeys, suggestKeys } from "../lib/propertyKeys";
import Icon from "./Icon";

const propError = (e: unknown) => String((e as any)?.message ?? e);

interface Props {
  entityId: string;
  entityType: "page" | "block";
  properties: Property[];
  onChange: (props: Property[]) => void;
  /** The "new property" field is open. */
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  /** Page properties: a row under the title with its own "Add property" button. */
  variant?: "page" | "block";
}

/**
 * Property chips (key · value) with in-place editing, delete, and a new-property
 * field whose key autocompletes from the keys used in this notebook (UX Wave 4:
 * the old inputs were a few characters wide and had no suggestions).
 */
export default function PropertyEditor({ entityId, entityType, properties, onChange, adding, onAddingChange, variant = "block" }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [keys, setKeys] = useState<string[]>([]);
  const [active, setActiveState] = useState(-1);
  // Keys can arrive faster than renders (↓ then Enter): read the live value.
  const activeRef = useRef(-1);
  const setActive = (v: number | ((a: number) => number)) => {
    const next = typeof v === "function" ? v(activeRef.current) : v;
    activeRef.current = next;
    setActiveState(next);
  };
  const [keyFocused, setKeyFocused] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);
  const newRef = useRef<HTMLSpanElement>(null);
  const savingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!adding) { setNewKey(""); setNewValue(""); setActive(-1); return; }
    let live = true;
    propertyKeys().then((k) => { if (live) setKeys(k.filter((x) => !isInternalProperty(x))); });
    return () => { live = false; };
  }, [adding]);

  const suggestions = adding && keyFocused ? suggestKeys(keys, newKey, properties.map((p) => p.key)) : [];

  const reload = async () => {
    const props = await api.getProperties(entityId).catch(() => null);
    if (props) onChange(props);
  };

  const add = async () => {
    const k = newKey.trim();
    if (!k) { onAddingChange(false); return; }
    try {
      await api.setProperty(entityId, entityType, k, newValue.trim());
    } catch (e) {
      // Refused by the backend (invalid key/value): say why, add nothing.
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    notePropertyKey(k);
    await reload();
    onAddingChange(false);
  };

  const update = async (key: string) => {
    // Enter saves and closes the input; the blur that may follow must not save again.
    if (savingRef.current === key) return;
    savingRef.current = key;
    setTimeout(() => { savingRef.current = null; }, 0);
    setEditing(null);
    const current = properties.find((p) => p.key === key)?.value ?? "";
    if (editValue.trim() === current) return;
    try {
      await api.setProperty(entityId, entityType, key, editValue.trim());
    } catch (e) {
      showToast(`Property not saved: ${propError(e)}`);
      return;
    }
    await reload();
  };

  const remove = async (key: string) => {
    try {
      await api.deleteProperty(entityId, key);
      onChange(properties.filter((p) => p.key !== key));
    } catch (e) {
      showToast(`Property not deleted: ${propError(e)}`);
    }
  };

  const pick = (key: string) => {
    setNewKey(key);
    setActive(-1);
    valueRef.current?.focus();
  };

  const shown = properties.filter((p) => !isInternalProperty(p.key));
  if (shown.length === 0 && !adding && variant === "block") return null;

  return (
    <div className={variant === "page" ? "page-props-row" : "block-properties"} data-testid={variant === "page" ? "page-props" : undefined}>
      {shown.map((prop) => (
        <span key={prop.key} className="prop-chip" data-key={prop.key}>
          <span className="prop-key">{prop.key}</span>
          {editing === prop.key ? (
            <input
              className="prop-edit-input prop-value-input"
              aria-label={`Value of ${prop.key}`}
              value={editValue}
              size={Math.max(12, Math.min(40, editValue.length + 2))}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={() => update(prop.key)}
              onKeyDown={(e) => {
                if (e.key === "Enter") update(prop.key);
                if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
              }}
              data-escape-local=""
              autoFocus
            />
          ) : (
            <button
              type="button"
              className="prop-value"
              title="Edit the value"
              onClick={() => { setEditing(prop.key); setEditValue(prop.value ?? ""); }}
            >
              {prop.value || "—"}
            </button>
          )}
          <button type="button" className="prop-delete" aria-label={`Remove ${prop.key}`} title={`Remove ${prop.key}`} onClick={() => remove(prop.key)}>×</button>
        </span>
      ))}
      {adding && (
        <span
          className="prop-chip prop-chip-new"
          ref={newRef}
          onBlur={(e) => {
            // Focus left the new property: keep what was typed (a key is enough).
            if (newRef.current?.contains(e.relatedTarget as Node | null)) return;
            if (newKey.trim()) void add(); else onAddingChange(false);
          }}
        >
          <span className="prop-key-field">
            <input
              className="prop-edit-input prop-key-input"
              placeholder="property"
              aria-label="Property name"
              aria-autocomplete="list"
              aria-expanded={suggestions.length > 0}
              value={newKey}
              size={14}
              onFocus={() => setKeyFocused(true)}
              onBlur={() => setKeyFocused(false)}
              onChange={(e) => { setNewKey(e.target.value); setActive(-1); }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && suggestions.length) { e.preventDefault(); setActive((a) => (a + 1) % suggestions.length); }
                else if (e.key === "ArrowUp" && suggestions.length) { e.preventDefault(); setActive((a) => (a - 1 + suggestions.length) % suggestions.length); }
                else if ((e.key === "Enter" || e.key === "Tab") && activeRef.current >= 0 && suggestions[activeRef.current]) { e.preventDefault(); pick(suggestions[activeRef.current]); }
                else if (e.key === "Enter") { e.preventDefault(); valueRef.current?.focus(); }
                else if (e.key === "Escape") { e.preventDefault(); onAddingChange(false); }
              }}
              data-escape-local=""
              autoFocus
            />
            {suggestions.length > 0 && (
              <span className="prop-key-suggestions" role="listbox" aria-label="Property names in use">
                {suggestions.map((k, i) => (
                  <button
                    type="button"
                    key={k}
                    role="option"
                    aria-selected={i === active}
                    className={`prop-key-suggestion${i === active ? " active" : ""}`}
                    onMouseDown={(e) => { e.preventDefault(); pick(k); }}
                  >
                    {k}
                  </button>
                ))}
              </span>
            )}
          </span>
          <input
            ref={valueRef}
            className="prop-edit-input prop-value-input"
            placeholder="value"
            aria-label="Property value"
            value={newValue}
            size={18}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void add(); }
              if (e.key === "Escape") { e.preventDefault(); onAddingChange(false); }
            }}
            data-escape-local=""
          />
          <button type="button" className="prop-delete" aria-label="Cancel" title="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={() => onAddingChange(false)}>×</button>
        </span>
      )}
      {variant === "page" && !adding && (
        <button type="button" className="page-prop-add" data-testid="page-prop-add" onClick={() => onAddingChange(true)} title="Add a property to this page">
          <Icon name="plus" size={12} /> Add property
        </button>
      )}
    </div>
  );
}
