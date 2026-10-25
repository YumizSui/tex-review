import { describe, it, expect } from 'vitest';
import { planTransaction, reviewRevision, SourceTransaction } from '../../src/core/sourceTransaction';
import { sourceRevision } from '../../src/core/sourceSnapshots';
import { ReviewView } from '../../src/core/types';
const before = 'alpha\nold target\nomega';
const views: ReviewView[] = [{ name: 'review', version: 1, createdAt: '', threads: [{ id: 't1', file: 'a.tex', range: { startLine: 2, endLine: 2 }, snapshot: 'old target', anchor: { revision: sourceRevision(before), from: 6, to: 16, status: 'attached' }, status: 'open', createdAt: '', comments: [] }] }];
const request = (): SourceTransaction => ({ id: 'transaction_1', file: 'a.tex', revision: sourceRevision(before), reviewRevision: reviewRevision(views, 'a.tex'), edits: [{ from: 6, to: 16, before: 'old target', text: 'replacement' }], anchors: [{ review: 'review', thread: 't1', from: 6, to: 17, quote: 'replacement' }] });
describe('source and correspondence planning', () => {
    it('relocates a fully replaced passage while preserving the comment and original quote', () => {
        const plan = planTransaction(request(), before, views);
        expect(plan.after).toBe('alpha\nreplacement\nomega');
        expect(plan.events[0].event.anchors[0]).toMatchObject({ thread: 't1', from: 6, to: 17, status: 'attached' });
        expect(views[0].threads[0].snapshot).toBe('old target');
    });
    it('requires every affected comment across all reviews, including resolved threads', () => {
        const extra = structuredClone(views[0]);
        extra.name = 'second';
        extra.threads[0].status = 'resolved';
        const all = [views[0], extra];
        const input = { ...request(), reviewRevision: reviewRevision(all, 'a.tex') };
        expect(() => planTransaction(input, before, all)).toThrow('Every affected');
        try {
            planTransaction(input, before, all);
        }
        catch (error) {
            expect((error as any).missing).toEqual([{ review: 'second', thread: 't1' }]);
        }
    });
    it('rejects stale source, stale comments, wrong quotes, and overlapping edits before applying anything', () => {
        for (const change of [{ revision: 'bad' }, { reviewRevision: 'bad' }, { edits: [{ from: 6, to: 16, before: 'wrong', text: 'replacement' }] }, { anchors: [{ review: 'review', thread: 't1', from: 6, to: 17, quote: 'wrong' }] }, { edits: [{ from: 1, to: 9, before: before.slice(1, 9), text: 'a' }, { from: 8, to: 10, before: before.slice(8, 10), text: 'b' }] }])
            expect(() => planTransaction({ ...request(), ...change }, before, views)).toThrow();
    });
    it('does not guess between identical replacement passages', () => {
        const input = request();
        input.edits[0].text = 'same same';
        input.anchors[0] = { review: 'review', thread: 't1', from: 11, to: 15, quote: 'same' };
        expect(planTransaction(input, before, views).events[0].event.anchors[0]).toMatchObject({ from: 11, to: 15, status: 'attached' });
    });
    it('maps untouched comments through exact insertions and permits an explicitly chosen boundary after deletion', () => {
        const input = request();
        input.edits = [{ from: 0, to: 0, before: '', text: 'prefix\n' }];
        input.anchors = [];
        expect(planTransaction(input, before, views).events[0].event.anchors[0]).toMatchObject({ from: 13, to: 23, status: 'attached' });
        input.edits = [{ from: 6, to: 16, before: 'old target', text: '' }];
        input.anchors = [{ review: 'review', thread: 't1', from: 6, to: 6, quote: '' }];
        expect(planTransaction(input, before, views).events[0].event.anchors[0]).toMatchObject({ from: 6, to: 6, status: 'attached' });
    });
    it('uses UTF-16 offsets without splitting Japanese text or surrogate pairs', () => {
        const text = '前文😀\n対象の文章\n後文';
        const from = text.indexOf('対象'), to = from + '対象の文章'.length;
        const local = [{ ...views[0], threads: [{ ...views[0].threads[0], anchor: { revision: sourceRevision(text), from, to, status: 'attached' as const } }] }];
        const input = { ...request(), revision: sourceRevision(text), reviewRevision: reviewRevision(local, 'a.tex'), edits: [{ from, to, before: '対象の文章', text: '修正した文章😀' }], anchors: [{ review: 'review', thread: 't1', from, to: from + '修正した文章😀'.length, quote: '修正した文章😀' }] };
        expect(planTransaction(input, text, local).after).toBe('前文😀\n修正した文章😀\n後文');
    });
});
