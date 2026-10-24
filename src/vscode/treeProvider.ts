import * as vscode from 'vscode';
import { ReviewService } from './reviewService';
import { anchor } from '../core/anchor';
import { Thread } from '../core/types';

export type Node =
  | { kind: 'review'; name: string }
  | { kind: 'thread'; review: string; threadId: string; label: string; file: string; line: number; status: 'open' | 'resolved'; outdated: boolean }
  | { kind: 'comment'; review: string; threadId: string; label: string };

export class ReviewTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  // VSCode persists each element's expansion state across refreshes, keyed by
  // TreeItem.id. Threads carry this generation in their id; bumping it on a
  // review expand makes VSCode treat every thread as new, so the provided
  // Collapsed state wins and threads come back collapsed.
  private threadGen = 0;

  // Generation baked into review ids. Bumping it gives every review a fresh id,
  // so VSCode drops its persisted expansion state and the provided Collapsed/
  // Expanded default wins. Bumped when the active review changes so the newly
  // active one expands (and the rest collapse) on the next render.
  private reviewGen = 0;
  private lastActive: string | null = null;

  constructor(private readonly service: ReviewService) {}

  refresh(): void {
    this.emitter.fire();
  }

  // Wired to TreeView collapse/expand events. Bump the generation when a review
  // collapses (while its threads are hidden) so they get fresh ids and re-render
  // collapsed on the next expand — no flash of the previous expanded state.
  onElementCollapsed(node: Node): void {
    if (node.kind !== 'review') return;
    this.threadGen++;
    this.refresh();
  }

  onElementExpanded(_node: Node): void {}

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'review') {
      const active = this.service.active() === node.name;
      // First render: only the active review starts expanded; the rest collapse.
      // VSCode persists later user toggles by the stable id below.
      const item = new vscode.TreeItem(
        node.name,
        active
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.label = (active ? '● ' : '') + node.name;
      // Generation-tagged id: stable across plain refreshes (VSCode keeps the
      // user's expand/collapse choice), reset when the active review changes.
      item.id = `review/${this.reviewGen}/${node.name}`;
      item.contextValue = 'review';
      return item;
    }
    if (node.kind === 'thread') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `thread/${this.threadGen}/${node.review}/${node.threadId}`;
      item.contextValue = node.status === 'resolved' ? 'thread-resolved' : 'thread-open';
      item.description = `${node.file}:${node.line}${node.outdated ? ' [outdated]' : ''}`;
      if (node.outdated) {
        item.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('list.warningForeground'),
        );
      }
      item.command = this.command(node);
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.command = this.command(node);
    return item;
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const active = this.service.active();
      // Active changed: refresh review ids so the new active review expands.
      if (active !== this.lastActive) {
        this.reviewGen++;
        this.lastActive = active;
      }
      const names = this.service.list();
      const ordered = active
        ? [active, ...names.filter((n) => n !== active)]
        : names;
      return ordered.map((name) => ({ kind: 'review', name }));
    }
    if (node.kind === 'review') {
      return this.service.view(node.name).threads.map((t) => {
        const placed = this.locate(t);
        return {
          kind: 'thread',
          review: node.name,
          threadId: t.id,
          label: `${t.status === 'resolved' ? '✓' : '○'} ${t.comments[0]?.body ?? '(empty)'}`,
          file: t.file,
          line: placed.line,
          status: t.status,
          outdated: placed.outdated,
        };
      });
    }
    if (node.kind === 'thread') {
      const review = this.service.view(node.review);
      const thread = review.threads.find((t) => t.id === node.threadId);
      return (thread?.comments ?? []).map((c) => ({
        kind: 'comment',
        review: node.review,
        threadId: node.threadId,
        label: `${c.author}: ${c.body}`,
      }));
    }
    return [];
  }

  // Re-anchor the thread against the open document's current text so the tree's
  // line matches the editor. Falls back to the stored line when the file isn't
  // open or the snapshot can no longer be found (outdated). `outdated` is only
  // known when the file is open — otherwise we can't tell, so it stays false.
  // Both thread and comment clicks navigate to the thread in the editor. The
  // handler re-resolves file/line from stored state at click time, so the node
  // only needs to say which thread it is.
  private command(node: { review: string; threadId: string }): vscode.Command {
    return {
      command: 'review.openComment',
      title: 'Open Comment',
      arguments: [{ review: node.review, threadId: node.threadId }],
    };
  }

  private locate(t: Thread): { line: number; outdated: boolean } {
    const doc = vscode.workspace.textDocuments.find(
      (d) => vscode.workspace.asRelativePath(d.uri, false) === t.file,
    );
    if (!doc) return { line: t.range.startLine, outdated: false };
    const located = anchor(doc.getText().split('\n'), t.range, t.snapshot);
    return located.kind === 'outdated'
      ? { line: t.range.startLine, outdated: true }
      : { line: located.range.startLine, outdated: false };
  }
}
