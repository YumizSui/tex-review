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

/** The source has no comments toolbar. Keep an anchor in that inset readable,
 * while allowing earlier comments to scroll away continuously above the source. */
export function commentViewportAnchor(sourceTop: number, sourceViewportTop: number, commentViewportTop: number): number {
  const y = sourceTop - sourceViewportTop;
  return y < 0 ? y : Math.max(0, y - Math.max(0, commentViewportTop - sourceViewportTop));
}

/** Extra comment-only travel exposes cards packed before a focused first-page
 * thread, even when the source itself has already reached scrollTop = 0. */
export function commentRailPosition(value: number, minimumTop: number): { sourceScrollTop: number; offset: number } {
  return { sourceScrollTop: Math.max(0, value), offset: Math.min(Math.max(0, -value), Math.max(0, -minimumTop)) };
}

/** Compute one explicit alignment; manual scrolling never calls this helper. */
export function alignCommentCard(cardTop: number, sourceY: number, viewportHeight: number): { paddingTop: number; scrollTop: number } {
  const target = Math.max(10, Math.min(Math.max(10, viewportHeight - 30), sourceY));
  const paddingTop = Math.max(10, target - cardTop);
  return { paddingTop, scrollTop: Math.max(0, cardTop + paddingTop - target) };
}

/** Source-coordinate packing is independent of the viewport: scrolling translates
 * the whole rail, without changing pivots or repacking dense groups. */
export function sourceLinkedCards(cards: CardMeasure[], focusedId: string | null, gap = 10) {
  const tops = layoutCards(cards, focusedId, gap);
  const origin = Math.min(0, (tops[0] ?? gap) - gap);
  return { origin, paddingTop: (tops[0] ?? gap) - origin,
    gaps: tops.map((top, i) => i ? top - tops[i - 1] - cards[i - 1].height : 0) };
}


/** Reveal an explicitly opened thread, keeping its header and body inside the pane.
 * Preserve source alignment whenever the card already fits. */
export function revealCommentCard(scrollTop: number, cardTop: number, cardHeight: number, viewportHeight: number, inset = 10): number {
  const readableHeight = Math.min(cardHeight, Math.max(0, viewportHeight - inset * 2));
  const minimum = Math.max(0, cardTop + readableHeight + inset - viewportHeight);
  const maximum = Math.max(minimum, cardTop - inset);
  return Math.max(minimum, Math.min(maximum, scrollTop));
}


/** Keep a surviving pivot, or use the next discussion after a removed pivot. */
export function survivingCommentAnchor(previous: readonly string[], current: readonly string[], anchor: string | null): string | null {
  if (anchor && current.includes(anchor)) return anchor;
  const at = anchor ? previous.indexOf(anchor) : -1;
  return previous.slice(at + 1).find(id => current.includes(id))
    ?? [...previous.slice(0, Math.max(0, at))].reverse().find(id => current.includes(id))
    ?? current[0] ?? null;
}

/** Fully offscreen threads have a dedicated way back into the viewport. */
export function offscreenCommentCards(cards: readonly {id: string; top: number; height: number}[], scrollTop: number, viewportHeight: number) {
  return {
    above: cards.filter(card => card.top + card.height <= scrollTop).map(card => card.id),
    below: cards.filter(card => card.top >= scrollTop + viewportHeight).map(card => card.id),
  };
}
