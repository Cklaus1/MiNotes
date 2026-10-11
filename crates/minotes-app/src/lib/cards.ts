/**
 * Flashcards (SRS): which blocks are cards, and making / removing them.
 *
 * Convention (what ReviewPanel shows): the block itself is the QUESTION and its
 * child blocks are the ANSWER. One card per block — core `create_card` returns
 * the existing card when the block already is one.
 *
 * A small shared store so every BlockItem can show its card indicator without
 * fetching per block; anything that changes cards calls `notifyCardsChanged()`
 * (or goes through the helpers here), which also fires `minotes-cards-changed`
 * so the sidebar's due count refreshes.
 */
import { useEffect, useSyncExternalStore } from "react";
import * as api from "./api";

export const FLASHCARD_HINT = "Flashcard: this block is the question, its child blocks are the answer";

let cardByBlock = new Map<string, string>(); // block id -> card id
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
  window.dispatchEvent(new CustomEvent("minotes-cards-changed"));
}

/** Reload the block -> card map from the backend. */
export function refreshCards(): Promise<void> {
  if (loading) return loading;
  loading = api.listCards()
    .then((cards) => {
      cardByBlock = new Map(cards.map((c) => [c.block_id, c.id]));
      loaded = true;
      emit();
    })
    .catch(() => { /* backend without cards support: no indicators */ })
    .finally(() => { loading = null; });
  return loading;
}

/** Something outside this module changed cards (e.g. a review): refresh listeners. */
export function notifyCardsChanged() {
  void refreshCards();
}

export function isFlashcard(blockId: string): boolean {
  return cardByBlock.has(blockId);
}

export async function makeFlashcard(blockId: string): Promise<api.Card> {
  const card = await api.createCard(blockId, "basic");
  cardByBlock = new Map(cardByBlock).set(blockId, card.id);
  emit();
  return card;
}

export async function removeFlashcard(blockId: string): Promise<boolean> {
  if (!loaded) await refreshCards();
  const cardId = cardByBlock.get(blockId);
  if (!cardId) return false;
  const ok = await api.deleteCard(cardId);
  const next = new Map(cardByBlock);
  next.delete(blockId);
  cardByBlock = next;
  emit();
  return ok;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Re-renders when this block becomes / stops being a flashcard. */
export function useIsFlashcard(blockId: string): boolean {
  useEffect(() => {
    if (!loaded) void refreshCards();
  }, []);
  return useSyncExternalStore(subscribe, () => cardByBlock.has(blockId));
}
