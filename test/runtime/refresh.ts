import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { ReviewService } from '../../src/vscode/reviewService';
import { ReviewEditor } from '../../src/vscode/reviewEditor';

export async function run() {
  const folder = vscode.workspace.workspaceFolders![0], root = folder.uri.fsPath;
  assert.ok(root.includes('tex-refresh-runtime-qa'));
  const file = path.join(root, 'main.tex'); fs.writeFileSync(file, 'original\n');
  const service = new ReviewService(path.join(root, '.review')); service.createReview('runtime');
  const doc = await vscode.workspace.openTextDocument(file);
  const messages: any[] = [], incoming = new vscode.EventEmitter<any>(), visibility = new vscode.EventEmitter<any>(), disposal = new vscode.EventEmitter<void>();
  const subscriptions: vscode.Disposable[] = [];
  const extension = vscode.extensions.getExtension('furui-local.tex-review');
  assert.ok(extension, 'Install or load the extension before running this test');
  const context = { extensionUri: extension.extensionUri, subscriptions,
    workspaceState: { get: () => undefined } } as any;
  const panel = { visible: true, active: true, webview: { options: {}, html: '', asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: async (message: any) => { messages.push(message); return true; }, onDidReceiveMessage: incoming.event },
    onDidChangeViewState: visibility.event, onDidDispose: disposal.event };
  const waitFor = async (condition: () => boolean) => {
    const until = Date.now() + 10_000;
    while (!condition()) { assert.ok(Date.now() < until, 'Timed out waiting for refresh'); await new Promise(resolve => setTimeout(resolve, 30)); }
  };
  try {
    new ReviewEditor(context, folder, service).resolveCustomTextEditor(doc, panel as any);
    incoming.fire({ type: 'ready' }); await waitFor(() => messages.some(m => m.type === 'init'));
    messages.length = 0;
    fs.writeFileSync(file, 'visible external update\n');
    await waitFor(() => doc.getText() === 'visible external update\n' && messages.some(m => m.type === 'document' && m.text === 'visible external update\n'));
    messages.length = 0;
    const replacement = path.join(root, 'replacement.tmp');
    fs.writeFileSync(replacement, 'atomic AI update\n'); fs.renameSync(replacement, file);
    await waitFor(() => doc.getText() === 'atomic AI update\n' && messages.some(m => m.type === 'document' && m.text === 'atomic AI update\n'));
    const staleVersion = doc.version, quote = doc.lineAt(0).text;
    fs.writeFileSync(file, 'prefix\n' + quote + '\n');
    await waitFor(() => doc.getText() === 'prefix\n' + quote + '\n');
    incoming.fire({ type: 'add', review: 'runtime', version: staleVersion, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: quote.length + 1 }, snapshot: quote, body: 'Comment sent across external update' });
    await waitFor(() => messages.some(m => m.type === 'commentSaved'));
    const raced = service.view('runtime').threads.find(t => t.comments[0].body === 'Comment sent across external update');
    assert.ok(raced); assert.equal(raced.range.startLine, 2);
    incoming.fire({ type: 'forward', line: 1, request: 12 });
    await waitFor(() => messages.some(m => m.type === 'syncing' && m.request === 12 && !m.busy));
    assert.ok(messages.some(m => m.type === 'syncing' && m.request === 12 && m.busy));
    assert.ok(messages.some(m => m.type === 'syncStatus' && m.message));
    panel.visible = false; panel.active = false; messages.length = 0;
    fs.writeFileSync(file, 'AI external update\n');
    await waitFor(() => doc.getText() === 'AI external update\n');
    assert.ok(!messages.some(m => m.type === 'document'), 'Hidden panels should defer rendering');
    service.apply({ op: 'add_thread', id: 'external', file: 'main.tex', range: { startLine: 1, endLine: 1 }, snapshot: 'AI external update', author: 'agent', body: 'External comment', ts: new Date().toISOString() });
    fs.writeFileSync(path.join(root, 'main.pdf'), 'external PDF fixture');
    panel.visible = true; panel.active = true; visibility.fire({ webviewPanel: panel });
    await waitFor(() => messages.some(m => m.type === 'document' && m.text === 'AI external update\n') && messages.some(m => m.type === 'review' && m.threads.some((t: any) => t.id === 'external')) && messages.some(m => m.type === 'pdf' && m.uri?.includes('main.pdf')));
    const edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'unsaved ');
    assert.ok(await vscode.workspace.applyEdit(edit)); assert.ok(doc.isDirty);
    messages.length = 0; visibility.fire({ webviewPanel: panel });
    await waitFor(() => messages.some(m => m.type === 'document' && m.text.startsWith('unsaved ')));
    assert.ok(doc.isDirty); assert.equal(fs.readFileSync(file, 'utf8'), 'AI external update\n');
    incoming.fire({ type: 'compareUnsaved', text: 'preserved typing from conflict' });
    await waitFor(() => messages.some(m => m.type === 'recoveryOpened'));
    const recovered = vscode.workspace.textDocuments.find(d => d.isUntitled && d.getText() === 'preserved typing from conflict');
    assert.ok(recovered); assert.ok(recovered.isDirty);
    assert.equal(fs.readFileSync(file, 'utf8'), 'AI external update\n');
    fs.writeFileSync(path.join(root, 'PASS.json'), JSON.stringify({ externalSource: true, visibleImmediate: true, atomicReplace: true, staleCommentRebased: true, hiddenDeferred: true, commentsAndPdfOnReturn: true, unsavedPreserved: true, nativeConflictComparison: true, syncBusyAndFailure: true }));
  } finally { disposal.fire(); for (const disposable of subscriptions) disposable.dispose(); incoming.dispose(); visibility.dispose(); disposal.dispose(); }
}
