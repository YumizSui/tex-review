import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ReviewService, nowIso } from './reviewService';
import { Thread, LineRange } from '../core/types';
import { anchor } from '../core/anchor';
import { validateReviewName, workspaceFile } from '../core/safePaths';

interface Target { file: string; range: LineRange; snapshot: string }

export class ReviewPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private target?: Target;
  private editor?: vscode.TextEditor;
  private timer?: ReturnType<typeof setTimeout>;
  private marker?: vscode.TextEditorDecorationType;
  private markerSide = '';
  private lastPanelSide = 'right';
  constructor(private context: vscode.ExtensionContext, private folder: vscode.WorkspaceFolder,
    private service: ReviewService) {}

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.marker?.dispose();
    this.panel?.dispose();
  }

  open(): void {
    if (this.panel) this.panel.reveal(this.panel.viewColumn, false);
    else {
      this.attach(vscode.window.createWebviewPanel('texReview.panel', 'TeX Review',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] }));
      if (vscode.workspace.getConfiguration('texReview').get<string>('panelSide', 'right') === 'left') {
        void vscode.commands.executeCommand('workbench.action.moveActiveEditorGroupLeft');
      }
    }
    this.refresh();
  }

  restore(panel: vscode.WebviewPanel): void { this.attach(panel); this.refresh(); }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.lastPanelSide = vscode.workspace.getConfiguration('texReview').get<string>('panelSide', 'right');
    panel.webview.options = { enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; }, undefined, this.context.subscriptions);
    panel.webview.onDidReceiveMessage(async message => {
      try { await this.receive(message); }
      catch (err) {
        const error = String(err instanceof Error ? err.message : err);
        void panel.webview.postMessage({ type: 'error', error });
        vscode.window.showErrorMessage(`TeX Review: ${error}`);
      }
    }, undefined, this.context.subscriptions);
    panel.onDidChangeViewState(() => this.refresh(), undefined, this.context.subscriptions);
  }

  configurationChanged(): void {
    const side = vscode.workspace.getConfiguration('texReview').get<string>('panelSide', 'right');
    if (this.panel && side !== this.lastPanelSide) {
      this.panel.reveal(this.panel.viewColumn, false);
      void vscode.commands.executeCommand(side === 'left'
        ? 'workbench.action.moveActiveEditorGroupLeft' : 'workbench.action.moveActiveEditorGroupRight');
    }
    this.lastPanelSide = side;
    this.refresh();
  }

  capture(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.document.uri.scheme !== 'file') return;
    if (vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.toString() !== this.folder.uri.toString()) return;
    const file = path.relative(this.folder.uri.fsPath, editor.document.uri.fsPath);
    if (file.startsWith('.review' + path.sep)) return;
    workspaceFile(this.folder.uri.fsPath, file);
    this.editor = editor;
    const { start, end } = editor.selection;
    const last = end.line > start.line && end.character === 0 ? end.line - 1 : end.line;
    const range = new vscode.Range(start.line, 0, last, editor.document.lineAt(last).text.length);
    this.target = { file, range: { startLine: start.line + 1, endLine: last + 1 },
      snapshot: editor.document.getText(range).replace(/\r\n/g, '\n') };
    this.scheduleRefresh();
  }

  compose(): void {
    this.capture(vscode.window.activeTextEditor);
    if (!this.target) { vscode.window.showInformationMessage('本文でコメントする範囲を選択してください。'); return; }
    this.open();
    void this.panel?.webview.postMessage({ type: 'compose' });
  }

  async newReview(): Promise<void> {
    const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t("Review name"), value: this.service.suggestReviewName(),
      validateInput: value => { try { validateReviewName(value); return undefined; } catch (e) { return String((e as Error).message); } } });
    if (!name) return;
    if (this.service.list().includes(name)) throw new Error('同じ名前のレビューがあります。');
    this.service.createReview(name);
    this.open();
  }

  scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 120);
  }

  refresh(): void {
    if (!this.panel) return;
    try {
      const active = this.service.active();
      const view = active ? this.service.refreshView() : null;
      const threads = (view?.threads ?? []).map(t => ({ ...t, location: this.locate(t) }));
      void this.panel.webview.postMessage({ type: 'state', reviews: this.service.list(), active,
        target: this.target, threads, buttonSide: vscode.workspace.getConfiguration('texReview').get('buttonSide', 'right') });
      this.decorate(view?.threads ?? []);
    } catch (err) { void this.panel.webview.postMessage({ type: 'error', error: String(err) }); }
  }

  private locate(t: Thread) {
    const target = workspaceFile(this.folder.uri.fsPath, t.file);
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === target);
    if (!doc) return { ...t.range, outdated: false, checked: false };
    const result = anchor(doc.getText().split('\n'), t.range, t.snapshot);
    return { ...(result.kind === 'outdated' ? t.range : result.range), outdated: result.kind === 'outdated', checked: true };
  }

  private decorate(threads: Thread[]): void {
    const side = vscode.workspace.getConfiguration('texReview').get<string>('markerSide', 'left');
    if (!this.marker || side !== this.markerSide) {
      this.marker?.dispose();
      this.markerSide = side;
      this.marker = vscode.window.createTextEditorDecorationType({
        overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        backgroundColor: new vscode.ThemeColor('editor.wordHighlightBackground'),
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        ...(side === 'left' ? { gutterIconPath: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'comment.svg'), gutterIconSize: 'contain' }
          : side === 'right' ? { after: { contentText: '  ◇', color: new vscode.ThemeColor('editorInfo.foreground') } } : {}),
      });
    }
    for (const editor of vscode.window.visibleTextEditors) {
      const rel = path.relative(this.folder.uri.fsPath, editor.document.uri.fsPath);
      editor.setDecorations(this.marker, threads.filter(t => t.file === rel && t.status === 'open').flatMap(t => {
        const loc = this.locate(t);
        if (loc.outdated) return [];
        const end = Math.min(loc.endLine - 1, editor.document.lineCount - 1);
        const hover = new vscode.MarkdownString().appendText(t.comments[0]?.body ?? '');
        hover.appendMarkdown('\n\n[コメントパネルを開く](command:texReview.open)');
        hover.isTrusted = { enabledCommands: ['texReview.open'] };
        return [{ range: new vscode.Range(loc.startLine - 1, 0, end, editor.document.lineAt(end).text.length), hoverMessage: hover }];
      }));
    }
  }

  private async receive(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const m = message as Record<string, unknown>;
    if (m.type === 'ready') { this.refresh(); return; }
    if (m.type === 'newReview') { await this.newReview(); return; }
    if (m.type === 'switch') {
      if (typeof m.name !== 'string' || !this.service.list().includes(m.name)) throw new Error('Unknown review');
      this.service.setActive(m.name); this.refresh(); return;
    }
    if (m.type === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'texReview'); return;
    }
    if (m.type === 'add') {
      const selection = m.target as Target | undefined;
      if (!selection || typeof selection.file !== 'string' || typeof selection.snapshot !== 'string' ||
          !Number.isInteger(selection.range?.startLine) || !Number.isInteger(selection.range?.endLine) ||
          selection.range.startLine < 1 || selection.range.endLine < selection.range.startLine) throw new Error('Invalid selection');
      const target = workspaceFile(this.folder.uri.fsPath, selection.file);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      const located = anchor(doc.getText().split('\n'), selection.range, selection.snapshot);
      if (located.kind === 'outdated') throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
      const body = this.body(m.body);
      if (m.review !== this.service.active()) throw new Error(vscode.l10n.t("The active review changed. Please try again."));
      if (!this.service.active()) this.service.createReview(this.service.suggestReviewName());
      this.service.apply({ op: 'add_thread', id: 't_' + randomUUID(), file: selection.file,
        range: located.range, snapshot: selection.snapshot, author: 'reviewer', body, ts: nowIso() });
      void this.panel?.webview.postMessage({ type: 'saved', key: 'new' });
    } else if (['reply', 'resolve', 'reopen', 'edit', 'navigate'].includes(String(m.type))) {
      if (m.review !== this.service.active()) throw new Error(vscode.l10n.t("The active review changed. Please try again."));
      const active = this.service.active();
      const thread = active && this.service.view(active).threads.find(t => t.id === m.thread);
      if (!thread) throw new Error(vscode.l10n.t("Comment not found."));
      if (m.type === 'navigate') {
        const file = workspaceFile(this.folder.uri.fsPath, thread.file);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        const loc = this.locate(thread);
        const line = Math.max(0, Math.min(loc.startLine - 1, doc.lineCount - 1));
        const sourceColumn = this.editor?.viewColumn ?? (this.panel?.viewColumn === 1 ? 2 : 1);
        const editor = await vscode.window.showTextDocument(doc, { viewColumn: sourceColumn, preserveFocus: true });
        editor.revealRange(new vscode.Range(line, 0, Math.max(line, Math.min(loc.endLine - 1, doc.lineCount - 1)), 0),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        if (loc.outdated) vscode.window.showWarningMessage('対象の本文は変更されています。保存された引用を確認してください。');
      } else if (m.type === 'reply') {
        this.service.apply({ op: 'reply', thread: thread.id, body: this.body(m.body), author: 'reviewer', ts: nowIso() });
        void this.panel?.webview.postMessage({ type: 'saved', key: thread.id });
      } else if (m.type === 'edit') {
        const comment = thread.comments.find(c => c.id === m.comment && c.author === 'reviewer');
        if (!comment) throw new Error(vscode.l10n.t('This comment cannot be edited.'));
        this.service.apply({ op: 'edit_comment', comment: comment.id, body: this.body(m.body), ts: nowIso() });
      } else this.service.apply({ op: m.type as 'resolve' | 'reopen', thread: thread.id, ts: nowIso() });
    }
    this.refresh();
  }

  private body(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 100_000) throw new Error(vscode.l10n.t("Enter a comment (up to 100,000 characters)."));
    return value.trim();
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none';">
      <link rel="stylesheet" href="${resource('panel.css')}"></head><body>
      <header><div class="toolbar"><strong>コメント</strong><button id="settings" class="quiet">配置設定</button></div>
      <div class="toolbar"><select id="reviews" aria-label="レビュー"></select><button id="newReview" class="quiet">新しいレビュー</button></div>
      <div class="toolbar filters"><label><input type="checkbox" id="currentOnly">現在のファイルのみ</label><label><input type="checkbox" id="resolved">解決済みも表示</label></div></header>
      <section id="composer"><div id="target">本文で範囲を選択してください</div><details><summary>選択した本文</summary><pre id="snapshot"></pre></details>
      <textarea id="newBody" aria-label="新しいコメント" placeholder="選択した箇所へのコメント…" rows="3"></textarea><div class="actions"><button id="add">コメントを追加</button></div></section>
      <p id="error" role="alert"></p><main id="threads"></main>
      <script nonce="${nonce}" src="${resource('panel.js')}"></script></body></html>`;
  }
}
