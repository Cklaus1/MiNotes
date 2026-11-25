import { useEffect, useState } from "react";
import { confirmDialog, promptDialog } from "../lib/confirm";
import { showToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import {
  deleteUserTemplate, refreshUserTemplates, renameUserTemplate, subscribeUserTemplates,
  templateBlockCount, userTemplates,
} from "../lib/templates";
import Icon from "./Icon";

/**
 * Settings → Templates: the user's own templates (made with "Save as template"
 * on a page or a block), with rename and delete. Built-in templates aren't listed.
 */
export default function TemplatesSettings() {
  const [list, setList] = useState(userTemplates());
  useEffect(() => {
    const off = subscribeUserTemplates(() => setList([...userTemplates()]));
    void refreshUserTemplates();
    return off;
  }, []);

  const rename = async (name: string) => {
    const next = await promptDialog({ title: "Rename template", label: "Name", defaultValue: name, confirmLabel: "Rename" });
    if (!next || next === name) return;
    try { await renameUserTemplate(name, next); } catch (e) { showToast(`Not renamed: ${errorMessage(e)}`); }
  };
  const remove = async (name: string) => {
    const ok = await confirmDialog({
      title: "Delete the template?",
      message: `“${name}” is removed from the / menu. Blocks already made from it stay.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try { await deleteUserTemplate(name); showToast(`Template “${name}” deleted`); } catch (e) { showToast(`Not deleted: ${errorMessage(e)}`); }
  };

  return (
    <div className="settings-section" data-section="templates" data-testid="settings-templates">
      <div className="settings-section-title">Templates</div>
      <div className="nb-hint">
        Insert a template with <kbd>/</kbd> in any block. Make one with “Save as template” in a page's info panel or a block's right-click menu.
        Placeholders: {"{{date}} {{time}} {{title}} {{cursor}}"}.
      </div>
      {list.length === 0 ? (
        <div className="settings-row"><span className="settings-row-label templates-empty">No templates of your own yet.</span></div>
      ) : (
        list.map((t) => (
          <div className="settings-row template-row" key={t.name} data-template={t.name}>
            <span className="settings-row-label" title={t.content}>
              <Icon name="template" size={14} /> {t.name}
              <span className="template-row-count"> · {templateBlockCount(t.content)} blocks</span>
            </span>
            <span className="template-row-actions">
              <button className="btn btn-sm" data-action="rename-template" onClick={() => rename(t.name)}>Rename…</button>
              <button className="btn btn-sm btn-danger" data-action="delete-template" onClick={() => remove(t.name)}>Delete</button>
            </span>
          </div>
        ))
      )}
    </div>
  );
}
