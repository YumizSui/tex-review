import { ChangeSet } from '@codemirror/state';
import { followDraftTarget } from '../core/draftTarget';
import { sourceText, offsets, lineRange } from '../core/commentAnchors';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { ReviewService, nowIso } from './reviewService';
import { workspaceFile } from '../core/safePaths';
import { anchor } from '../core/anchor';
import { parseForward, parseInverse } from '../core/synctex';
import { texBuildPlan, previewIsCurrent, BuildMode } from '../core/texBuild';
import { pdfSyncIssue } from '../core/pdfSync';
import { projectTargets, targetPdf } from '../core/projectTargets';
import { annotatedPdf, LocatedThread } from '../core/annotatedPdf';
import { Baseline, baselineText, checkpoint, checkpoints } from '../core/baseline';
import { ActiveThemeIdentity } from '../core/activeTheme';
import { workbenchSyntax } from './nativeSyntax';
import { ReviewEvent } from '../core/types';
import { rejectSymlink } from '../core/safePaths';

const run = promisify(execFile);
export class ReviewEditor implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'texReview.editor';
  private panels = new Map<string, vscode.WebviewPanel>();
  private selections = new Map<string, { from: number; to: number; compose?: boolean }>();
  private selectedRoot?: string;
  private nativeSyntax?: ReturnType<typeof workbenchSyntax>;
  private nativeSyntaxTheme = "";
  private building = false;
  private performanceOutput?: vscode.OutputChannel;
  private performanceEntries = 0;
  private readonly comparisonChanged = new vscode.EventEmitter<void>();
  private readonly targetChanged = new vscode.EventEmitter<void>();
  constructor(private context: vscode.ExtensionContext, private folder: vscode.WorkspaceFolder, private service: ReviewService) {
    this.selectedRoot = context.workspaceState.get<string>('texReview.root');
    context.subscriptions.push(this.targetChanged, this.comparisonChanged);
  }

  private recordPerformance(message: { phase?: unknown; milliseconds?: unknown; recentPhase?: unknown }) {
    const phase = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(value);
    if (!phase(message.phase) || typeof message.milliseconds !== 'number' || !Number.isFinite(message.milliseconds) || message.milliseconds < 50) return;
    if (!this.performanceOutput) {
      this.performanceOutput = vscode.window.createOutputChannel('TeX Review Performance');
      this.context.subscriptions.push(this.performanceOutput);
    }
    if (++this.performanceEntries > 200) { this.performanceOutput.clear(); this.performanceEntries = 1; }
    this.performanceOutput.appendLine(`${new Date().toISOString()} ${message.phase}: ${message.milliseconds.toFixed(1)} ms${phase(message.recentPhase) ? ` (recent: ${message.recentPhase})` : ''}`);
  }

  async open(compose = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') return;
    const key = editor.document.uri.toString();
    const normalizedOffset = (pos: vscode.Position) => { const raw = editor.document.offsetAt(pos); return editor.document.getText ? editor.document.getText().slice(0, raw).replace(/\r\n/g, '\n').length : raw; };
    const selection = { from: normalizedOffset(editor.selection.start), to: normalizedOffset(editor.selection.end), compose };
    const existing = this.panels.get(key);
    this.selections.set(key, selection);
    await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, ReviewEditor.viewType);
    if (existing) await existing.webview.postMessage({ type: 'activateSelection', ...selection });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panels.set(document.uri.toString(), panel);
    const root = this.folder.uri.fsPath;
    const file = path.relative(root, document.uri.fsPath);
    const roots = projectTargets(root);
    if (!roots.some(t => t.root === this.selectedRoot)) this.selectedRoot = roots.find(t => t.root === file)?.root
      ?? roots.find(t => t.root === (file.includes('/ja/') ? 'main_ja.tex' : 'main.tex'))?.root ?? roots[0]?.root;
    workspaceFile(root, file);
    this.service.updateDocument(file, document.getText(), undefined, document.isDirty);
    const normalizedText = () => sourceText(document.getText());
    const documentHistory = new Map<number, string>();
    const rememberDocument = () => {
      documentHistory.set(document.version, normalizedText().toString());
      if (documentHistory.size > 100) documentHistory.delete(documentHistory.keys().next().value!);
    };
    rememberDocument();
    const nativePosition = (offset: number) => { const doc = normalizedText(), at = Math.max(0, Math.min(doc.length, offset)), line = doc.lineAt(at); return new vscode.Position(line.number - 1, at - line.from); };
    const disposables: vscode.Disposable[] = [];
    let pdfPath = this.findPdf(document);
    let syntaxTimer: ReturnType<typeof setTimeout> | undefined;
    let syntaxGeneration = 0;
    let activeTheme: ActiveThemeIdentity | undefined;
    let comparisonGeneration = 0;
    let undoDeletion: { review: string; event: ReviewEvent } | undefined;
    let applying = false;
    let disposed = false;
    let ready = false;
    let activationTimer: ReturnType<typeof setTimeout> | undefined;
    let pdfTimer: ReturnType<typeof setTimeout> | undefined;
    let sourceTimer: ReturnType<typeof setTimeout> | undefined;
    let lastComparison = "";
    let queue = Promise.resolve();
    let syncGeneration = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let lastReview = '';
    let lastSyntax: { syntax: Awaited<ReturnType<typeof workbenchSyntax>>; version: number } | undefined;
    const post = (m: unknown) => { if (!disposed) void panel.webview.postMessage(m); };
    const syntaxState = async () => {
      if (!activeTheme || disposed || !panel.visible) return;
      const generation = ++syntaxGeneration, version = document.version, text = document.getText();
      try {
        const themeKey = JSON.stringify(activeTheme);
        if (this.nativeSyntaxTheme !== themeKey) { this.nativeSyntax = undefined; this.nativeSyntaxTheme = themeKey; }
        this.nativeSyntax ??= workbenchSyntax(this.context.extensionUri.fsPath, activeTheme);
        const syntax = await this.nativeSyntax;
        if (generation !== syntaxGeneration || document.version !== version || disposed) return;
        if (lastSyntax?.syntax === syntax && lastSyntax.version === version) return;
        const started = performance.now(), tokens = syntax.tokenize(text);
        this.recordPerformance({ phase: 'source.tokenize', milliseconds: performance.now() - started });
        lastSyntax = { syntax, version }; post({ type: 'syntax', version, ...tokens });
      } catch (error) {
        console.warn('[TeX Review] Native syntax theme failed:', error);
        post({ type: 'syntaxError', error: vscode.l10n.t('Unable to load the active editor theme.') });
      }
    };
    const scheduleSyntax = () => { if (syntaxTimer) clearTimeout(syntaxTimer); syntaxTimer = setTimeout(() => { void syntaxState(); }, 100); };
    disposables.push(vscode.window.onDidChangeActiveColorTheme(() => { this.nativeSyntax = undefined; scheduleSyntax(); }));
    const postComparison = (message: object) => {
      const signature = JSON.stringify(message);
      if (signature !== lastComparison) { lastComparison = signature; post(message); }
    };
    const comparisonState = async () => {
      const generation = ++comparisonGeneration;
      const baseline = this.context.workspaceState.get<Baseline>('texReview.baseline');
      const enabled = this.context.workspaceState.get<boolean>('texReview.compareEnabled', false);
      if (!enabled || !baseline) { postComparison({ type: 'comparison', enabled: false, available: !!baseline }); return; }
      try {
        const text = await baselineText(root, file, baseline);
        if (generation !== comparisonGeneration) return;
        postComparison({ type: 'comparison', enabled: text !== null, available: true, text, label: baseline.label,
          message: text === null ? vscode.l10n.t('Choose a baseline for this file.') : undefined });
      } catch {
        if (generation === comparisonGeneration) postComparison({ type: 'comparison', enabled: false, available: true,
          message: vscode.l10n.t('Cannot read the baseline for this file. It may not exist at that checkpoint.') });
      }
    };
    disposables.push(this.comparisonChanged.event(() => { void comparisonState(); }));
    const chooseBaseline = async (kind: 'git' | 'file') => {
      let baseline: Baseline;
      if (kind === 'git') {
        const manual = { label: vscode.l10n.t('Enter commit, tag, or branch…'), revision: '', description: '' };
        let recent: Awaited<ReturnType<typeof checkpoints>>;
        try { recent = await checkpoints(root); }
        catch { throw new Error(vscode.l10n.t('No Git checkpoints found in this workspace.')); }
        const selected = await vscode.window.showQuickPick([manual, ...recent], { title: vscode.l10n.t('Compare with checkpoint'), matchOnDescription: true });
        if (!selected) return;
        const ref = selected.revision || await vscode.window.showInputBox({ title: vscode.l10n.t('Compare with checkpoint'), prompt: vscode.l10n.t('Commit ID, tag, or branch'), value: 'HEAD' });
        if (!ref) return;
        try { baseline = await checkpoint(root, ref); }
        catch { throw new Error(vscode.l10n.t('The checkpoint could not be found.')); }
      } else {
        const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { TeX: ['tex'] },
          title: vscode.l10n.t('Select baseline TeX file'), defaultUri: this.folder.uri });
        if (!selected?.[0]) return;
        if (fs.realpathSync(selected[0].fsPath) === fs.realpathSync(document.uri.fsPath)) throw new Error(vscode.l10n.t('Select a different file as the baseline.'));
        baseline = { kind: 'file', path: selected[0].fsPath, source: file, label: path.basename(selected[0].fsPath) };
      }
      // Validate before replacing the working comparison; never write the baseline.
      try { await baselineText(root, file, baseline); }
      catch { throw new Error(vscode.l10n.t('Cannot read the baseline for this file. It may not exist at that checkpoint.')); }
      await this.context.workspaceState.update('texReview.baseline', baseline);
      await this.context.workspaceState.update('texReview.compareEnabled', true);
      this.comparisonChanged.fire();
    };
    const config = () => {
      const cfg = vscode.workspace.getConfiguration('texReview');
      const editor = vscode.workspace.getConfiguration('editor', document);
      return { buildMode: cfg.get('buildMode', 'preview'), pdfSync: cfg.get('pdfSync', 'manual'), markerSide: cfg.get('markerSide', 'left'), includePdfComments: cfg.get('includePdfComments', false),
        fontSize: editor.get('fontSize', 14), fontFamily: editor.get('fontFamily', 'monospace'),
        lineHeight: editor.get('lineHeight', 0), letterSpacing: editor.get('letterSpacing', 0), fontLigatures: editor.get('fontLigatures', false),
        cursorStyle: editor.get('cursorStyle', 'line'), cursorWidth: editor.get('cursorWidth', 0), cursorBlinking: editor.get('cursorBlinking', 'blink'),
        tabSize: editor.get('tabSize', 4) };
    };
    const review = () => {
      const started = performance.now();
      const message = { type: 'review', active: this.service.active(), reviews: this.service.list(),
        threads: this.service.active() ? this.service.refreshView()?.threads : [], file, version: document.version, config: config() };
      const signature = JSON.stringify(message);
      if (signature !== lastReview) { lastReview = signature; post(message); }
      this.recordPerformance({ phase: 'comments.refresh', milliseconds: performance.now() - started });
    };
    const docState = (kind = 'document') => post({ type: kind, text: normalizedText().toString(), version: document.version });
    const pdfState = () => post({ type: 'pdf', uri: pdfPath ? panel.webview.asWebviewUri(vscode.Uri.file(pdfPath)).toString() + '?v=' + fs.statSync(pdfPath).mtimeMs : null,
      name: pdfPath ? path.relative(root, pdfPath) : null, roots: projectTargets(root).map(t => t.root), selectedRoot: this.selectedRoot });
    disposables.push(this.targetChanged.event(() => { pdfPath = this.findPdf(document); pdfState(); }));
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.folder.uri, vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview);
    const onChange = vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.toString() === document.uri.toString()) { rememberDocument(); if (ready && panel.visible) { if (!applying) { docState(); review(); } scheduleSyntax(); } }
    });
    disposables.push(onChange);
    // An exact, non-recursive watch is not subject to recursive watcher exclusions.
    const sourceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(document.uri.fsPath)), path.basename(document.uri.fsPath)));
    const sourceChanged = () => {
      clearTimeout(sourceTimer);
      sourceTimer = setTimeout(() => {
        if (disposed || !ready || !panel.visible) return;
        queue = queue.then(() => {
          if (disposed || !panel.visible) return;
          this.service.updateDocument(file, document.getText(), undefined, document.isDirty);
          docState(); review(); scheduleSyntax();
        }).catch(error => post({ type: 'error', error: String(error) }));
      }, 250);
    };
    sourceWatcher.onDidChange(sourceChanged, undefined, disposables);
    sourceWatcher.onDidCreate(sourceChanged, undefined, disposables);
    disposables.push(sourceWatcher);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(root, '.review')), '*'));
    const changed = (uri: vscode.Uri) => {
      if (!ready || !panel.visible) return;
      if (!uri.path.endsWith('.log.jsonl') && !uri.path.endsWith('/state.json')) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { try { review(); } catch (e) { post({ type: 'error', error: String(e) }); } }, 100);
    };
    watcher.onDidChange(changed, undefined, disposables); watcher.onDidCreate(changed, undefined, disposables); watcher.onDidDelete(changed, undefined, disposables);
    disposables.push(watcher, vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('texReview') || e.affectsConfiguration('editor')) review();
      if (e.affectsConfiguration('workbench') || e.affectsConfiguration('editor.tokenColorCustomizations')) { this.nativeSyntax = undefined; scheduleSyntax(); } }));
    const pdfWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.folder, '**/*.pdf'));
    const pdfChanged = (uri: vscode.Uri) => {
      if (!ready || !panel.visible || (uri.fsPath !== pdfPath && (!this.selectedRoot || path.basename(uri.fsPath) !== path.basename(this.selectedRoot, '.tex') + '.pdf'))) return;
      clearTimeout(pdfTimer);
      pdfTimer = setTimeout(() => { if (!disposed && panel.visible) { pdfPath = this.findPdf(document); pdfState(); } }, 200);
    };
    pdfWatcher.onDidChange(pdfChanged, undefined, disposables); pdfWatcher.onDidCreate(pdfChanged, undefined, disposables); pdfWatcher.onDidDelete(pdfChanged, undefined, disposables); disposables.push(pdfWatcher);
    const refreshOnReturn = () => {
      if (!ready || disposed || !panel.visible || !panel.active) return;
      clearTimeout(activationTimer);
      activationTimer = setTimeout(() => {
        queue = queue.then(async () => {
          if (disposed || !panel.visible || !panel.active) return;
          this.service.updateDocument(file, document.getText(), undefined, document.isDirty);
          docState(); review(); pdfPath = this.findPdf(document); pdfState(); scheduleSyntax();
          await comparisonState();
        }).catch(error => post({ type: 'error', error: String(error) }));
      }, 100);
    };
    disposables.push(panel.onDidChangeViewState(refreshOnReturn),
      vscode.window.onDidChangeWindowState(state => { if (state.focused) refreshOnReturn(); }));
    const validBody = (body: unknown) => { if (typeof body !== 'string' || !body.trim() || body.length > 100_000) throw new Error(vscode.l10n.t('Enter a comment (up to 100,000 characters).')); return body.trim(); };
    const canSync = () => {
      if (!pdfPath) return false;
      const sources = [document.uri.fsPath, ...(this.selectedRoot ? [workspaceFile(root, this.selectedRoot)] : [])];
      const issue = pdfSyncIssue(pdfPath, sources, document.isDirty);
      if (issue) post({ type: 'syncStatus', message: issue === 'missing'
        ? vscode.l10n.t('This PDF has no SyncTeX data. Build PDF to enable synchronization.')
        : vscode.l10n.t('The source or PDF has changed since the synchronized build. Save and build PDF again.') });
      return !issue;
    };
    const synctex = async (args: string[]) => {
      const executable = process.platform === 'darwin' && fs.existsSync('/Library/TeX/texbin/synctex') ? '/Library/TeX/texbin/synctex' : 'synctex';
      return (await run(executable, args, { cwd: root, timeout: 8000, maxBuffer: 2_000_000 })).stdout;
    };
    const exportComments = async (sourcePdf = pdfPath) => {
      if (!sourcePdf) throw new Error(vscode.l10n.t('Build or select a PDF first.'));
      const active = this.service.active();
      if (!active) throw new Error(vscode.l10n.t('No active review.'));
      const threads = this.service.view(active).threads;
      const located: LocatedThread[] = [];
      let skipped = 0;
      for (const thread of threads) {
        try {
          const source = workspaceFile(root, thread.file);
          const text = fs.readFileSync(source, 'utf8');
          const position = thread.anchor ? { kind: thread.sourceDirty || thread.anchor.status !== 'attached' ? 'outdated' : 'exact', range: thread.range } : anchor(text.split('\n'), thread.range, thread.snapshot);
          if (position.kind === 'outdated' || !('range' in position)) { skipped++; continue; }
          const hit = parseForward(await synctex(['view', '-i', `${position.range.startLine}:0:${source}`, '-o', sourcePdf]));
          if (hit) located.push({ thread, ...hit }); else skipped++;
        } catch { skipped++; }
      }
      const output = sourcePdf.replace(/\.pdf$/i, '.comments.pdf');
      workspaceFile(root, path.relative(root, output)); rejectSymlink(output);
      const bytes = await annotatedPdf(fs.readFileSync(sourcePdf), located);
      fs.writeFileSync(output, bytes);
      post({ type: 'exported', name: path.relative(root, output), count: located.length, skipped });
      const open = vscode.l10n.t('Open in PDF reader');
      const choice = await vscode.window.showInformationMessage(vscode.l10n.t('Exported {0} comment threads ({1} skipped): {2}', located.length, skipped, path.relative(root, output)), open);
      if (choice === open) await vscode.env.openExternal(vscode.Uri.file(output));
    };
    const build = async (includeComments: boolean, requested?: BuildMode) => {
      if (this.building) return;
      const rootFile = this.selectedRoot;
      if (!rootFile) throw new Error(vscode.l10n.t('Select a root document first.'));
      this.building = true; post({ type: 'building', busy: true });
      try {
        const sourceRoot = workspaceFile(root, rootFile);
        const stem = path.basename(rootFile, '.tex');
        const out = workspaceFile(root, 'build/tex-review/' + stem);
        fs.mkdirSync(out, { recursive: true });
        const engine = vscode.workspace.getConfiguration('texReview').get<string>('engine', 'lualatex');
        const mode = includeComments ? 'full' : requested ?? vscode.workspace.getConfiguration('texReview').get<BuildMode>('buildMode', 'preview');
        const initialized = fs.existsSync(path.join(out, stem + '.aux')) && fs.existsSync(path.join(out, stem + '.pdf'))
          && (!fs.existsSync(path.join(out, stem + '.bcf')) || fs.existsSync(path.join(out, stem + '.bbl')));
        const plan = texBuildPlan(engine, sourceRoot, out, mode, initialized);
        const binary = process.platform === 'darwin' && fs.existsSync('/Library/TeX/texbin/' + plan.binary) ? '/Library/TeX/texbin/' + plan.binary : plan.binary;
        const started = Date.now();
        const unchanged = plan.mode === 'preview' && previewIsCurrent(root, out, stem);
        if (!unchanged) await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Building {0}', rootFile) }, async () => {
          await run(binary, plan.args, { cwd: root, timeout: 300_000, maxBuffer: 12_000_000 });
        });
        this.targetChanged.fire();
        post({ type: 'built', root: rootFile, mode: plan.mode, unchanged, seconds: Math.round((Date.now() - started) / 100) / 10 });
        if (includeComments) await exportComments(path.join(out, stem + '.pdf'));
      } finally { this.building = false; post({ type: 'building', busy: false }); }
    };
    panel.webview.onDidReceiveMessage(m => {
      if (m?.type === 'performance') { if (!disposed) this.recordPerformance(m); return; }
      queue = queue.then(async () => {
        if (disposed || !m || typeof m !== 'object') return;
        if (m.type === 'theme' || m.type === 'ready') {
          if (m.theme && typeof m.theme === 'object') {
            activeTheme = Object.fromEntries(['id', 'name', 'kind', 'foreground', 'background'].map(key => [key,
              typeof m.theme[key] === 'string' && m.theme[key].length < 512 ? m.theme[key] : undefined]));
            this.nativeSyntax = undefined; scheduleSyntax();
          }
          if (m.type === 'theme') return;
        }
        if (m.type === 'ready') {
          ready = true; lastComparison = ''; lastReview = ''; lastSyntax = undefined;
          post({ type: 'init', text: normalizedText().toString(), version: document.version, file,
            selection: this.selections.get(document.uri.toString()), compose: this.selections.get(document.uri.toString())?.compose, config: config(),
            worker: panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'pdf.worker.mjs')).toString() });
          review(); pdfState(); scheduleSyntax(); await comparisonState(); return;
        }
        if (m.type === 'reviewActions') {
          // Native workbench UI; keep modal interactions outside the document edit queue.
          void (async () => {
            type Action = vscode.QuickPickItem & { action?: string };
            const item = (action: string, label: string, icon: string): Action => ({ action, label: `$(${icon}) ${label}` });
            const items: Action[] = [
              item('switch', vscode.l10n.t('Open review…'), 'comment-discussion'),
              item('new', vscode.l10n.t('New review…'), 'add'),
              { label: '', kind: vscode.QuickPickItemKind.Separator },
              item('git', vscode.l10n.t('Compare with checkpoint…'), 'git-commit'),
              item('file', vscode.l10n.t('Compare with TeX file…'), 'diff'),
              item('fullBuild', vscode.l10n.t('Full build PDF'), 'build'),
              item('export', vscode.l10n.t('Export PDF with comments…'), 'export'),
              ...(pdfPath ? [item('reveal', process.platform === 'darwin' ? vscode.l10n.t('Reveal PDF in Finder') : vscode.l10n.t('Reveal PDF in File Explorer'), 'folder-opened')] : []),
              { label: '', kind: vscode.QuickPickItemKind.Separator },
              item('toggleComments', m.showComments ? vscode.l10n.t('Hide comments') : vscode.l10n.t('Show comments'), 'comment'),
              item('togglePdf', m.showPdf ? vscode.l10n.t('Hide PDF') : vscode.l10n.t('Show PDF'), 'file-pdf'),
              item('openNative', vscode.l10n.t('Open in standard editor'), 'code'),
              item('settings', vscode.l10n.t('Settings…'), 'settings-gear'),
              item('performance', vscode.l10n.t('Show performance log'), 'output'),
            ];
            const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Review options') });
            if (disposed || !selected?.action) return;
            switch (selected.action) {
              case 'performance':
                this.performanceOutput ??= vscode.window.createOutputChannel('TeX Review Performance');
                if (!this.context.subscriptions.includes(this.performanceOutput)) this.context.subscriptions.push(this.performanceOutput);
                this.performanceOutput.show(true); break;
              case 'switch': {
                const name = await vscode.window.showQuickPick(this.service.list(), { title: vscode.l10n.t('Open review…') });
                if (name && !disposed) { this.service.setActive(name); review(); } break;
              }
              case 'new': this.service.createReview(this.service.suggestReviewName()); review(); break;
              case 'git': case 'file': await chooseBaseline(selected.action); break;
              case 'fullBuild': post({ type: 'action', action: 'fullBuild' }); break;
              case 'export': await exportComments(); break;
              case 'reveal':
                if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error(vscode.l10n.t('Build or select a PDF first.'));
                await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pdfPath)); break;
              case 'settings': await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:furui-local.tex-review'); break;
              default: post({ type: 'action', action: selected.action });
            }
          })().catch(e => post({ type: 'error', error: String(e.message ?? e) }));
          return;
        }
        if (m.type === 'chooseCheckpoint' || m.type === 'chooseBaselineFile') {
          await chooseBaseline(m.type === 'chooseCheckpoint' ? 'git' : 'file'); return;
        }
        if (m.type === 'toggleComparison') {
          if (!this.context.workspaceState.get<Baseline>('texReview.baseline')) {
            try { await chooseBaseline('git'); } finally { await comparisonState(); }
            return;
          }
          await this.context.workspaceState.update('texReview.compareEnabled', !!m.enabled);
          this.comparisonChanged.fire(); return;
        }
        if (m.type === 'refreshBaseline') { await comparisonState(); return; }
        if (m.type === 'undoDelete') {
          if (!undoDeletion || this.service.active() !== undoDeletion.review) return;
          this.service.apply({ ...undoDeletion.event, ts: nowIso() }, undoDeletion.review); undoDeletion = undefined;
          post({ type: 'deletionUndone' }); review(); return;
        }
        if (m.type === 'edit') {
          if (m.version !== document.version) { docState('conflict'); return; }
          const changes = ChangeSet.fromJSON(m.changes);
          if (changes.length !== normalizedText().length) throw new Error('Invalid edit revision');
          const edit = new vscode.WorkspaceEdit();
          changes.iterChanges((from, to, _fromB, _toB, insert) => {
            edit.replace(document.uri, new vscode.Range(nativePosition(from), nativePosition(to)), insert.toString());
          });
          applying = true;
          try { if (!await vscode.workspace.applyEdit(edit)) throw new Error(vscode.l10n.t('Unable to update the source.')); }
          finally { applying = false; }
          docState('ack'); review(); return;
        }
        if (m.type === 'setBuildMode') {
          if (m.mode !== 'preview' && m.mode !== 'full') throw new Error('Unknown build mode');
          await vscode.workspace.getConfiguration('texReview').update('buildMode', m.mode, vscode.ConfigurationTarget.Workspace);
          review(); return;
        }
        if (m.type === 'build') {
          void build(!!m.includeComments, m.mode === 'full' || m.mode === 'preview' ? m.mode : undefined).catch(e => post({ type: 'error', error: String(e.message ?? e) })); return;
        }
        if (m.type === 'exportComments') {
          void exportComments().catch(e => post({ type: 'error', error: String(e.message ?? e) })); return;
        }
        if (m.type === 'save') { await document.save(); post({ type: 'savedDocument' }); return; }
        if (m.type === 'undo' || m.type === 'redo') { await vscode.commands.executeCommand(m.type); return; }
        if (m.type === 'compareUnsaved' && typeof m.text === 'string') {
          const recovered = await vscode.workspace.openTextDocument({ content: m.text, language: document.languageId });
          await vscode.commands.executeCommand('vscode.diff', document.uri, recovered.uri,
            vscode.l10n.t('Resolve external changes: {0}', path.basename(document.uri.fsPath)));
          post({ type: 'recoveryOpened', text: m.text }); return;
        }
        if (m.type === 'selectRoot') {
          if (typeof m.root !== 'string' || !projectTargets(root).some(t => t.root === m.root)) throw new Error('Unknown root document.');
          this.selectedRoot = m.root; await this.context.workspaceState.update('texReview.root', m.root);
          this.targetChanged.fire(); return;
        }
        if (m.type === 'selectPdf') {
          const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ['pdf'] }, defaultUri: this.folder.uri });
          if (selected?.[0]) { workspaceFile(root, path.relative(root, selected[0].fsPath)); pdfPath = selected[0].fsPath; pdfState(); }
          return;
        }
        if (m.type === 'forward') {
          const request = m.request, generation = ++syncGeneration;
          post({ type: 'syncing', busy: true, request });
          try {
            if (!pdfPath) { post({ type: 'syncStatus', message: vscode.l10n.t('No PDF for this target. Build it first.') }); return; }
            if (!canSync()) return;
            const line = Math.max(1, Math.min(document.lineCount, Number(m.line) || 1));
            const hit = parseForward(await synctex(['view', '-i', `${line}:0:${document.uri.fsPath}`, '-o', pdfPath]));
            if (hit && generation === syncGeneration) post({ type: 'pdfPosition', ...hit, line, request });
            else if (!hit) post({ type: 'syncStatus', message: vscode.l10n.t('No SyncTeX data. Build with -synctex=1.') });
          } catch { post({ type: 'syncStatus', message: vscode.l10n.t('PDF synchronization requires a build with -synctex=1.') }); }
          finally { post({ type: 'syncing', busy: false, request }); }
          return;
        }
        if (m.type === 'inverse') {
          if (!pdfPath || !canSync() || !Number.isInteger(m.page) || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
          const hit = parseInverse(await synctex(['edit', '-o', `${m.page}:${m.x}:${m.y}:${pdfPath}`]));
          if (!hit) { post({ type: 'syncStatus', message: vscode.l10n.t("No matching source location found.") }); return; }
          const absolute = path.isAbsolute(hit.file) ? hit.file : path.resolve(root, hit.file);
          workspaceFile(root, path.relative(root, absolute));
          if (fs.realpathSync(absolute) === fs.realpathSync(document.uri.fsPath)) post({ type: 'sourcePosition', line: hit.line, column: hit.column });
          else {
            const target = vscode.Uri.file(absolute);
            const doc = await vscode.workspace.openTextDocument(target);
            const pos = doc.positionAt(doc.offsetAt(new vscode.Position(Math.min(hit.line - 1, doc.lineCount - 1), hit.column - 1)));
            this.selections.set(target.toString(), { from: doc.offsetAt(pos), to: doc.offsetAt(pos) });
            await vscode.commands.executeCommand('vscode.openWith', target, ReviewEditor.viewType);
          }
          return;
        }
        if (m.type === 'switch') {
          if (typeof m.name !== 'string' || !this.service.list().includes(m.name)) throw new Error('Unknown review');
          this.service.setActive(m.name); review(); return;
        }
        if (m.type === 'openNative') {
          const from = Math.max(0, Math.min(document.getText().length, Number(m.from) || 0));
          const to = Math.max(from, Math.min(document.getText().length, Number(m.to) || from));
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          await vscode.window.showTextDocument(document, { selection: new vscode.Range(nativePosition(from), nativePosition(to)) });
          return;
        }
        if (m.type === 'openSettings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:furui-local.tex-review'); return;
        }
        if (m.type === 'newReview') {
          const name = this.service.suggestReviewName(); this.service.createReview(name); review(); return;
        }
        if (m.type === 'reattach') {
          if (m.review !== this.service.active() || m.version !== document.version || !m.range || typeof m.snapshot !== 'string') throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
          const target = this.service.view(m.review).threads.find(t => t.id === m.thread);
          if (!target || target.file !== file) throw new Error(vscode.l10n.t('Comment not found.'));
          const text = normalizedText(), selected = offsets(text, m.range);
          if (selected.from === selected.to || text.sliceString(selected.from, selected.to) !== m.snapshot) throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
          this.service.reattach(m.thread, lineRange(text, selected), m.review); review(); return;
        }
        if (['add', 'reply', 'resolve', 'reopen', 'editComment', 'deleteThread', 'deleteComment'].includes(m.type)) {
          if (m.review !== this.service.active()) throw new Error(vscode.l10n.t('The active review changed. Please try again.'));
          if (m.type === 'add') {
            if (typeof m.snapshot !== 'string' || !m.range || !Number.isInteger(m.range.startLine) || !Number.isInteger(m.range.endLine) || m.range.startLine < 1 || m.range.endLine < m.range.startLine) throw new Error('Invalid selection');
            const current = normalizedText(), before = documentHistory.get(m.version);
            if (before === undefined) throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
            const base = sourceText(before), selected = offsets(base, m.range);
            if (base.sliceString(selected.from, selected.to) !== m.snapshot) throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
            const tracked = m.version === document.version ? { ...selected, status: 'attached' as const }
              : followDraftTarget(base, current, { ...selected, status: 'attached', snapshot: m.snapshot });
            if (tracked.status !== 'attached' || current.sliceString(tracked.from, tracked.to) !== m.snapshot) throw new Error(vscode.l10n.t('The text has changed. Select the passage again.'));
            const located = { range: lineRange(current, tracked) };
            const body = validBody(m.body);
            if (!this.service.active()) this.service.createReview(this.service.suggestReviewName());
            this.service.apply({ op: 'add_thread', id: 't_' + randomUUID(), file, range: located.range,
              snapshot: m.snapshot, author: 'reviewer', body, ts: nowIso() });
          } else {
            const active = this.service.active();
            const thread = active && this.service.view(active).threads.find(t => t.id === m.thread);
            if (!thread) throw new Error('Unknown thread');
            if (m.type === 'deleteThread' || m.type === 'deleteComment') {
              if (m.type === 'deleteComment' && !thread.comments.some(c => c.id === m.comment && c.id !== `${thread.id}.c1`)) throw new Error('Unknown reply');
              const deletion: ReviewEvent = m.type === 'deleteThread'
                ? { op: 'delete_thread', thread: thread.id, ts: nowIso() }
                : { op: 'delete_comment', comment: m.comment, ts: nowIso() };
              this.service.apply(deletion);
              undoDeletion = { review: active!, event: m.type === 'deleteThread'
                ? { op: 'restore_thread', thread: thread.id, ts: nowIso() }
                : { op: 'restore_comment', comment: m.comment, ts: nowIso() } };
              post({ type: 'deleted' }); review(); return;
            }
            if (m.type === 'reply') this.service.apply({ op: 'reply', thread: thread.id, body: validBody(m.body), author: 'reviewer', ts: nowIso() });
            else if (m.type === 'editComment') {
              const c = thread.comments.find(c => c.id === m.comment && c.author === 'reviewer');
              if (!c) throw new Error(vscode.l10n.t('This comment cannot be edited.'));
              this.service.apply({ op: 'edit_comment', comment: c.id, body: validBody(m.body), ts: nowIso() });
            } else this.service.apply({ op: m.type, thread: thread.id, ts: nowIso() });
          }
          post({ type: 'commentSaved', key: m.type === 'add' ? 'new' : m.thread }); review();
        }
      }).catch(e => post({ type: 'error', error: String(e instanceof Error ? e.message : e) }));
    }, undefined, disposables);
    panel.onDidDispose(() => { this.panels.delete(document.uri.toString()); disposed = true; clearTimeout(activationTimer); clearTimeout(pdfTimer); clearTimeout(sourceTimer); if (syntaxTimer) clearTimeout(syntaxTimer); if (refreshTimer) clearTimeout(refreshTimer); for (const d of disposables) d.dispose(); });
  }

  private findPdf(document: vscode.TextDocument): string | undefined {
    const root = this.folder.uri.fsPath;
    const configured = vscode.workspace.getConfiguration('texReview').get<string>('pdfPath', '');
    const stem = path.basename(document.uri.fsPath, '.tex');
    if (this.selectedRoot) return targetPdf(root, this.selectedRoot);
    const candidates = configured ? [configured] : [`build/ja/main_ja.pdf`, `${stem}.pdf`, 'main_ja.pdf', 'main.pdf'];
    return candidates.map(p => workspaceFile(root, p)).find(p => fs.existsSync(p));
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    return `<!DOCTYPE html><html lang="${vscode.env.language.startsWith('ja') ? 'ja' : 'en'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} data: blob:;">
      <link rel="stylesheet" href="${resource('editor.css')}"></head><body>
      <header class="editor-toolbar"><div class="toolbar-actions">      <button id="addComment" class="icon-button" title="${tr('Add comment')} · ⌘⌥M" aria-label="${tr('Add comment')}">${icon('commentPlus')}</button><span class="toolbar-divider"></span>
      <label class="icon-toggle" title="${tr('Comments')}"><input id="showComments" type="checkbox" checked aria-label="${tr('Comments')}">${icon('panelLeft')}</label>
      <label class="icon-toggle" title="${tr('PDF')}"><input id="showPdf" type="checkbox" checked aria-label="${tr('PDF')}">${icon('panelRight')}</label>
      <label class="icon-toggle" title="${tr('Compare with baseline')}"><input id="showComparison" type="checkbox" aria-label="${tr('Compare with baseline')}">${icon('compare')}</label>
      <button id="save" class="icon-button" title="${tr('Save')} · ⌘S" aria-label="${tr('Save')}">${icon('save')}</button>
</div><div id="comparisonBar" hidden><span id="baselineLabel"></span><button id="previousChange" class="icon-button" title="${tr('Previous change')}" aria-label="${tr('Previous change')}">${icon('left')}</button><button id="nextChange" class="icon-button" title="${tr('Next change')}" aria-label="${tr('Next change')}">${icon('right')}</button><button id="refreshBaseline" class="icon-button" title="${tr('Refresh baseline')}" aria-label="${tr('Refresh baseline')}">${icon('sync')}</button></div><span id="status" role="status"></span><span class="spacer"></span><nav id="pdfControls" class="pdf-toolbar"><button id="buildPdf" class="icon-button" aria-label="${tr('Build PDF')}" title="${tr('Build PDF')}">${icon('build')}</button><select id="buildMode" class="target-select build-mode" aria-label="${tr('Build mode')}" title="${tr('Build mode')}"><option value="preview" title="${tr('Draft build (one TeX pass)')}">${tr('Draft')}</option><option value="full" title="${tr('Full build (references and bibliography)')}">${tr('Full')}</option></select><select id="roots" class="target-select" aria-label="${tr('Build target')}" title="${tr('Build target')}"></select><button id="selectPdf" class="icon-button" aria-label="${tr('Select PDF')}" title="${tr('Select PDF')}">${icon('file')}</button><button id="prevPage" class="icon-button" title="${tr('Previous page')}" aria-label="${tr('Previous page')}">${icon('left')}</button><input id="pageNumber" aria-label="${tr('PDF page')}" type="number" min="1" value="1"><span id="pageCount"></span><button id="nextPage" class="icon-button" title="${tr('Next page')}" aria-label="${tr('Next page')}">${icon('right')}</button><span class="toolbar-divider"></span><button id="syncPdf" class="icon-button" title="${tr('Sync PDF')}" aria-label="${tr('Sync PDF')}">${icon('sync')}</button></nav><button id="reviewMenu" class="icon-button" title="${tr('Review options')}" aria-label="${tr('Review options')}">${icon('more')}</button></header>
      <div id="deletionNotice" role="status" hidden><span>${tr('Deleted.')}</span><button id="undoDelete">${tr('Undo')}</button><button id="dismissDelete" aria-label="${tr('Dismiss')}">×</button></div>
      <div id="error" role="alert"></div>
      <div id="workspace"><aside id="comments"><div id="commentHeader"><span>${tr('Comments')} <span id="commentCount" class="count"></span></span><nav class="comment-navigation" aria-label="${tr('Comment navigation')}"><button id="previousComment" class="icon-button" disabled title="${tr('Previous comment')}" aria-label="${tr('Previous comment')}">${icon('up')}</button><button id="nextComment" class="icon-button" disabled title="${tr('Next comment')}" aria-label="${tr('Next comment')}">${icon('down')}</button></nav><label class="resolved-filter" title="${tr('Show resolved')}"><input id="resolved" type="checkbox">${tr('Resolved')}</label></div><div id="cards"></div></aside>
      <div class="resizer" id="resizeComments" role="separator" aria-label="${tr('Comments column width')}" tabindex="0"></div><main id="source"></main>
      <div class="resizer" id="resizePdf" role="separator" aria-label="${tr('PDF column width')}" tabindex="0"></div><section id="pdf"><div id="syncStatus" role="status" aria-live="polite"></div><div id="pdfScroll"></div></section></div>
      <script nonce="${nonce}" src="${resource('editor.bundle.js')}"></script></body></html>`;
  }
}

function tr(message: string): string { return vscode.l10n.t(message); }
function icon(name: string): string {
  const paths: Record<string, string> = {
    compare: 'M5 2H2v12h3 M11 2h3v12h-3 M6 5l-2 3 2 3 M10 5l2 3-2 3',
    file: 'M4 1.5h5l3 3v10H4z M9 1.5v3h3 M6 8h4 M6 10h4',
    commentPlus: 'M2 2.5h12v8H7l-3.5 3v-3H2z M8 4v5 M5.5 6.5h5',
    panelLeft: 'M1.5 2h13v12h-13z M6 2v12', panelRight: 'M1.5 2h13v12h-13z M10 2v12',
    save: 'M2 2h10l2 2v10H2z M5 2v4h6V2 M5 14V9h6v5',
    more: 'M3 8h.1 M8 8h.1 M13 8h.1', left: 'M10 3 5 8l5 5', right: 'M6 3l5 5-5 5', up: 'M3 10l5-5 5 5', down: 'M3 6l5 5 5-5',
    build: 'M5 2l8 6-8 6z',
    sync: 'M2 5h11l-3-3 M14 11H3l3 3 M13 5l-3 3 M3 11l3-3',
  };
  return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] ?? paths.file}"/></svg>`;
}
