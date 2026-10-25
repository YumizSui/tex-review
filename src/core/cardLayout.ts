export interface CardMeasure { id: string; anchor: number; height: number }
/** Pin the focused card to its source. Pack preceding cards upward and following
 * cards downward, so a dense group never pushes the focused comment off its line. */
export function layoutCards(cards: CardMeasure[], focusedId: string | null, gap = 10): number[] {
  if (!cards.length) return [];
  const tops: number[] = [];
  const focused = cards.findIndex(c => c.id === focusedId);
  const pivot = focused < 0 ? 0 : focused;
  tops[pivot] = cards[pivot].anchor;
  for (let i = pivot - 1; i >= 0; i--) tops[i] = Math.min(cards[i].anchor, tops[i + 1] - gap - cards[i].height);
  for (let i = pivot + 1; i < cards.length; i++) tops[i] = Math.max(cards[i].anchor, tops[i - 1] + cards[i - 1].height + gap);
  return tops;
}

/** Reserve enough source scroll range to read the last packed card. Both inputs
 * use viewport coordinates, so the result stays fixed as the source scrolls. */
export function commentBottomPadding(cards: CardMeasure[], sourceBottom: number, gap = 10, margin = 12): number {
  if (!cards.length) return 0;
  const tops = layoutCards(cards, null, gap);
  const last = cards.length - 1;
  return Math.max(0, tops[last] + cards[last].height + margin - sourceBottom);
}

/** Interpolate adjacent source-aligned layouts instead of jumping to a new pivot.
 * Each endpoint packs the same cards without overlap, so interpolation preserves
 * spacing. Equal source positions use one representative to keep the handover
 * continuous. No scroll history is needed, including after reversing direction. */
export function layoutViewportCards(cards: CardMeasure[], focusedId: string | null, height: number, gap = 10): number[] {
  if (!cards.length) return [];
  let before = 0, after = -1;
  for (let i = 0; i < cards.length; i++) {
    if (i > 0 && cards[i].anchor === cards[i - 1].anchor) continue;
    if (cards[i].anchor <= 0) before = i;
    else { after = i; break; }
  }
  let tops = layoutCards(cards, cards[before].id, gap);
  if (after >= 0) {
    const next = layoutCards(cards, cards[after].id, gap);
    const span = cards[after].anchor - cards[before].anchor;
    const weight = span > 0 ? Math.max(0, Math.min(1, -cards[before].anchor / span)) : 0;
    tops = tops.map((top, i) => top + (next[i] - top) * weight);
  }
  const focused = cards.find(card => card.id === focusedId);
  if (focused) {
    const distance = Math.max(0, -focused.anchor - focused.height, focused.anchor - height);
    const weight = Math.max(0, 1 - distance / Math.max(1, height));
    if (weight > 0) {
      const pinned = layoutCards(cards, focused.id, gap);
      tops = tops.map((top, i) => top + (pinned[i] - top) * weight);
    }
  }
  return tops;
}
