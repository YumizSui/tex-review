import { describe, it, expect } from 'vitest';
import { textPatch } from '../../src/core/textPatch';
import { anchor } from '../../src/core/anchor';
import { parseForward, parseInverse } from '../../src/core/synctex';
describe('exact text selection and synchronization', () => {
  it.each([['本文です', '本文を修正しました'], ['abc', 'ab'], ['', '追加'], ['a😀b', 'a😀文b']])('round trips edits %s → %s', (a, b) => {
    const p = textPatch(a,b); expect(a.slice(0,p.start)+p.text+a.slice(p.end)).toBe(b);
  });
  it('tracks a selected phrase within a long Japanese line', () => {
    const result = anchor(['前置き。対象の文章。続き。'], {startLine:1,endLine:1,startColumn:5,endColumn:11}, '対象の文章');
    expect(result).toEqual({kind:'exact',range:{startLine:1,endLine:1,startColumn:5,endColumn:10}});
  });
  it('relocates a selected phrase after external edits', () => {
    const result=anchor(['追加行', '前置き。対象の文章。続き。'],{startLine:1,endLine:1,startColumn:5,endColumn:10},'対象の文章');
    expect(result.kind).toBe('relocated'); if(result.kind!=='outdated') expect(result.range.startLine).toBe(2);
  });
  it('tracks multi-line selections without requiring whole-line snapshots', () => {
    expect(anchor(['abc def','ghi jkl'], {startLine:1,endLine:2,startColumn:5,endColumn:4}, 'def\nghi')).toEqual({kind:'exact',range:{startLine:1,endLine:2,startColumn:5,endColumn:4}});
  });
  it('parses forward and inverse SyncTeX output', () => {
    expect(parseForward('SyncTeX result begin\nPage:4\nx:123.45\ny:98.2\n')).toEqual({page:4,x:123.45,y:98.2});
    expect(parseInverse('Input:/tmp/日本語/sample.tex\nLine:25\nColumn:-1\n')).toEqual({file:'/tmp/日本語/sample.tex',line:25,column:1});
    expect(parseForward('no result')).toBeNull();
  });
});
