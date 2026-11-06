import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';
import * as assert from 'node:assert/strict';
import { startSourceApi } from '../../src/vscode/sourceApi';
import { ReviewService } from '../../src/vscode/reviewService';

/** Run with --extensionTestsPath in a disposable tex-save-runtime-qa workspace. */
export async function run() {
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    assert.ok(path.basename(root).startsWith('tex-save-runtime-qa'));
    const subscriptions: vscode.Disposable[] = [];
    const report: Record<string, unknown> = { host: vscode.version };
    try {
        const file = 'main.md', initial = 'header \nold target\nend\n';
        fs.writeFileSync(path.join(root, file), initial);
        const service = new ReviewService(path.join(root, '.review'));
        service.createReview('runtime');
        service.apply({ op: 'add_thread', id: 't1', file, range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 11 },
            snapshot: 'old target', author: 'fixture', body: 'Revise target.', ts: new Date().toISOString() });
        fs.writeFileSync(path.join(root, 'draft.txt'), 'unsent');
        const draft = await vscode.workspace.openTextDocument(path.join(root, 'draft.txt'));
        const edit = new vscode.WorkspaceEdit(); edit.insert(draft.uri, new vscode.Position(0, 6), ' user input');
        assert.ok(await vscode.workspace.applyEdit(edit));
        await vscode.window.showTextDocument(draft);
        await startSourceApi({ subscriptions, extensionUri: vscode.Uri.file(root) } as vscode.ExtensionContext,
            vscode.workspace.workspaceFolders![0], service);
        const descriptor = JSON.parse(fs.readFileSync(path.join(root, '.review/api.json'), 'utf8'));
        const request = (data: object): Promise<any> => new Promise((resolve, reject) => {
            const socket = net.createConnection(descriptor.endpoint); let buffer = '';
            socket.setEncoding('utf8'); socket.setTimeout(10000, () => socket.destroy(new Error('Runtime API timeout')));
            socket.on('connect', () => socket.write(JSON.stringify({ session: descriptor.session, ...data }) + '\n'));
            socket.on('error', reject);
            socket.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) { resolve(JSON.parse(buffer)); socket.destroy(); } });
        });
        let current = (await request({ op: 'read', file })).result;
        const transaction = { id: 'native_save_conflict', file, revision: current.revision, reviewRevision: current.reviewRevision,
            edits: [{ from: 8, to: 18, before: 'old target', text: 'new target' }],
            anchors: [{ review: 'runtime', thread: 't1', from: 8, to: 18, quote: 'new target' }] };
        for (const dryRun of [true, false]) {
            const response = await request({ op: 'transact', transaction: { ...transaction, dryRun } });
            assert.equal(response.code, 'SAVE_WOULD_CHANGE_SOURCE'); assert.equal(response.recoveryRequired, false);
        }
        assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), initial);
        assert.equal((await vscode.workspace.openTextDocument(path.join(root, file))).isDirty, false);
        assert.equal(fs.existsSync(path.join(root, '.review/transactions/pending.json')), false);
        const reply = await request({ op: 'comment', comment: { id: 'native_reply_after_rejection', file, review: 'runtime', thread: 't1',
            action: 'reply', body: 'API remains usable.', reviewRevision: current.reviewRevision } });
        assert.equal(reply.result.committed, true); report.preflightAndReply = true;

        current = (await request({ op: 'read', file })).result;
        const committed = await request({ op: 'transact', transaction: { ...transaction, id: 'native_explicit_cleanup',
            revision: current.revision, reviewRevision: current.reviewRevision,
            edits: [{ from: 6, to: 7, before: ' ', text: '' }, ...transaction.edits],
            anchors: [{ review: 'runtime', thread: 't1', from: 7, to: 17, quote: 'new target' }] } });
        assert.equal(committed.result.committed, true);
        current = (await request({ op: 'read', file })).result;
        assert.equal(current.text, 'header\nnew target\nend\n'); assert.equal(current.dirty, false);
        assert.equal(current.threads[0].currentQuote, 'new target');
        assert.equal(current.threads[0].anchor.from, 7); assert.equal(current.threads[0].anchor.revision, committed.result.revision);
        assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), current.text);
        report.explicitCleanupAndAnchors = true;

        fs.writeFileSync(path.join(root, 'tail.md'), 'old target');
        for (const [i, text] of ['new target', 'new target\n\n', 'new target\n'].entries()) {
            const read = (await request({ op: 'read', file: 'tail.md' })).result;
            const response = await request({ op: 'transact', transaction: { id: 'native_final_newline_' + i, file: 'tail.md',
                revision: read.revision, reviewRevision: read.reviewRevision,
                edits: [{ from: 0, to: 10, before: 'old target', text }], anchors: [] } });
            assert.equal(i < 2 ? response.code : response.result.committed, i < 2 ? 'SAVE_WOULD_CHANGE_SOURCE' : true);
        }
        report.finalNewlinePolicies = true;

        // The launch fixture disables trailing-space trimming for plaintext only.
        fs.writeFileSync(path.join(root, 'keep.txt'), 'old target\n');
        const keep = (await request({ op: 'read', file: 'keep.txt' })).result;
        const kept = await request({ op: 'transact', transaction: { id: 'native_language_override', file: 'keep.txt',
            revision: keep.revision, reviewRevision: keep.reviewRevision,
            edits: [{ from: 0, to: 10, before: 'old target', text: 'new target  ' }], anchors: [] } });
        assert.equal(kept.result.committed, true);
        assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'new target  \n'); report.languageOverride = true;
        assert.equal(draft.isDirty, true); assert.equal(draft.getText(), 'unsent user input');
        assert.equal(fs.readFileSync(draft.uri.fsPath, 'utf8'), 'unsent');
        assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), draft.uri.toString());
        report.unsentInputAndFocusPreserved = true;
        report.status = 'PASS';
    } catch (error) { report.status = 'FAIL'; report.error = String(error); throw error; }
    finally {
        fs.writeFileSync(path.join(root, 'save-runtime-result.json'), JSON.stringify(report, null, 2));
        for (const item of subscriptions.reverse()) item.dispose();
    }
}
