import { describe, it, expect } from 'vitest';
import { sourceText } from '../../src/core/commentAnchors';
import { followDraftTarget } from '../../src/core/draftTarget';

const draft = (text: string, quote = 'target') => ({ from: text.indexOf(quote), to: text.indexOf(quote) + quote.length, snapshot: quote, status: 'attached' as const });
describe('unsent comment target follows unambiguous external changes', () => {
  it('keeps a target between two independent external edits', () => {
    const before = 'before\ntarget\nafter', after = 'prefix\nbefore\ntarget\nafter\nsuffix';
    const result = followDraftTarget(sourceText(before), sourceText(after), draft(before));
    expect(result.status).toBe('attached'); expect(after.slice(result.from, result.to)).toBe('target');
  });
  it('follows a uniquely moved passage', () => {
    const before = 'first\ntarget\nlast', after = 'first\nlast\ntarget';
    const result = followDraftTarget(sourceText(before), sourceText(after), draft(before));
    expect(result).toEqual({ from: 11, to: 17, status: 'attached' });
  });
  it('does not guess if the target changed or duplicate passages become ambiguous', () => {
    const before = 'first\ntarget\nlast';
    expect(followDraftTarget(sourceText(before), sourceText('first\nrewritten\nlast'), draft(before)).status).not.toBe('attached');
    const repeated = 'target\ntarget';
    expect(followDraftTarget(sourceText(repeated), sourceText('target'), draft(repeated)).status).not.toBe('attached');
  });
});
