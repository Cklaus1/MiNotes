import { useState, useEffect, useCallback } from "react";
import * as api from "../lib/api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function ReviewPanel({ open, onClose }: Props) {
  const [dueCards, setDueCards] = useState<api.Card[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [blockContent, setBlockContent] = useState("");
  const [childBlocks, setChildBlocks] = useState<api.Block[]>([]);
  const [stats, setStats] = useState<api.SrsStats | null>(null);
  const [reviewedCount, setReviewedCount] = useState(0);
  const [totalDue, setTotalDue] = useState(0);

  const loadCards = useCallback(async () => {
    try {
      const cards = await api.getDueCards(100);
      setDueCards(cards);
      setCurrentIndex(0);
      setShowAnswer(false);
      setReviewedCount(0);
      setTotalDue(cards.length);
      const s = await api.getSrsStats();
      setStats(s);
    } catch (e) {
      console.error("Failed to load due cards:", e);
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadCards();
    }
  }, [open, loadCards]);

  const currentCard = dueCards[currentIndex] ?? null;

  useEffect(() => {
    if (!currentCard) {
      setBlockContent("");
      setChildBlocks([]);
      return;
    }
    (async () => {
      try {
        // Find the block to get its content and page context
        const results = await api.search(currentCard.block_id, 1);
        if (results.length > 0) {
          setBlockContent(results[0].content);
          // Try to load child blocks (for basic card answer)
          const pageTree = await api.getPageTree(results[0].page_id);
          const children = pageTree.blocks.filter(
            (b) => b.parent_id === currentCard.block_id
          );
          setChildBlocks(children);
        } else {
          // Fallback: try running a query to get the block directly
          const qr = await api.runQuery(
            `SELECT content, page_id FROM blocks WHERE id = '${currentCard.block_id}'`
          );
          if (qr.rows.length > 0) {
            setBlockContent(qr.rows[0].content as string);
            const pageId = qr.rows[0].page_id as string;
            const pageTree = await api.getPageTree(pageId);
            const children = pageTree.blocks.filter(
              (b) => b.parent_id === currentCard.block_id
            );
            setChildBlocks(children);
          } else {
            setBlockContent("[Block not found]");
            setChildBlocks([]);
          }
        }
      } catch (e) {
        console.error("Failed to load block content:", e);
        setBlockContent("[Error loading content]");
        setChildBlocks([]);
      }
    })();
  }, [currentCard]);

  const handleRate = useCallback(
    async (rating: string) => {
      if (!currentCard) return;
      try {
        await api.reviewCard(currentCard.id, rating);
        setReviewedCount((c) => c + 1);

        // Move to next card
        const nextIndex = currentIndex + 1;
        if (nextIndex < dueCards.length) {
          setCurrentIndex(nextIndex);
          setShowAnswer(false);
        } else {
          // Reload to check for any new due cards
          const cards = await api.getDueCards(100);
          if (cards.length > 0) {
            setDueCards(cards);
            setCurrentIndex(0);
            setShowAnswer(false);
          } else {
            setDueCards([]);
            setCurrentIndex(0);
          }
        }
        const s = await api.getSrsStats();
        setStats(s);
      } catch (e) {
        console.error("Failed to review card:", e);
      }
    },
    [currentCard, currentIndex, dueCards.length]
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (!showAnswer && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setShowAnswer(true);
        return;
      }
      if (showAnswer) {
        if (e.key === "1") handleRate("again");
        else if (e.key === "2") handleRate("hard");
        else if (e.key === "3") handleRate("good");
        else if (e.key === "4") handleRate("easy");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, showAnswer, handleRate, onClose]);

  if (!open) return null;

  const progressPct =
    totalDue > 0 ? Math.round((reviewedCount / totalDue) * 100) : 0;

  return (
    <div className="review-overlay" onClick={onClose}>
      <div className="review-panel" onClick={(e) => e.stopPropagation()}>
        <div className="review-header">
          <span className="review-title">Flashcard Review</span>
          <div className="review-header-stats">
            {stats && (
              <span className="review-stat">
                {stats.due_count} due / {stats.reviewed_today} today /{" "}
                {stats.total_cards} total
              </span>
            )}
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Esc
          </button>
        </div>

        <div className="review-progress">
          <div
            className="review-progress-bar"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="review-progress-label">
          {reviewedCount} / {totalDue} reviewed
        </div>

        {!currentCard ? (
          <div className="review-done">
            <h3>All caught up!</h3>
            <p>No cards due for review right now.</p>
            {stats && stats.total_cards === 0 && (
              <p className="review-hint">
                Create flashcards from blocks to start reviewing.
              </p>
            )}
          </div>
        ) : (
          <div className="review-card-area">
            <div className="review-card-meta">
              <span className="review-card-type">{currentCard.card_type}</span>
              <span className="review-card-state">{currentCard.state}</span>
              {currentCard.reps > 0 && (
                <span className="review-card-reps">
                  {currentCard.reps} reps
                </span>
              )}
            </div>

            <div className="review-card-front">
              <div className="review-card-content">{blockContent}</div>
            </div>

            {showAnswer ? (
              <>
                <div className="review-card-back">
                  {childBlocks.length > 0 ? (
                    childBlocks.map((b) => (
                      <div key={b.id} className="review-answer-block">
                        {b.content}
                      </div>
                    ))
                  ) : (
                    <div className="review-answer-block review-answer-self">
                      (No child blocks -- this block is the answer)
                    </div>
                  )}
                </div>

                <div className="review-actions">
                  <button
                    className="btn review-btn review-btn-again"
                    onClick={() => handleRate("again")}
                  >
                    Again <span className="shortcut-hint">1</span>
                  </button>
                  <button
                    className="btn review-btn review-btn-hard"
                    onClick={() => handleRate("hard")}
                  >
                    Hard <span className="shortcut-hint">2</span>
                  </button>
                  <button
                    className="btn review-btn review-btn-good"
                    onClick={() => handleRate("good")}
                  >
                    Good <span className="shortcut-hint">3</span>
                  </button>
                  <button
                    className="btn review-btn review-btn-easy"
                    onClick={() => handleRate("easy")}
                  >
                    Easy <span className="shortcut-hint">4</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="review-actions">
                <button
                  className="btn btn-primary review-show-btn"
                  onClick={() => setShowAnswer(true)}
                >
                  Show Answer{" "}
                  <span className="shortcut-hint">Space</span>
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
