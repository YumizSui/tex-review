import * as vscode from 'vscode';
import { Comment, ReviewView, Thread, ThreadStatus } from '../core/types';
import { anchor } from '../core/anchor';

// Maps a VSCode comment thread back to our thread id so command handlers
// (reply/resolve) know which stored thread they act on. `sig` and `status`
// capture the last-rendered state so re-renders can skip unchanged threads
// instead of disposing+recreating them (which the editor shows as blinking).
export interface BoundThread {
  vsThread: vscode.CommentThread;
  threadId: string;
  sig: string;
  status: ThreadStatus;
  // Whether the thread last rendered as outdated (snapshot not found). A flip in
  // this flag is the only transition that forces a dispose+recreate.
  outdated: boolean;
}

// A rendered VSCode comment carries our own ids so edit handlers can map it
// back to the stored comment without relying on array position.
export interface RenderedComment extends vscode.Comment {
  commentId: string;
  threadId: string;
}

export class CommentsUI {
  private readonly controller: vscode.CommentController;
  private bound: BoundThread[] = [];

  constructor() {
    this.controller = vscode.comments.createCommentController('reviewComments', 'Code Review');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => [new vscode.Range(0, 0, doc.lineCount - 1, 0)],
    };
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
  }

  threadIdFor(vsThread: vscode.CommentThread): string | undefined {
    return this.bound.find((b) => b.vsThread === vsThread)?.threadId;
  }

  private clear(): void {
    for (const b of this.bound) b.vsThread.dispose();
    this.bound = [];
  }

  // Reconcile rendered threads against the view. Threads are matched by id so
  // unchanged ones are left untouched, changed ones are updated in place, and
  // only genuinely removed ones are disposed. A full teardown+rebuild would
  // make every live widget flash open/closed on each render (the blink bug).
  render(view: ReviewView): void {
    const desired = new Map<string, { uri: vscode.Uri; lines: string[]; t: Thread }>();
    for (const doc of vscode.workspace.textDocuments) {
      const rel = vscode.workspace.asRelativePath(doc.uri, false);
      const lines = doc.getText().split('\n');
      for (const t of view.threads) {
        // Resolved threads are dropped from the editor/Comments UI entirely;
        // they remain visible (and reopenable) in the review tree panel.
        if (t.file === rel && t.status !== 'resolved') {
          desired.set(t.id, { uri: doc.uri, lines, t });
        }
      }
    }

    // Dispose threads that no longer have a place in the view.
    this.bound = this.bound.filter((b) => {
      if (desired.has(b.threadId)) return true;
      b.vsThread.dispose();
      return false;
    });

    for (const [id, { uri, lines, t }] of desired) {
      const r = this.placement(lines, t);
      const sig = JSON.stringify({
        line: [r.startLine, r.endLine],
        label: r.label,
        comments: t.comments.map((c) => [c.author, c.body, c.editedAt]),
      });
      const range = new vscode.Range(r.startLine, 0, r.endLine, 0);
      const existing = this.bound.find((b) => b.threadId === id);

      // Nothing changed since the last render — leave the live widget alone.
      if (existing && existing.sig === sig && existing.status === t.status) continue;

      // VSCode live-tracks a thread's decoration through normal edits, so an
      // in-place update keeps it correctly positioned without a blink. The one
      // case its tracking can't recover is a thread leaving the outdated state
      // (its snapshot reappears): the widget is stranded on a stale line, so the
      // thread must be recreated to re-place it. Every other change updates in
      // place to avoid blinking.
      const leavingOutdated = !!existing && existing.outdated && !r.outdated;
      if (existing && !leavingOutdated) {
        existing.vsThread.range = range;
        existing.vsThread.label = r.label;
        existing.vsThread.contextValue = t.status;
        existing.vsThread.comments = t.comments.map((c) => this.toComment(t.id, c));
        if (existing.status !== t.status) {
          existing.vsThread.collapsibleState = collapsibleFor(t.status);
        }
        existing.sig = sig;
        existing.status = t.status;
        existing.outdated = r.outdated;
        continue;
      }

      if (existing) {
        existing.vsThread.dispose();
        this.bound = this.bound.filter((b) => b !== existing);
      }
      const vsThread = this.controller.createCommentThread(
        uri,
        range,
        t.comments.map((c) => this.toComment(t.id, c)),
      );
      vsThread.label = r.label;
      vsThread.contextValue = t.status;
      vsThread.collapsibleState = collapsibleFor(t.status);
      this.bound.push({ vsThread, threadId: id, sig, status: t.status, outdated: r.outdated });
    }
  }

  // Anchor the thread in the current document text and derive its label.
  private placement(
    lines: string[],
    t: Thread,
  ): { startLine: number; endLine: number; label: string; outdated: boolean } {
    const located = anchor(lines, t.range, t.snapshot);
    const outdated = located.kind === 'outdated';
    const range = outdated ? t.range : located.range;
    return {
      startLine: range.startLine - 1,
      endLine: range.endLine - 1,
      label: `${t.status === 'resolved' ? 'Resolved' : 'Open'}${outdated ? ' [outdated]' : ''}`,
      outdated,
    };
  }

  // Force a rendered thread's widget open (tree-click navigation). No-op when
  // the thread isn't rendered (resolved, inactive review, or file not open).
  expandThread(threadId: string): void {
    const b = this.bound.find((x) => x.threadId === threadId);
    if (b) b.vsThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  // Flip a rendered comment into or out of edit mode in place. Editing state is
  // transient UI — it lives on the live widget until the user saves or cancels,
  // and never touches the stored log.
  setCommentMode(c: RenderedComment, mode: vscode.CommentMode): void {
    const b = this.bound.find((x) => x.threadId === c.threadId);
    if (!b) return;
    b.vsThread.comments = b.vsThread.comments.map((vc) =>
      (vc as RenderedComment).commentId === c.commentId ? { ...vc, mode } : vc,
    );
  }

  // Rebuild one thread's comments from stored state, dropping any edit-mode
  // widget. Used to cancel an edit (or discard an empty save) so the original
  // body reappears in preview — render()'s signature check would otherwise skip
  // this rethread when nothing in the stored view changed.
  resetThread(t: Thread): void {
    const b = this.bound.find((x) => x.threadId === t.id);
    if (b) b.vsThread.comments = t.comments.map((c) => this.toComment(t.id, c));
  }

  private toComment(threadId: string, c: Comment): RenderedComment {
    return {
      commentId: c.id,
      threadId,
      author: { name: c.author },
      body: new vscode.MarkdownString(c.body),
      mode: vscode.CommentMode.Preview,
      // Gates the edit pencil to the reviewer's own comments (package.json menu).
      contextValue: c.author === 'reviewer' ? 'canEdit' : undefined,
      // Shown beside the author; keeps the marker out of the editable body.
      label: c.editedAt ? '(edited)' : undefined,
    };
  }
}

function collapsibleFor(status: ThreadStatus): vscode.CommentThreadCollapsibleState {
  return status === 'resolved'
    ? vscode.CommentThreadCollapsibleState.Collapsed
    : vscode.CommentThreadCollapsibleState.Expanded;
}
