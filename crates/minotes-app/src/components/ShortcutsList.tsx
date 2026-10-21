import { SHORTCUT_GROUPS } from "../lib/shortcuts";

/** The keyboard shortcuts, grouped (Settings and the Ctrl+/ overlay). */
export default function ShortcutsList() {
  return (
    <>
      {SHORTCUT_GROUPS.map(group => (
        <div key={group.title} className="shortcuts-group">
          <div className="shortcuts-group-title">{group.title}</div>
          <div className="shortcuts-grid">
            {group.items.map(([key, desc]) => (
              <div key={key + desc} className="shortcut-row">
                <kbd className="shortcut-key">{key}</kbd>
                <span className="shortcut-desc">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
