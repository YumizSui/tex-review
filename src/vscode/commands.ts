import * as vscode from 'vscode';
import { ReviewService, nowIso } from './reviewService';
import { CommentsUI, RenderedComment } from './commentsController';
import { ReviewTree } from './treeProvider';
import { newThreadId } from '../core/ids';
import { anchor } from '../core/anchor';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Store snapshots with LF endings only. On CRLF files getText() yields '\r\n',
// which would bake stray '\r' into view.json and break the agent's grep of the
// raw snapshot against a normally-edited file.
function normalizeSnapshot(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export function registerCommands(
  context: vscode.ExtensionContext,
  service: ReviewService,
  ui: CommentsUI,
  tree: ReviewTree,
): void {
  const renderNow = () => {
    // Runs detached on a timer, so an unguarded throw here is swallowed by the
    // host and leaves the panel silently stale. Surface it instead.
    try {
      const view = service.refreshView();
      ui.render(view ?? { version: 1, name: '', createdAt: '', threads: [] });
      tree.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Code Review: failed to refresh — ${errMessage(err)}`);
    }
  };

  // Coalesce render bursts: a user action appends to the log, which also fires
  // the file watcher; debouncing merges both into one render and satisfies the
  // spec's "debounced" re-anchoring on save.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRender = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(renderNow, 100);
  };
  context.subscriptions.push({ dispose: () => { if (timer) clearTimeout(timer); } });

  // VSCode discards rejected/thrown command callbacks without telling the user,
  // so a failed write (disk full, read-only .review, lost mount) would lose the
  // comment silently. Wrap every handler to surface failures.
  const reg = (id: string, fn: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: any[]) => {
        try {
          return await fn(...args);
        } catch (err) {
          vscode.window.showErrorMessage(`Code Review: ${id} failed — ${errMessage(err)}`);
        }
      }),
    );

  // Ensure a review is active. When none is active but others exist, let the
  // user activate an existing one or create a new one; with no reviews at all,
  // go straight to naming a new one. Returns false if the user cancels.
  const createReview = async (): Promise<boolean> => {
    const name = await vscode.window.showInputBox({
      prompt: 'Name a new review for this comment',
      value: service.suggestReviewName(),
    });
    if (!name) return false;
    service.createReview(name.trim());
    return true;
  };

  const ensureActiveReview = async (): Promise<boolean> => {
    if (service.active()) return true;
    const existing = service.list();
    if (existing.length === 0) return createReview();

    const CREATE = 'Create new review…';
    const pick = await vscode.window.showQuickPick([CREATE, ...existing], {
      placeHolder: 'No active review — activate one or create a new review for this comment',
    });
    if (!pick) return false;
    if (pick === CREATE) return createReview();
    service.setActive(pick);
    return true;
  };

  reg('review.refresh', scheduleRender);

  reg('review.newReview', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Review name', placeHolder: 'auth-refactor' });
    if (!name) return;
    service.createReview(name.trim());
    scheduleRender();
  });

  reg('review.switchActive', async () => {
    const names = service.list();
    if (names.length === 0) {
      vscode.window.showInformationMessage('No reviews yet. Create one first.');
      return;
    }
    const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Activate review' });
    if (!pick) return;
    service.setActive(pick);
    scheduleRender();
  });

  reg('review.deleteReview', async (node?: { name?: string }) => {
    const name = node?.name ?? (await vscode.window.showQuickPick(service.list(), { placeHolder: 'Delete review' }));
    if (!name) return;
    const ok = await vscode.window.showWarningMessage(`Delete review "${name}"?`, { modal: true }, 'Delete');
    if (ok !== 'Delete') return;
    service.deleteReview(name);
    scheduleRender();
  });

  reg('review.addComment', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (!(await ensureActiveReview())) return;
    const body = await vscode.window.showInputBox({ prompt: 'Comment' });
    if (!body) return;

    const sel = editor.selection;
    const startLine = sel.start.line;
    const endLine = sel.isEmpty ? sel.start.line : sel.end.line;
    const snapshot = normalizeSnapshot(
      editor.document.getText(
        new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).text.length),
      ),
    );
    service.apply({
      op: 'add_thread',
      id: newThreadId(),
      file: vscode.workspace.asRelativePath(editor.document.uri, false),
      range: { startLine: startLine + 1, endLine: endLine + 1 },
      snapshot,
      author: 'reviewer',
      body,
      ts: nowIso(),
    });
    scheduleRender();
  });

  reg('review.replySubmit', async (reply: vscode.CommentReply) => {
    const threadId = ui.threadIdFor(reply.thread);
    if (threadId) {
      service.apply({ op: 'reply', thread: threadId, author: 'reviewer', body: reply.text, ts: nowIso() });
      scheduleRender();
      return;
    }
    // Unbound thread = the user started a fresh comment from the gutter UI.
    // Treat it as a new review thread, creating a review to hold it if needed.
    if (!(await ensureActiveReview())) return;
    const doc = await vscode.workspace.openTextDocument(reply.thread.uri);
    const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0);
    const startLine = range.start.line;
    const endLine = range.end.line;
    const snapshot = normalizeSnapshot(
      doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)),
    );
    service.apply({
      op: 'add_thread',
      id: newThreadId(),
      file: vscode.workspace.asRelativePath(reply.thread.uri, false),
      range: { startLine: startLine + 1, endLine: endLine + 1 },
      snapshot,
      author: 'reviewer',
      body: reply.text,
      ts: nowIso(),
    });
    // Drop the transient editor-created thread; render() recreates a bound one.
    reply.thread.dispose();
    scheduleRender();
  });

  reg('review.makeActive', (node?: { name?: string }) => {
    if (!node?.name) return;
    service.setActive(node.name);
    scheduleRender();
  });

  // Both the comment widget (passes a CommentThread, always the active review)
  // and the tree panel context menu (passes a tree node carrying threadId and
  // its review name, which may be inactive) route here.
  const targetFrom = (arg: any): { threadId: string; review?: string } | undefined => {
    if (typeof arg?.threadId === 'string') return { threadId: arg.threadId, review: arg.review };
    const threadId = ui.threadIdFor(arg);
    return threadId ? { threadId } : undefined;
  };

  reg('review.resolve', (arg: any) => {
    const t = targetFrom(arg);
    if (!t) return;
    service.apply({ op: 'resolve', thread: t.threadId, ts: nowIso() }, t.review);
    scheduleRender();
  });

  reg('review.reopen', (arg: any) => {
    const t = targetFrom(arg);
    if (!t) return;
    service.apply({ op: 'reopen', thread: t.threadId, ts: nowIso() }, t.review);
    scheduleRender();
  });

  // --- Tree navigation: open a thread's comments in the editor ---

  reg('review.openComment', async (node: { review: string; threadId: string }) => {
    // Editor widgets only exist for the active review. Don't silently switch
    // reviews from a navigation click — ask first, then finish the journey.
    if (node.review !== service.active()) {
      const activate = `Make review "${node.review}" active`;
      const pick = await vscode.window.showInformationMessage(
        `Review "${node.review}" is not active. Activate it to open its comments in the editor.`,
        activate,
      );
      if (pick !== activate) return;
      service.setActive(node.review);
      renderNow();
    }

    const t = service.view(node.review).threads.find((x) => x.id === node.threadId);
    if (!t) {
      // Stale tree node: the thread vanished (e.g. agent rewrote the log).
      vscode.window.showWarningMessage('Code Review: this comment thread no longer exists.');
      scheduleRender();
      return;
    }

    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, t.file));
    } catch (err) {
      vscode.window.showErrorMessage(`Code Review: cannot open ${t.file} — ${errMessage(err)}`);
      return;
    }

    // Re-anchor at click time: tree nodes are built at render time, so their
    // line may be stale after edits. Outdated snapshots fall back to the
    // stored line, matching the widget's placement.
    const located = anchor(doc.getText().split('\n'), t.range, t.snapshot);
    const line = (located.kind === 'outdated' ? t.range.startLine : located.range.startLine) - 1;
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0) });

    // Resolved threads have no widget by design — the click just opens the file.
    if (t.status !== 'resolved') {
      // Render synchronously so a freshly opened document's widget is bound
      // before expanding; the debounced open-event render is too late.
      renderNow();
      ui.expandThread(t.id);
    }
  });

  // --- Comment editing (reviewer's own comments, comment widget only) ---

  const bodyText = (b: string | vscode.MarkdownString): string =>
    typeof b === 'string' ? b : b.value;

  // Discard an in-progress edit: rebuild the thread from stored state so the
  // original body reappears in preview.
  const cancelEdit = (c: RenderedComment) => {
    const name = service.active();
    if (!name) return;
    const t = service.view(name).threads.find((x) => x.id === c.threadId);
    if (t) ui.resetThread(t);
  };

  reg('review.editComment', (c: RenderedComment) =>
    ui.setCommentMode(c, vscode.CommentMode.Editing),
  );

  reg('review.editCommentCancel', (c: RenderedComment) => cancelEdit(c));

  reg('review.editCommentSave', (c: RenderedComment) => {
    const body = bodyText(c.body).trim();
    // Empty save is a no-op: restore the original rather than store a blank.
    if (!body) {
      cancelEdit(c);
      return;
    }
    service.apply({ op: 'edit_comment', comment: c.commentId, body, ts: nowIso() });
    scheduleRender();
  });
}
