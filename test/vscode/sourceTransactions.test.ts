import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SourceTransactions, SourceAccess } from '../../src/vscode/sourceTransactions';
import { ReviewService } from '../../src/vscode/reviewService';
import { readLog } from '../../src/core/storage';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true }); });
async function fixture(two = false, file = 'a.tex', initial = 'before\nold target\nafter') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-transaction-'));
    roots.push(root);
    const source = path.join(root, file);
    let text = initial, dirty = false, version = 1;
    fs.writeFileSync(source, text);
    const service = new ReviewService(path.join(root, '.review'));
    for (const review of two ? ['one', 'two'] : ['one']) {
        service.createReview(review);
        service.apply({ op: 'add_thread', id: 't1', file: file, range: { startLine: 2, endLine: 2 }, snapshot: 'old target', author: 'reviewer', body: 'Please revise.', ts: '2026-10-25T00:00:00Z' }, review);
    }
    const access: SourceAccess = { async read() { return { text, dirty, version }; }, async apply(_file, before, expected, edits) { if (text !== before || version !== expected)
            return false; for (const e of [...edits].reverse())
            text = text.slice(0, e.from) + e.text + text.slice(e.to); dirty = true; version++; return true; }, async save() { fs.writeFileSync(source, text); dirty = false; return true; } };
    const engine = new SourceTransactions(root, service, access), read = await engine.read(file);
    const from = text.indexOf('old target');
    const transaction = { id: 'transaction_test', file: file, revision: read.revision, reviewRevision: read.reviewRevision, edits: [{ from, to: from + 10, before: 'old target', text: 'new target with detail' }], anchors: read.threads.map(t => ({ review: t.review, thread: t.id, from, to: from + 22, quote: 'new target with detail' })) };
    return { root, source, service, engine, access, transaction };
}
describe('durable native source transactions', () => {
    it.each([
        ['before \nold target\nafter\n', { trimTrailingWhitespace: true }],
        ['before\nold target\nafter', { insertFinalNewline: true }],
        ['before\nold target\nafter\n\n', { trimFinalNewlines: true }],
    ])('rejects save-time changes before dry run or commit can lock the review', async (text, savePolicy) => {
        const f = await fixture(false, 'README.md', text), original = f.access.read;
        vi.spyOn(f.access, 'read').mockImplementation(async file => ({ ...await original(file), savePolicy }));
        const apply = vi.spyOn(f.access, 'apply'), save = vi.spyOn(f.access, 'save');
        const log = readLog(path.join(f.root, '.review'), 'one');
        for (const dryRun of [true, false]) {
            await expect(f.engine.transact({ ...f.transaction, dryRun })).rejects.toMatchObject({ code: 'SAVE_WOULD_CHANGE_SOURCE' });
            expect(f.service.transactionPending).toBe(false);
            expect(fs.readdirSync(path.join(f.root, '.review/transactions'))).toEqual([]);
            expect((await f.engine.read('README.md')).text).toBe(text);
        }
        expect(apply).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
        expect(readLog(path.join(f.root, '.review'), 'one')).toEqual(log);
        expect(fs.readFileSync(f.source, 'utf8')).toBe(text);
    });
    it('accepts explicit whitespace cleanup and its recalculated comment destination', async () => {
        const f = await fixture(false, 'README.md', 'before \nold target\nafter\n'), original = f.access.read;
        vi.spyOn(f.access, 'read').mockImplementation(async file => ({ ...await original(file), savePolicy: { trimTrailingWhitespace: true, insertFinalNewline: true } }));
        const result = await f.engine.transact({ ...f.transaction,
            edits: [{ from: 6, to: 7, before: ' ', text: '' }, ...f.transaction.edits],
            anchors: [{ review: 'one', thread: 't1', from: 7, to: 29, quote: 'new target with detail' }] });
        expect(result.committed).toBe(true);
        expect(fs.readFileSync(f.source, 'utf8')).toBe('before\nnew target with detail\nafter\n');
        expect(f.service.view('one').threads[0].anchor).toMatchObject({ from: 7, to: 29, revision: result.revision });
    });
    it('does not publish planned anchors when save leaves a different native buffer', async () => {
        const f = await fixture(), save = f.access.save;
        vi.spyOn(f.access, 'save').mockImplementation(async file => {
            await save(file);
            vi.spyOn(f.access, 'read').mockResolvedValue({ text: 'concurrent unsaved input', dirty: true, version: 9 });
            return true;
        });
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('editor differs');
        expect(f.service.transactionPending).toBe(true);
        expect(readLog(path.join(f.root, '.review'), 'one').filter(e => e.op === 'set_anchors')).toHaveLength(0);
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(true);
    });
    it('does not save over external edits while recovering an unsaved transaction', async () => {
        const f = await fixture(), save = vi.spyOn(f.access, 'save').mockResolvedValue(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('Unable to save');
        fs.writeFileSync(f.source, 'external edit after interruption'); save.mockClear();
        await expect(f.engine.recover()).rejects.toThrow('no source was overwritten');
        expect(save).not.toHaveBeenCalled();
        expect(fs.readFileSync(f.source, 'utf8')).toBe('external edit after interruption');
    });
    it('does not abort or complete recovery based on a stale clean native buffer', async () => {
        const f = await fixture(), save = vi.spyOn(f.access, 'save').mockResolvedValue(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow();
        fs.writeFileSync(f.source, 'before\nnew target with detail\nafter');
        vi.spyOn(f.access, 'read').mockResolvedValue({ text: 'before\nold target\nafter', dirty: false, version: 1 });
        save.mockClear();
        await expect(f.engine.recover()).rejects.toThrow('no source was overwritten');
        expect(save).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(true);
    });
    it.each(['a.tex', 'notes.txt', 'README.md'])('publishes %s source and explicit anchors together', async (file) => {
        const f = await fixture(false, file), old = fs.readFileSync(path.join(f.root, '.review/one.view.json'), 'utf8');
        const save = f.access.save;
        vi.spyOn(f.access, 'save').mockImplementation(async (file) => { expect(f.service.transactionPending).toBe(true); f.service.refreshAll(); expect(fs.readFileSync(path.join(f.root, '.review/one.view.json'), 'utf8')).toBe(old); return save(file); });
        const result = await f.engine.transact(f.transaction);
        expect(result.committed).toBe(true);
        expect(f.service.transactionPending).toBe(false);
        const thread = f.service.view('one').threads[0];
        expect(thread.snapshot).toBe('old target');
        expect(thread.comments[0].body).toBe('Please revise.');
        expect(thread.anchor).toMatchObject({ from: 7, to: 29, status: 'attached', revision: result.revision });
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(false);
        expect(fs.readdirSync(path.join(f.root, '.review/transactions'))).toEqual(['receipts.json']);
    });
    it('rejects missing destinations and stale revisions without editing source or appending events', async () => {
        const f = await fixture();
        const apply = vi.spyOn(f.access, 'apply'), before = fs.readFileSync(f.source, 'utf8'), logs = readLog(path.join(f.root, '.review'), 'one');
        await expect(f.engine.transact({ ...f.transaction, anchors: [] })).rejects.toThrow('Every affected');
        await expect(f.engine.transact({ ...f.transaction, revision: 'stale' })).rejects.toThrow('Revision conflict');
        expect(apply).not.toHaveBeenCalled();
        expect(fs.readFileSync(f.source, 'utf8')).toBe(before);
        expect(readLog(path.join(f.root, '.review'), 'one')).toEqual(logs);
    });
    it('validates a dry run without changing any source, log, or journal', async () => {
        const f = await fixture();
        const apply = vi.spyOn(f.access, 'apply');
        const result = await f.engine.transact({ ...f.transaction, dryRun: true });
        expect(result).toMatchObject({ committed: false, validated: true });
        expect(apply).not.toHaveBeenCalled();
        expect(fs.readdirSync(path.join(f.root, '.review/transactions'))).toEqual([]);
    });
    it('recovers a save failure using the same intent without guessing or repeating an event', async () => {
        const f = await fixture();
        const save = vi.spyOn(f.access, 'save').mockResolvedValueOnce(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('Unable to save');
        expect(f.service.transactionPending).toBe(true);
        save.mockRestore();
        expect(await f.engine.recover()).toMatchObject({ committed: true, recovered: true });
        const count = readLog(path.join(f.root, '.review'), 'one').length;
        expect(await f.engine.transact(f.transaction)).toMatchObject({ committed: true });
        expect(readLog(path.join(f.root, '.review'), 'one')).toHaveLength(count);
        await expect(f.engine.transact({ ...f.transaction, revision: 'different' })).rejects.toThrow('different request');
    });
    it('finishes a partial multi-review publication after restart, once per review', async () => {
        const f = await fixture(true), original = f.service.apply.bind(f.service);
        let count = 0;
        vi.spyOn(f.service, 'apply').mockImplementation((event, target) => { if (event.op === 'set_anchors' && ++count === 2)
            throw new Error('simulated crash'); return original(event, target); });
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('simulated crash');
        const service = new ReviewService(path.join(f.root, '.review')), engine = new SourceTransactions(f.root, service, f.access);
        expect(await engine.recover()).toMatchObject({ committed: true, recovered: true });
        for (const name of ['one', 'two']) {
            expect(service.view(name).threads[0].anchor).toMatchObject({ from: 7, to: 29, status: 'attached' });
            expect(readLog(path.join(f.root, '.review'), name).filter(e => e.op === 'set_anchors' && e.transaction === f.transaction.id)).toHaveLength(1);
        }
    });
    it('retains a conflicting recovery journal and never overwrites subsequent editing', async () => {
        const f = await fixture();
        vi.spyOn(f.access, 'save').mockResolvedValue(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow();
        vi.spyOn(f.access, 'read').mockResolvedValue({ text: 'human changes after interruption', dirty: true, version: 8 });
        await expect(f.engine.recover()).rejects.toThrow('no source was overwritten');
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(true);
    });
    it('aborts when the editor version changes before applying the planned edits', async () => {
        const f = await fixture();
        vi.spyOn(f.access, 'apply').mockResolvedValue(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('Editor revision');
        expect(f.service.transactionPending).toBe(false);
        expect(fs.readFileSync(f.source, 'utf8')).toContain('old target');
    });
    it('does not lock out human edits when the native editor rejects a raced revision', async () => {
        const f = await fixture();
        const original = f.access.read;
        let refused = false;
        vi.spyOn(f.access, 'apply').mockImplementation(async () => { refused = true; return false; });
        vi.spyOn(f.access, 'read').mockImplementation(async (file) => refused ? { text: 'concurrent human edit', dirty: true, version: 9 } : original(file));
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('Editor revision');
        expect(f.service.transactionPending).toBe(false);
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(false);
    });
    it('rejects a corrupted pending journal without modifying source or logs', async () => {
        const f = await fixture();
        vi.spyOn(f.access, 'save').mockResolvedValue(false);
        await expect(f.engine.transact(f.transaction)).rejects.toThrow();
        const journal = path.join(f.root, '.review/transactions/pending.json'), envelope = JSON.parse(fs.readFileSync(journal, 'utf8'));
        envelope.data.events[0].event.anchors[0].from = 0;
        fs.writeFileSync(journal, JSON.stringify(envelope));
        const apply = vi.spyOn(f.access, 'apply');
        await expect(f.engine.recover()).rejects.toThrow('integrity');
        expect(apply).not.toHaveBeenCalled();
    });
    it('recovers after a torn final log record without dropping the next complete anchor event', async () => {
        const f = await fixture();
        const original = f.service.apply.bind(f.service);
        let interrupted = false;
        vi.spyOn(f.service, 'apply').mockImplementation((event, target) => {
            if (event.op === 'set_anchors' && !interrupted) {
                interrupted = true;
                fs.appendFileSync(path.join(f.root, '.review/one.log.jsonl'), '{"op":"set_anchors","transaction":');
                throw new Error('interrupted append');
            }
            return original(event, target);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        await expect(f.engine.transact(f.transaction)).rejects.toThrow('interrupted append');
        expect(await f.engine.recover()).toMatchObject({ committed: true });
        expect(f.service.view('one').threads[0].anchor).toMatchObject({ from: 7, to: 29, status: 'attached' });
    });
});
