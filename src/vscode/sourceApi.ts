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
import { workspaceFile, rejectSymlink } from '../core/safePaths';
/** Same-user local IPC. No TCP listener, web server, remote service, or TeX execution. */
export async function startSourceApi(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, service: ReviewService) {
    const root = folder.uri.fsPath;
    const document = async (file: string) => vscode.workspace.openTextDocument(vscode.Uri.file(workspaceFile(root, file)));
    const transactions = new SourceTransactions(root, service, {
        async read(file) { const doc = await document(file); return { text: doc.getText(), dirty: doc.isDirty, version: doc.version }; },
        async apply(file, before, version, edits) {
            const doc = await document(file);
            if (doc.version !== version || sourceText(doc.getText()).toString() !== before || doc.isDirty)
                return false;
            const text = sourceText(before), edit = new vscode.WorkspaceEdit();
            const position = (offset: number) => { const line = text.lineAt(offset); return new vscode.Position(line.number - 1, offset - line.from); };
            for (const change of edits)
                edit.replace(doc.uri, new vscode.Range(position(change.from), position(change.to)), change.text);
            return vscode.workspace.applyEdit(edit);
        },
        async save(file) { return (await document(file)).save(); },
    });
    const renames = new FileRenames(root,service);
    try {
        renames.recover();
        await transactions.recover();
    }
    catch (error) {
        void vscode.window.showErrorMessage(`TeX Review: ${String(error)}`);
    }
    const comments = new CommentMutations(root, service, transactions);
    const session = randomUUID();
    const socketDirectory = process.platform === 'win32' ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\tex-review-${session}` : path.join(socketDirectory!, 'api.sock');
    let queue = Promise.resolve(), disposed = false;
    context.subscriptions.push(vscode.commands.registerCommand('texReview.recoverTransaction', () => {
        const result = queue.then(() => { renames.recover(); return transactions.recover(); });
        queue = result.then(() => undefined, () => undefined);
        return result;
    }));
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
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
            socket.pause();
            queue = queue.then(async () => {
                if (disposed)
                    return;
                try {
                    const request = JSON.parse(buffer.subarray(0, end).toString('utf8'));
                    if (request.session !== session)
                        throw new Error('Stale API session. Read .review/api.json again.');
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
                        renames.recover(); await transactions.recover();
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
                                try { if (!await vscode.workspace.applyEdit(edit)) throw new Error('Editor rejected the file rename.'); }
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
                        { const renamed=renames.recover(); result = await transactions.recover() || renamed; }
                    else
                        throw new Error('Unknown operation. Use read, transact, comment, rename, or recover.');
                    socket.end(JSON.stringify({ ok: true, result }) + '\n');
                }
                catch (error) {
                    socket.end(JSON.stringify({ ok: false, error: String(error instanceof Error ? error.message : error), missing: (error as {
                            missing?: unknown;
                        }).missing, recoveryRequired: service.transactionPending }) + '\n');
                }
            }).catch(error => console.error('[TeX Review] Source API failed:', error));
        });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, () => { server.off('error', reject); resolve(); }); });
    if (process.platform !== 'win32')
        fs.chmodSync(endpoint, 0o600);
    const descriptor = workspaceFile(root, '.review/api.json');
    rejectSymlink(path.dirname(descriptor));
    rejectSymlink(descriptor);
    const temporary = descriptor + '.' + session + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ protocol: 1, capabilities: ['read', 'transact', 'comment', 'comment.create', 'comment.move', 'rename', 'recover'], session, endpoint, cli: path.join(context.extensionUri.fsPath, 'bin/tex-review.mjs') }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, descriptor);
    context.subscriptions.push({ dispose() {
            disposed = true;
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
}
