import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChangeSet } from '@codemirror/state';
import { sourceText } from '../core/commentAnchors';
import { ReviewService } from './reviewService';

export function trackSources(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, service: ReviewService) {
  const texts = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const relative = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return null;
    const file = path.relative(folder.uri.fsPath, uri.fsPath);
    return !file || file.startsWith('..' + path.sep) || path.isAbsolute(file) || !file.endsWith('.tex') ? null : file;
  };
  const report = (action: () => void) => { try { action(); } catch (error) { console.error('[TeX Review] Source tracking failed:', error); void vscode.window.showErrorMessage(`TeX Review: ${String(error)}`); } };
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => report(() => service.refreshAll()), 150); };
  const opened = (doc: vscode.TextDocument) => {
    const file = relative(doc.uri); if (!file) return;
    const text = doc.getText(); texts.set(doc.uri.toString(), text);
    service.updateDocument(file, text, undefined, doc.isDirty); refresh();
  };
  report(() => {
    service.initializeAnchors();
    for (const doc of vscode.workspace.textDocuments) opened(doc);
    if (context.globalStorageUri) {
      const result = service.migrateLegacySnapshots(path.join(context.globalStorageUri.fsPath, 'legacy-sources'));
      if (result.removed) console.info('[TeX Review] Migrated source snapshots:', result);
    }
  });
  context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(doc => report(() => opened(doc))),
    vscode.workspace.onDidChangeTextDocument(event => report(() => {
      const file = relative(event.document.uri); if (!file) return;
      const before = texts.get(event.document.uri.toString()), after = event.document.getText();
      let changes: ChangeSet | undefined;
      if (before !== undefined) {
        const normalized = sourceText(before);
        const offset = (position: vscode.Position) => normalized.line(position.line + 1).from + position.character;
        changes = ChangeSet.of(event.contentChanges.map(c => ({ from: offset(c.range.start), to: offset(c.range.end), insert: c.text.replace(/\r\n/g, '\n') })), normalized.length);
      }
      service.updateDocument(file, after, changes, event.document.isDirty);
      texts.set(event.document.uri.toString(), after); refresh();
    })),
    vscode.workspace.onDidSaveTextDocument(doc => report(() => {
      const file = relative(doc.uri); if (!file) return;
      service.updateDocument(file, doc.getText(), undefined, false); service.checkpoint(file); service.refreshAll();
    })),
    vscode.workspace.onDidCloseTextDocument(doc => report(() => {
      const file = relative(doc.uri); if (!file) return;
      texts.delete(doc.uri.toString());
      service.updateDocument(file, doc.getText(), undefined, false); service.syncDisk(file);
    })), { dispose() { clearTimeout(timer); } });
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.tex'));
  const diskChanged = (uri: vscode.Uri) => report(() => { const file = relative(uri); if (file) service.syncDisk(file); });
  context.subscriptions.push(watcher, watcher.onDidChange(diskChanged), watcher.onDidCreate(diskChanged), watcher.onDidDelete(diskChanged));
}
