import { FileRenames } from './fileRenames';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { ChangeSet } from '@codemirror/state';
import { sourceText } from '../core/commentAnchors';
import { ReviewService } from './reviewService';

export function trackSources(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, service: ReviewService) {
  const renames=new FileRenames(folder.uri.fsPath,service);
  const texts = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const relative = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file') return null;
    const file = path.relative(folder.uri.fsPath, uri.fsPath);
    return !file || file.startsWith('..' + path.sep) || path.isAbsolute(file) || (!/\.tex$/i.test(file) && !service.trackedFiles().includes(file)) ? null : file;
  };
  const report = (action: () => void) => { try { action(); } catch (error) { console.error('[TeX Review] Source tracking failed:', error); void vscode.window.showErrorMessage(`TeX Review: ${String(error)}`); } };
  // Watch only explicitly reviewed non-TeX files; never scan a workspace for text files.
  const textWatchers = new Map<string, vscode.FileSystemWatcher>();
  const watchReviewedText = () => {
    for (const [file,watcher] of textWatchers) if (!service.trackedFiles().includes(file)) {watcher.dispose();textWatchers.delete(file);}
    for (const file of service.trackedFiles()) {
      if (/\.tex$/i.test(file) || textWatchers.has(file)) continue;
      const target = path.join(folder.uri.fsPath, file);
      const local = (uri: vscode.Uri) => uri.scheme==='file' && !path.relative(folder.uri.fsPath,uri.fsPath).startsWith('..') ? path.relative(folder.uri.fsPath,uri.fsPath).split(path.sep).join('/') : null;
  context.subscriptions.push(vscode.workspace.onWillRenameFiles(event=>{
    const pairs=service.trackedFiles().flatMap(from=>event.files.flatMap(({oldUri,newUri})=>{
      const old=local(oldUri),next=local(newUri);
      return old && next && (from===old || from.startsWith(old+'/')) ? [{from,to:next+from.slice(old.length)}] : [];
    }));
    if (pairs.length && !renames.pendingMatches(pairs)) event.waitUntil(Promise.resolve().then(()=>{renames.stage(pairs,undefined,undefined,false,false,true);}));
  }),vscode.workspace.onDidRenameFiles(()=>report(()=>{renames.recover();watchReviewedText();})));
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(target)), path.basename(target)));
      const changed = () => report(() => service.syncDisk(file));
      context.subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
      textWatchers.set(file, watcher);
    }
  };
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => report(() => { service.refreshAll(); watchReviewedText(); }), 150); };
  const opened = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme==='file') { const candidate=path.relative(folder.uri.fsPath,doc.uri.fsPath);if(candidate&&!candidate.startsWith('..')&&!path.isAbsolute(candidate)) renames.followExternal(candidate); }
    const file = relative(doc.uri); if (!file) return;
    const text = doc.getText(); texts.set(doc.uri.toString(), text);
    service.updateDocument(file, text, undefined, doc.isDirty); refresh();
  };
  report(() => {
    renames.recover(); service.initializeAnchors(); watchReviewedText();
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
      service.updateDocument(file, doc.getText(), undefined, false); service.checkpoint(file); service.refreshAll(); watchReviewedText();
    })),
    vscode.workspace.onDidCloseTextDocument(doc => report(() => {
      const file = relative(doc.uri); if (!file) return;
      texts.delete(doc.uri.toString());
      service.updateDocument(file, doc.getText(), undefined, false); service.syncDisk(file); watchReviewedText();
    })), { dispose() { clearTimeout(timer); } });
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.tex'));
  const diskChanged = (uri: vscode.Uri) => report(() => { const file = relative(uri); if (file) { renames.followExternal(file); service.syncDisk(file); } });
  context.subscriptions.push(watcher, watcher.onDidChange(diskChanged), watcher.onDidCreate(diskChanged), watcher.onDidDelete(diskChanged));
}
