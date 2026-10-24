import { describe, it, expect } from 'vitest';
import { ChangeSet } from '@codemirror/state';
import { mapAnchor, migrateAnchor, offsets, lineRange, sourceText, rebaseAnchor, sourceChanges } from '../../src/core/commentAnchors';
const attached = (from: number, to: number) => ({ from, to, status: 'attached' as const });
describe('versioned comment positions', () => {
  it('follows the actual duplicate when lines are inserted before it', () => {
    const c = ChangeSet.of({ from: 0, insert: 'same\n' }, 9);
    expect(mapAnchor(attached(5, 9), c)).toEqual(attached(10, 14));
  });
  it('keeps insertion at the boundaries outside and insertion inside within the range', () => {
    expect(mapAnchor(attached(2, 5), ChangeSet.of([{ from: 2, insert: 'X' }, { from: 5, insert: 'Y' }], 8))).toEqual(attached(3, 6));
    expect(mapAnchor(attached(2, 5), ChangeSet.of({ from: 3, insert: 'NEW' }, 8))).toEqual(attached(2, 8));
  });
  it('keeps a live replacement attached, but marks inferred replacement uncertain', () => {
    const change = ChangeSet.of({ from: 2, to: 5, insert: 'longer' }, 8);
    expect(mapAnchor(attached(2, 5), change)).toEqual(attached(2, 8));
    expect(mapAnchor(attached(2, 5), change, true).status).toBe('uncertain');
  });
  it('preserves deletion as a collapsed anchor rather than searching elsewhere', () => {
    expect(mapAnchor(attached(2, 5), ChangeSet.of({ from: 2, to: 5 }, 8))).toEqual({ from: 2, to: 2, status: 'deleted' });
  });
  it('maps independent changes without swallowing the text between them', () => {
    expect(mapAnchor(attached(4, 7), ChangeSet.of([{ from: 0, insert: 'XX' }, { from: 9, to: 10, insert: 'YY' }], 12))).toEqual(attached(6, 9));
  });
  it('derives UTF-16 columns and normalizes CRLF', () => {
    const text = sourceText('前\r\nあ😀いう\r\n末');
    const range = { startLine: 2, startColumn: 2, endLine: 2, endColumn: 5 };
    expect(lineRange(text, offsets(text, range))).toEqual(range);
  });
  it('recovers offline insertions from source revisions', () => {
    const before = sourceText('head\ntarget\nend'), after = sourceText('new\nhead\ntarget\nend!');
    expect(sourceChanges(before, after).apply(before).eq(after)).toBe(true);
    expect(rebaseAnchor(attached(5, 11), before, after)).toEqual(attached(9, 15));
  });
  it('does not guess the identity of repeated text in an offline change', () => {
    expect(rebaseAnchor(attached(5, 9), sourceText('same\nsame'), sourceText('same\nsame\nsame')).status).toBe('uncertain');
  });
  it('only migrates unversioned logs when a quote identifies one occurrence', () => {
    expect(migrateAnchor(sourceText('new\ntarget'), { startLine: 1, endLine: 1 }, 'target')).toEqual(attached(4, 10));
    expect(migrateAnchor(sourceText('same\nsame'), { startLine: 1, endLine: 1 }, 'same').status).toBe('uncertain');
  });
});
