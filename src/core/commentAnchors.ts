import { ChangeSet, Text } from '@codemirror/state';
import { diff } from '@codemirror/merge';
import { LineRange } from './types';
export type AnchorStatus = 'attached' | 'deleted' | 'uncertain';
export interface PositionAnchor { from: number; to: number; status: AnchorStatus }
export interface VersionedAnchor extends PositionAnchor { revision: string }
export const sourceText = (text: string) => Text.of(text.replace(/\r\n/g, '\n').split('\n'));
export function offsets(text: Text, range: LineRange): PositionAnchor {
  const start = text.line(Math.max(1, Math.min(text.lines, range.startLine)));
  const end = text.line(Math.max(1, Math.min(text.lines, range.endLine)));
  const from = Math.min(start.to, start.from + Math.max(0, (range.startColumn ?? 1) - 1));
  return { from, to: Math.max(from, range.endColumn === undefined ? end.to : Math.min(end.to, end.from + range.endColumn - 1)), status: 'attached' };
}
export function lineRange(text: Text, anchor: PositionAnchor): LineRange {
  const from = Math.max(0, Math.min(text.length, anchor.from)), to = Math.max(from, Math.min(text.length, anchor.to));
  const a = text.lineAt(from), b = text.lineAt(to);
  return { startLine: a.number, startColumn: from - a.from + 1, endLine: b.number, endColumn: to - b.from + 1 };
}
export function mapAnchor(anchor: PositionAnchor, changes: ChangeSet, inferred = false): PositionAnchor {
  let status = anchor.status;
  changes.iterChangedRanges((a, b) => {
    if (a < anchor.to && b > anchor.from && (inferred || a < anchor.from || b > anchor.to)) status = 'uncertain';
  }, true);
  const from = changes.mapPos(anchor.from, anchor.from === anchor.to ? -1 : 1);
  const to = Math.max(from, changes.mapPos(anchor.to, anchor.from === anchor.to ? 1 : -1));
  if (from === to && anchor.from !== anchor.to) status = 'deleted';
  return { from, to, status };
}
export function sourceChanges(before: Text, after: Text): ChangeSet {
  const a = before.toString(), b = after.toString();
  return ChangeSet.of(diff(a, b, { scanLimit: 5000, timeout: 100 }).map(c => ({ from: c.fromA, to: c.toA, insert: b.slice(c.fromB, c.toB) })), before.length);
}
export function migrateAnchor(text: Text, range: LineRange, quote: string): PositionAnchor {
  const value = text.toString(), needle = quote.replace(/\r\n/g, '\n');
  const matches: number[] = [];
  for (let pos = needle ? value.indexOf(needle) : -1; pos >= 0; pos = value.indexOf(needle, pos + 1)) {
    if (range.startColumn !== undefined || ((pos === 0 || value[pos - 1] === '\n') && (pos + needle.length === value.length || value[pos + needle.length] === '\n'))) matches.push(pos);
    if (matches.length > 1) break;
  }
  return matches.length === 1 ? { from: matches[0], to: matches[0] + needle.length, status: 'attached' } : { ...offsets(text, range), status: 'uncertain' };
}
export function rebaseAnchor(anchor: PositionAnchor, before: Text, after: Text, changes = sourceChanges(before, after)): PositionAnchor {
  const result = mapAnchor(anchor, changes, true);
  const quote = before.sliceString(anchor.from, anchor.to);
  // A diff cannot identify which identical occurrence survived an offline edit.
  const repeated = (text: string) => { const at = text.indexOf(quote); return at >= 0 && text.indexOf(quote, at + 1) >= 0; };
  if (quote && (repeated(before.toString()) || repeated(after.toString()))) result.status = 'uncertain';
  return result;
}
