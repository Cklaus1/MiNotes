import { useEffect, useRef } from "react";
import Modal from "./Modal";
import { pdfDisplayName } from "../lib/pdfFiles";

/** Ctrl+P when PDFs were opened before: the recent ones, or "Choose a PDF…" (native picker). */
export default function OpenPdfDialog({ recent, onOpen, onChoose, onClose }: {
  recent: string[];
  onOpen: (path: string) => void;
  onChoose: () => void;
  onClose: () => void;
}) {
  const chooseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { chooseRef.current?.focus(); }, []);
  return (
    <Modal title="Open a PDF" onClose={onClose} testId="open-pdf-dialog">
      <button ref={chooseRef} className="btn btn-primary pdf-open-choose" onClick={onChoose}>
        Choose a PDF file…
      </button>
      <div className="pdf-open-recent-label">Recent</div>
      <ul className="pdf-open-recent">
        {recent.map((p) => (
          <li key={p}>
            <button className="pdf-open-recent-item" onClick={() => onOpen(p)} title={p}>
              <span className="pdf-open-recent-name">{pdfDisplayName(p)}</span>
              <span className="pdf-open-recent-path">{p}</span>
            </button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
