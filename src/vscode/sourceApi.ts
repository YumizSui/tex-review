import { FileRenames, RenameRequest, validateRenameRequest } from './fileRenames';
import { sourceRevision } from '../core/sourceSnapshots';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { CommentMutations } from './commentMutations';
import { SourceTransactions } from './sourceTransactions';
import { ReviewService } from './reviewService';
import { sourceText } from '../core/commentAnchors';
import { ChangeSet } from '@codemirror/state';
import { assertSourceSaveStable, SourceSavePolicy } from '../core/sourceSavePolicy';
import { workspaceFile, rejectSymlink } from '../core/safePaths';
import { ApiLimits, ApiResponse, SourceApiRuntime } from './sourceApiRuntime';
/** Same-user local IPC. No TCP listener, web server, remote service, or TeX execution. */
export async function startSourceApi(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, service: ReviewService, limits: Partial<ApiLimits> = {}) {
    const root = folder.uri.fsPath;
    const output = vscode.window.createOutputChannel('TeX Review API');
    const runtime = new SourceApiRuntime(() => service.transactionPending, line => output.appendLine(line), limits);
    context.subscriptions.push(output);
    const document = (file: string) => runtime.step('document.open',
        () => vscode.workspace.openTextDocument(vscode.Uri.file(workspaceFile(root, file))), { document: true });
    const savePolicy = (doc: vscode.TextDocument): SourceSavePolicy => {
        const config = vscode.workspace.getConfiguration('files', doc);
        return { trimTrailingWhitespace: config.get<boolean>('trimTrailingWhitespace'),
            insertFinalNewline: config.get<boolean>('insertFinalNewline'), trimFinalNewlines: config.get<boolean>('trimFinalNewlines') };
    };
    const transactions = new SourceTransactions(root, service, {
        async read(file) { const doc = await document(file); return { text: doc.getText(), dirty: doc.isDirty, version: doc.version, savePolicy: savePolicy(doc) }; },
        async apply(file, before, version, edits) {
            const doc = await document(file);
            if (doc.version !== version || sourceText(doc.getText()).toString() !== before || doc.isDirty)
                return false;
            const text = sourceText(before), edit = new vscode.WorkspaceEdit();
            assertSourceSaveStable(ChangeSet.of(edits.map(e => ({ from: e.from, to: e.to, insert: e.text })), text.length).apply(text).toString(), savePolicy(doc));
            const position = (offset: number) => { const line = text.lineAt(offset); return new vscode.Position(line.number - 1, offset - line.from); };
            for (const change of edits)
                edit.replace(doc.uri, new vscode.Range(position(change.from), position(change.to)), change.text);
            return runtime.step('editor.apply', () => vscode.workspace.applyEdit(edit), { mutation: true });
        },
        async save(file) {
            const doc = await document(file);
            assertSourceSaveStable(sourceText(doc.getText()).toString(), savePolicy(doc));
            return runtime.step('editor.save', () => doc.save(), { mutation: true });
        },
    });
    const renames = new FileRenames(root,service);
    const comments = new CommentMutations(root, service, transactions);
    const session = randomUUID();
    const socketDirectory = process.platform === 'win32' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\tex-review-${session}` : path.join(socketDirectory!, 'api.sock');
    const recover = async () => {
        const renamed = await runtime.step('rename.recover', () => renames.recover());
        const result = await runtime.step('source.recover', () => transactions.recover()) || renamed;
        runtime.startupFinished(true);
        return result;
    };
    context.subscriptions.push(vscode.commands.registerCommand('texReview.recoverTransaction', () => {
        return runtime.submit({ op: 'recover' }, recover).then(response => {
            if (!response.ok) throw new Error(response.error);
            return response.result;
        });
    }));
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        const disconnected = new AbortController();
        socket.on('close', () => { sockets.delete(socket); disconnected.abort(); });
        socket.on('error', () => { });
        socket.setTimeout(30000, () => socket.destroy());
        let buffer = Buffer.alloc(0), received = false;
        socket.on('data', chunk => {
            if (received)
                return;
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length > 8000000) {
                socket.destroy();
                return;
            }
            const end = buffer.indexOf(10);
            if (end < 0)
                return;
            received = true;
            const reply = (response: ApiResponse) => {
                if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify(response) + '\n');
            };
            // Keep reading so a disconnected client is observed while its request is queued.
            void (async () => {
                try {
                    const request = JSON.parse(buffer.subarray(0, end).toString('utf8'));
                    if (request.session !== session)
                        throw new Error('Stale API session. Read .review/api.json again.');
                    if (request.op === 'status') {
                        reply({ ok: true, result: { session, ...runtime.status() } });
                        return;
                    }
                    const response = await runtime.submit({ op: request.op,
                        file: request.file ?? request.transaction?.file ?? request.rename?.file ?? request.comment?.file }, async () => {
                        let result;
                        if (request.op === 'read')
                            result = await transactions.read(request.file);
                        else if (request.op === 'transact')
                            result = await transactions.transact(request.transaction);
                        else if (request.op === 'rename') {
                            const r=request.rename as RenameRequest;
                            validateRenameRequest(r);
                            if ([r.file,r.toFile].some(f=>f.split('/').some(part=>part==='.review'||part==='.git'))) throw new Error('Cannot rename review or Git storage.');
                            const digest=sourceRevision(JSON.stringify(r));
                            await recover();
                            if (renames.receipt(r.id,digest)) result={id:r.id,file:r.toFile,committed:true};
                            else {
                                const current=await transactions.read(r.file);
                                const destination=workspaceFile(root,r.toFile);
                                if (current.dirty || current.revision!==r.revision || current.reviewRevision!==r.reviewRevision) throw new Error('Revision conflict or unsaved source. Save and read again before renaming.');
                                if (fs.existsSync(destination) || !fs.statSync(path.dirname(destination)).isDirectory()) throw new Error('Choose a new filename in an existing destination folder.');
                                if (r.dryRun) { renames.stage([{from:r.file,to:r.toFile}],r.id,digest,false,true); result={id:r.id,file:r.toFile,validated:true,committed:false}; }
                                else {
                                    renames.stage([{from:r.file,to:r.toFile}],r.id,digest);
                                    const edit=new vscode.WorkspaceEdit();
                                    edit.renameFile(vscode.Uri.file(workspaceFile(root,r.file)),vscode.Uri.file(destination),{overwrite:false});
                                    try { if (!await runtime.step('editor.rename', () => vscode.workspace.applyEdit(edit), { mutation: true })) throw new Error('Editor rejected the file rename.'); }
                                    catch (error) { renames.recover(); throw error; }
                                    const outcome=renames.recover();
                                    if (outcome.committed===false) throw new Error('File rename was not applied.');
                                    result={id:r.id,file:r.toFile,committed:true};
                                }
                            }
                        }
                        else if (request.op === 'comment')
                            result = await comments.mutate(request.comment);
                        else if (request.op === 'recover')
                            result = await recover();
                        else
                            throw new Error('Unknown operation. Use status, read, transact, comment, rename, or recover.');
                        return result;
                    }, disconnected.signal);
                    reply(response);
                }
                catch (error) {
                    reply({ ok: false, error: String(error instanceof Error ? error.message : error), missing: (error as {
                            missing?: unknown;
                        }).missing, recoveryRequired: service.transactionPending });
                }
            })().catch(error => console.error('[TeX Review] Source API failed:', error));
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(); }); });
    if (process.platform !== 'win32')
        fs.chmodSync(endpoint, 0o600);
    const descriptor = workspaceFile(root, '.review/api.json');
    rejectSymlink(path.dirname(descriptor));
    rejectSymlink(descriptor);
    const temporary = descriptor + '.' + session + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ protocol: 1, capabilities: ['status', 'read', 'transact', 'comment', 'comment.create', 'comment.move', 'rename', 'recover'], session, endpoint, cli: path.join(context.extensionUri.fsPath, 'bin/tex-review.mjs') }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, descriptor);
    context.subscriptions.push({ dispose() {
            runtime.dispose();
            for (const socket of sockets)
                socket.destroy();
            server.close(() => { if (socketDirectory)
                try {
                    fs.rmdirSync(socketDirectory);
                }
                catch { } });
            try {
                if (JSON.parse(fs.readFileSync(descriptor, 'utf8')).session === session)
                    fs.unlinkSync(descriptor);
            }
            catch { }
        } });
    // Publish diagnostics before startup recovery can wait on an editor RPC.
    void runtime.submit({ op: 'startup.recover' }, async () => {
        try { const result = await recover(); runtime.startupFinished(true); return result; }
        catch (error) { runtime.startupFinished(false); throw error; }
    }).then(response => {
        if (!response.ok) void vscode.window.showErrorMessage(`TeX Review: ${response.error}`);
    });
}
