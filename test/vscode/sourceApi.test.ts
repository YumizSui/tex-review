import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startSourceApi } from '../../src/vscode/sourceApi';
import { ReviewService } from '../../src/vscode/reviewService';
import { SourceTransactions } from '../../src/vscode/sourceTransactions';
import { readLog } from '../../src/core/storage';

const editor = vi.hoisted(() => ({ open: vi.fn(), apply: vi.fn(), lines: [] as string[], commands: new Map<string, () => unknown>(), settings: {} as Record<string, boolean> }));
vi.mock('vscode', () => ({
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    WorkspaceEdit: class {
        changes: unknown[] = [];
        replace(uri: unknown, range: unknown, text: string) { this.changes.push({ uri, range, text }); }
        renameFile(from: unknown, to: unknown) { this.changes.push({ from, to }); }
    },
    workspace: { openTextDocument: editor.open, applyEdit: editor.apply,
        getConfiguration: (_section: string, _scope: unknown) => ({ get: (key: string) => editor.settings[key] }) },
    commands: { registerCommand: (name: string, fn: () => unknown) => { editor.commands.set(name, fn); return { dispose() {} }; } },
    window: { createOutputChannel: () => ({ appendLine: (line: string) => editor.lines.push(line), dispose() {} }), showErrorMessage: vi.fn() },
}));
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); editor.open.mockReset(); editor.apply.mockReset(); editor.lines = []; editor.commands.clear(); editor.settings = {}; });
function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    cleanups.push(release);
    return { promise, release };
}
async function until(condition: () => boolean) {
    for (let i = 0; i < 100 && !condition(); i++) await delay(10);
    expect(condition()).toBe(true);
}
async function fixture(options: { beforeStart?: (f: any) => Promise<void>; requestTimeoutMs?: number } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-api-test-'));
    const source = path.join(root, 'a.tex');
    let text = 'old target', dirty = false, version = 1, saves = 0, applies = 0;
    fs.writeFileSync(source, text);
    fs.writeFileSync(path.join(root, 'b.tex'), 'other');
    const service = new ReviewService(path.join(root, '.review'));
    service.createReview('one');
    service.apply({ op: 'add_thread', id: 't1', file: 'a.tex', range: { startLine: 1, endLine: 1 }, snapshot: text, author: 'reviewer', body: 'Please revise.', ts: '2026-11-06T00:00:00Z' }, 'one');
    const subscriptions: Array<{ dispose(): void }> = [];
    const context = { extensionUri: { fsPath: path.resolve('.') }, subscriptions };
    cleanups.push(() => { for (const item of subscriptions) item.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
    const doc = { uri: { fsPath: source }, getText: () => text, get isDirty() { return dirty; }, get version() { return version; },
        save: vi.fn(async () => { saves++; fs.writeFileSync(source, text); dirty = false; return true; }) };
    const open = async (uri: { fsPath: string }) => uri.fsPath === source ? doc : { uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8'), isDirty: false, version: 1 };
    const apply = async (edit: any) => {
        applies++;
        for (const change of edit.changes) {
            if (change.from) { fs.renameSync(change.from.fsPath, change.to.fsPath); continue; }
            text = text.slice(0, change.range.start.character) + change.text + text.slice(change.range.end.character);
        }
        dirty = true; version++;
        return true;
    };
    editor.open.mockImplementation(open);
    editor.apply.mockImplementation(apply);
    const f = { root, source, service, doc, open, apply, get text() { return text; }, get applies() { return applies; }, get saves() { return saves; } };
    await options.beforeStart?.(f);
    await startSourceApi(context as any, { uri: { fsPath: root } } as any, service, { documentTimeoutMs: 60, requestTimeoutMs: options.requestTimeoutMs ?? 400, maxQueued: 4 });
    const descriptor = JSON.parse(fs.readFileSync(path.join(root, '.review/api.json'), 'utf8'));
    function send(request: Record<string, unknown>) {
        const socket = net.createConnection(descriptor.endpoint);
        const response = new Promise<any>((resolve, reject) => {
            let data = '';
            socket.setEncoding('utf8');
            socket.on('connect', () => socket.write(JSON.stringify({ session: descriptor.session, ...request }) + '\n'));
            socket.on('data', chunk => { data += chunk; });
            socket.on('error', reject);
            socket.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
        });
        return { socket, response };
    }
    const request = (r: Record<string, unknown>) => send(r).response;
    const transaction = async () => {
        const read = (await request({ op: 'read', file: 'a.tex' })).result;
        return { id: 'transaction_api_test', file: 'a.tex', revision: read.revision, reviewRevision: read.reviewRevision,
            edits: [{ from: 0, to: 10, before: 'old target', text: 'new target with detail' }],
            anchors: [{ review: 'one', thread: 't1', from: 0, to: 22, quote: 'new target with detail' }] };
    };
    return { ...f, doc, request, send, transaction, descriptor, state: f };
}
describe('source API deadlines and diagnostics with real transaction storage', () => {
    it('reports save conflicts before editing and permits subsequent reads and replies', async () => {
        const f = await fixture(), transaction = await f.transaction();
        editor.settings.insertFinalNewline = true;
        for (const dryRun of [true, false])
            expect(await f.request({ op: 'transact', transaction: { ...transaction, dryRun } })).toMatchObject({ ok: false, code: 'SAVE_WOULD_CHANGE_SOURCE', recoveryRequired: false });
        expect(f.state.applies).toBe(0); expect(f.state.saves).toBe(0);
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(false);
        const read = (await f.request({ op: 'read', file: 'a.tex' })).result;
        expect(read.text).toBe('old target');
        expect(await f.request({ op: 'comment', comment: { id: 'reply_after_save_conflict', file: 'a.tex', review: 'one', thread: 't1',
            action: 'reply', body: 'Still usable.', reviewRevision: read.reviewRevision } })).toMatchObject({ ok: true, result: { committed: true } });
    });
    it('rechecks save settings when they change after preflight and before apply', async () => {
        const f = await fixture(), transaction = await f.transaction();
        let opened = 0;
        editor.open.mockImplementation(async uri => { if (++opened === 2) editor.settings.insertFinalNewline = true; return f.open(uri); });
        expect(await f.request({ op: 'transact', transaction })).toMatchObject({ ok: false, code: 'SAVE_WOULD_CHANGE_SOURCE', recoveryRequired: false });
        expect(f.state.applies).toBe(0); expect(f.state.saves).toBe(0);
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(false);
    });
    it('retains the exact unsaved intent if settings change after apply, then recovers safely', async () => {
        const f = await fixture(), transaction = await f.transaction();
        editor.apply.mockImplementation(async edit => { const result = await f.apply(edit); editor.settings.insertFinalNewline = true; return result; });
        expect(await f.request({ op: 'transact', transaction })).toMatchObject({ ok: false, code: 'SAVE_WOULD_CHANGE_SOURCE', recoveryRequired: true });
        expect(f.state.applies).toBe(1); expect(f.state.saves).toBe(0);
        expect(fs.readFileSync(f.source, 'utf8')).toBe('old target');
        expect(f.doc.getText()).toBe('new target with detail'); expect(f.doc.isDirty).toBe(true);
        editor.settings.insertFinalNewline = false;
        expect(await f.request({ op: 'recover' })).toMatchObject({ ok: true, result: { committed: true, recovered: true } });
        expect((await f.request({ op: 'transact', transaction })).result.committed).toBe(true);
        expect(f.state.applies).toBe(1); expect(f.state.saves).toBe(1);
    });
    it('commits source and anchors once, including a retry through the socket API', async () => {
        const f = await fixture(), transaction = await f.transaction();
        const first = await f.request({ op: 'transact', transaction });
        expect(first).toMatchObject({ ok: true, result: { committed: true } });
        expect(fs.readFileSync(f.source, 'utf8')).toBe('new target with detail');
        expect(f.service.view('one').threads[0]).toMatchObject({ snapshot: 'old target', anchor: { from: 0, to: 22, revision: first.result.revision } });
        expect((await f.request({ op: 'transact', transaction })).result).toEqual(first.result);
        expect(f.state.applies).toBe(1);
        expect(readLog(path.join(f.root, '.review'), 'one').filter(e => e.op === 'set_anchors')).toHaveLength(1);
    });
    it('answers status during a blocked open, times out that open, and unblocks read/recover', async () => {
        const f = await fixture(), blocked = gate();
        editor.open.mockImplementation(async uri => { if (uri.fsPath === f.source) await blocked.promise; return f.open(uri); });
        const read = f.request({ op: 'read', file: 'a.tex' });
        await until(() => editor.open.mock.calls.some(([uri]) => uri.fsPath === f.source));
        const status = await f.request({ op: 'status' });
        expect(status).toMatchObject({ ok: true, result: { active: { stage: 'document.open' } } });
        const following = f.request({ op: 'read', file: 'b.tex' }), recover = f.request({ op: 'recover' });
        expect(await read).toMatchObject({ ok: false, code: 'DOCUMENT_OPEN_TIMEOUT', stage: 'document.open' });
        expect(await following).toMatchObject({ ok: true, result: { text: 'other' } });
        expect(await recover).toMatchObject({ ok: true });
        blocked.release(); await delay(20);
        expect(f.state.applies).toBe(0);
        expect(editor.lines.some(line => line.includes('DOCUMENT_OPEN_TIMEOUT'))).toBe(true);
        expect(editor.lines.some(line => line.includes('old target'))).toBe(false);
    });
    it('never applies a transaction whose document acquisition timed out', async () => {
        const f = await fixture(), transaction = await f.transaction(), blocked = gate();
        editor.open.mockImplementation(async uri => { await blocked.promise; return f.open(uri); });
        expect(await f.request({ op: 'transact', transaction })).toMatchObject({ ok: false, code: 'DOCUMENT_OPEN_TIMEOUT' });
        blocked.release(); await delay(20);
        expect(f.state.applies).toBe(0);
        expect(fs.readFileSync(f.source, 'utf8')).toBe('old target');
        expect(f.service.transactionPending).toBe(false);
    });
    it('retains recovery intent when acquisition fails after staging, without applying late edits', async () => {
        const f = await fixture(), transaction = await f.transaction(), blocked = gate();
        let opens = 0;
        editor.open.mockImplementation(async uri => { if (++opens >= 2) await blocked.promise; return f.open(uri); });
        expect(await f.request({ op: 'transact', transaction })).toMatchObject({ ok: false, code: 'DOCUMENT_OPEN_TIMEOUT', recoveryRequired: true });
        expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(true);
        blocked.release(); await delay(20);
        expect(f.state.applies).toBe(0);
        editor.open.mockImplementation(f.open);
        expect(await f.request({ op: 'recover' })).toMatchObject({ ok: true, result: { committed: false, recovered: true } });
        expect(f.service.transactionPending).toBe(false);
    });
    it.each(['apply', 'save'])('keeps an unresolved %s locked after replying, then reconciles the original ID once', async stage => {
        const f = await fixture({ requestTimeoutMs: 150 }), transaction = await f.transaction(), blocked = gate();
        if (stage === 'apply') editor.apply.mockImplementation(async edit => { await blocked.promise; return f.apply(edit); });
        else {
            const save = f.doc.save.getMockImplementation()!;
            f.doc.save.mockImplementation(async () => { await blocked.promise; return save(); });
        }
        const result = await f.request({ op: 'transact', transaction });
        expect(result).toMatchObject({ ok: false, code: 'OPERATION_TIMEOUT', outcome: 'pending', stage: `editor.${stage}` });
        expect(await f.request({ op: 'status' })).toMatchObject({ ok: true, result: { state: 'stalled', active: { stage: `editor.${stage}`, mutationStarted: true } } });
        expect(await f.request({ op: 'recover' })).toMatchObject({ ok: false, code: 'OPERATION_IN_PROGRESS', outcome: 'not_started' });
        blocked.release();
        await until(() => !f.service.transactionPending);
        expect(await f.request({ op: 'transact', transaction })).toMatchObject({ ok: true, result: { committed: true } });
        expect(f.state.applies).toBe(1);
        expect(f.state.saves).toBe(1);
        expect(f.service.view('one').threads[0].anchor).toMatchObject({ from: 0, to: 22 });
        expect(readLog(path.join(f.root, '.review'), 'one').filter(e => e.op === 'set_anchors')).toHaveLength(1);
    });
    it('expires a queued update and does not execute it when the first writer settles', async () => {
        const f = await fixture({ requestTimeoutMs: 180 }), transaction = await f.transaction(), blocked = gate();
        editor.apply.mockImplementation(async edit => { await blocked.promise; return f.apply(edit); });
        const first = f.request({ op: 'transact', transaction });
        await until(() => editor.apply.mock.calls.length === 1);
        const queued = f.request({ op: 'transact', transaction: { ...transaction, id: 'different_queued_id' } });
        expect(await first).toMatchObject({ code: 'OPERATION_TIMEOUT' });
        expect(await queued).toMatchObject({ code: 'QUEUE_TIMEOUT', outcome: 'not_started' });
        blocked.release(); await until(() => !f.service.transactionPending);
        expect(f.state.applies).toBe(1);
        expect(JSON.parse(fs.readFileSync(path.join(f.root, '.review/transactions/receipts.json'), 'utf8'))).toHaveLength(1);
    });
    it('discards a disconnected queued update before running it', async () => {
        const f = await fixture(), transaction = await f.transaction(), blocked = gate();
        editor.apply.mockImplementation(async edit => { await blocked.promise; return f.apply(edit); });
        const first = f.request({ op: 'transact', transaction });
        await until(() => editor.apply.mock.calls.length === 1);
        const queued = f.send({ op: 'transact', transaction: { ...transaction, id: 'disconnected_id' } });
        void queued.response.catch(() => {});
        await until(() => editor.lines.some(line => line.includes('disconnected_id')) || editor.lines.filter(line => line.includes('accepted')).length >= 4);
        queued.socket.destroy();
        await until(() => editor.lines.some(line => line.includes('disconnected')));
        blocked.release();
        expect(await first).toMatchObject({ ok: true });
        expect(f.state.applies).toBe(1);
        expect(JSON.parse(fs.readFileSync(path.join(f.root, '.review/transactions/receipts.json'), 'utf8'))).toHaveLength(1);
    });
    it('publishes status before startup recovery can finish acquiring its document', async () => {
        const blocked = gate();
        const f = await fixture({ beforeStart: async f => {
            let applied = false;
            const access = { read: async () => ({ text: applied ? 'new' : 'old target', dirty: applied, version: 1 }),
                apply: async () => { applied = true; return true; }, save: async () => false };
            const engine = new SourceTransactions(f.root, f.service, access), read = await engine.read('a.tex');
            await expect(engine.transact({ id: 'startup_pending_id', file: 'a.tex', revision: read.revision, reviewRevision: read.reviewRevision,
                edits: [{ from: 0, to: 10, before: 'old target', text: 'new' }], anchors: [{ review: 'one', thread: 't1', from: 0, to: 3, quote: 'new' }] })).rejects.toThrow();
            expect(fs.existsSync(path.join(f.root, '.review/transactions/pending.json'))).toBe(true);
            editor.open.mockImplementation(async uri => { await blocked.promise; return f.open(uri); });
        } });
        expect(await f.request({ op: 'status' })).toMatchObject({ ok: true, result: { state: 'starting', active: { op: 'startup.recover', stage: 'document.open' } } });
        await until(() => editor.lines.some(line => line.includes('DOCUMENT_OPEN_TIMEOUT')));
        expect(await f.request({ op: 'status' })).toMatchObject({ ok: true, result: { state: 'recovery_required' } });
        blocked.release();
    });
    it('supports status through the installed-style CLI and rejects stale sessions independently', async () => {
        const f = await fixture();
        expect(await f.request({ op: 'status', session: 'stale' })).toMatchObject({ ok: false, error: expect.stringContaining('Stale API session') });
        const result = await new Promise<{ code: number | null; output: string }>(resolve => {
            const child = spawn(process.execPath, [path.resolve('bin/tex-review.mjs'), 'status'], { cwd: f.root });
            let output = ''; child.stdout.setEncoding('utf8'); child.stdout.on('data', data => output += data);
            child.on('close', code => resolve({ code, output }));
        });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.output)).toMatchObject({ ok: true, result: { session: f.descriptor.session, state: 'ready' } });
    });
});
