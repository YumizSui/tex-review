import { describe, it, expect } from 'vitest';
import { anchor } from '../../src/core/anchor';

const doc = (s: string) => s.split('\n');

describe('anchor', () => {
  it('returns exact when snapshot is unchanged at stored range', () => {
    const lines = doc('a\nb\nc\nd');
    const r = anchor(lines, { startLine: 2, endLine: 3 }, 'b\nc');
    expect(r).toEqual({ kind: 'exact', range: { startLine: 2, endLine: 3 } });
  });

  it('relocates when snapshot moved to a single new position', () => {
    const lines = doc('x\nx\na\nb\nc\nd');
    const r = anchor(lines, { startLine: 2, endLine: 3 }, 'b\nc');
    expect(r).toEqual({ kind: 'relocated', range: { startLine: 4, endLine: 5 } });
  });

  it('picks the match nearest the stored range when multiple exist', () => {
    const lines = doc('b\nc\nz\nz\nb\nc'); // 'b\nc' matches at lines 1 and 5
    const r = anchor(lines, { startLine: 4, endLine: 5 }, 'b\nc'); // stored range (line 4='z') does not match
    expect(r).toEqual({ kind: 'relocated', range: { startLine: 5, endLine: 6 } });
  });

  it('returns outdated when snapshot is gone', () => {
    const lines = doc('a\nb\nc');
    const r = anchor(lines, { startLine: 1, endLine: 1 }, 'zzz');
    expect(r).toEqual({ kind: 'outdated' });
  });

  it('handles a single-line snapshot', () => {
    const lines = doc('one\ntwo\nthree');
    const r = anchor(lines, { startLine: 2, endLine: 2 }, 'two');
    expect(r).toEqual({ kind: 'exact', range: { startLine: 2, endLine: 2 } });
  });
});
