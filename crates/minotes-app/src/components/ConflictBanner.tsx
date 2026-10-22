import { useState } from "react";
import * as api from "../lib/api";
import { parseConflictTitle } from "../lib/conflicts";
import ConflictCompare from "./ConflictCompare";
import "./conflicts.css";

/**
 * Above a sync conflict copy ("<title> (conflict from <device>)"): what it is,
 * and Compare (the side-by-side view that resolves it).
 */
export default function ConflictBanner({ page, onOpenPage }: {
  page: api.Page;
  onOpenPage: (id: string) => void;
}) {
  const [comparing, setComparing] = useState(false);
  const parsed = parseConflictTitle(page.title);
  if (!parsed) return null;
  return (
    <div className="nb-banner info conflict-banner" role="status" data-testid="conflict-banner">
      <span>
        <strong>Conflict with {parsed.device}</strong> — this page is {parsed.device}'s version of “{parsed.base}”: both
        devices changed the same text while apart, and both versions were kept. Compare them and choose what to keep.
      </span>
      <div className="nb-banner-actions">
        <button className="btn btn-sm btn-primary" onClick={() => setComparing(true)} data-testid="conflict-compare-open">Compare</button>
      </div>
      {comparing && (
        <ConflictCompare copyId={page.id} onClose={() => setComparing(false)} onResolved={onOpenPage} />
      )}
    </div>
  );
}
