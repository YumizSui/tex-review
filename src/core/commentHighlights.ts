export type CommentHighlight = { from: number; to: number; selected: boolean };

/** Paint overlapping comments once, with the selected range taking precedence. */
export function commentHighlights(ranges: readonly CommentHighlight[]): CommentHighlight[] {
  const edges = new Map<number, [number, number]>();
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const kind = range.selected ? 1 : 0;
    for (const [position, delta] of [[range.from, 1], [range.to, -1]]) {
      const edge = edges.get(position) ?? [0, 0];
      edge[kind] += delta; edges.set(position, edge);
    }
  }
  const result: CommentHighlight[] = [];
  let normal = 0, selected = 0, previous: number | undefined;
  for (const [position, delta] of [...edges].sort((a, b) => a[0] - b[0])) {
    if (previous !== undefined && position > previous && (normal || selected)) {
      const active = selected > 0, last = result[result.length - 1];
      if (last && last.to === previous && last.selected === active) last.to = position;
      else result.push({ from: previous, to: position, selected: active });
    }
    normal += delta[0]; selected += delta[1]; previous = position;
  }
  return result;
}
