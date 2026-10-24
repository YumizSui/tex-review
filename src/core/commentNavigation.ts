/** Navigate the caller's visible threads in source order, wrapping at either end. */
export function adjacentComment(
  entries: readonly { id: string; from: number }[],
  selected: string | null,
  cursor: number,
  direction: 1 | -1,
): string | undefined {
  const ordered = [...entries].sort((a, b) => a.from - b.from);
  if (!ordered.length) return undefined;
  const current = ordered.findIndex(entry => entry.id === selected);
  if (current >= 0) return ordered[(current + direction + ordered.length) % ordered.length].id;
  const target = direction === 1
    ? ordered.find(entry => entry.from >= cursor) ?? ordered[0]
    : [...ordered].reverse().find(entry => entry.from <= cursor) ?? ordered[ordered.length - 1];
  return target.id;
}
