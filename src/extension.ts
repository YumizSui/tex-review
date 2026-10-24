import { trackSources } from './vscode/sourceTracking';
import * as vscode from 'vscode';
import * as path from 'path';
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
  const editor = new ReviewEditor(context, folder, service);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(ReviewEditor.viewType, editor,
    { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  const register = (id: string, fn: () => unknown) => context.subscriptions.push(
    vscode.commands.registerCommand(id, async () => {
      try { await fn(); } catch (err) { vscode.window.showErrorMessage(`TeX Review: ${String(err)}`); }
    }),
  );
  register('texReview.open', () => editor.open());
  register('texReview.addComment', () => editor.open(true));
}
export function deactivate(): void {}
