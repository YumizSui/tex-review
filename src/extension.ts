import { parseCommentLink } from './core/commentLinks';
import { startSourceApi } from './vscode/sourceApi';
import { trackSources } from './vscode/sourceTracking';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'node:fs';
import { projectTargets } from './core/projectTargets';
import { ReviewService } from './vscode/reviewService';
import { ReviewEditor } from './vscode/reviewEditor';

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) {
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => initialize(context)));
    return;
  }
  initialize(context);
}
function initialize(context: vscode.ExtensionContext): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return;
  const service = new ReviewService(path.join(folder.uri.fsPath, '.review'));
  trackSources(context, folder, service);
  let apiStarted = false;
  const ensureApi = () => {
    if (apiStarted || !(fs.existsSync(path.join(folder.uri.fsPath, '.review')) || projectTargets(folder.uri.fsPath).length || vscode.workspace.textDocuments.some(doc => doc.uri.fsPath.endsWith('.tex')))) return;
    apiStarted = true;
    void startSourceApi(context, folder, service).catch(error => { apiStarted = false; console.error('[TeX Review] Source API:', error); void vscode.window.showErrorMessage(`TeX Review: ${String(error)}`); });
  };
  ensureApi();
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => { if (doc.uri.fsPath.endsWith('.tex')) ensureApi(); }));
  const editor = new ReviewEditor(context, folder, service);
  context.subscriptions.push(vscode.window.registerUriHandler({async handleUri(uri) {
    try {
      const target = parseCommentLink(uri);
      if (fs.realpathSync(target.workspace) !== fs.realpathSync(folder.uri.fsPath)) throw new Error(vscode.l10n.t('Open the comment link in its original workspace.'));
      await editor.openThread(target.review,target.thread);
    } catch(error) { void vscode.window.showErrorMessage(`TeX Review: ${String(error)}`); }
  }}));
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(ReviewEditor.viewType, editor,
    { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('texReview.session', { deserializeWebviewPanel: (panel, state) => editor.restore(panel, state) }));
  const register = (id: string, fn: () => unknown) => context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      try { await fn(); } catch (err) { vscode.window.showErrorMessage(`TeX Review: ${String(err)}`); }
    }),
  );
  register('texReview.open', () => editor.open());
  register('texReview.addComment', () => editor.open(true));
}
export function deactivate(): void {}
