import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerCommands } from '../../src/vscode/commands';
import { ReviewService } from '../../src/vscode/reviewService';
import { CommentsUI } from '../../src/vscode/commentsController';
import { ReviewTree } from '../../src/vscode/treeProvider';
import * as mock from '../vscode-mock';

function doc(rel: string, text: string) {
  return { uri: { _rel: rel }, getText: () => text };
}

let dir: string;
let service: ReviewService;
let ui: CommentsUI;
let subscriptions: Array<{ dispose(): void }>;

function addThread(file = 'a.ts'): string {
  service.apply({
    op: 'add_thread',
    id: 't_1',
    file,
    range: { startLine: 1, endLine: 1 },
    snapshot: 'l1',
    author: 'reviewer',
    body: 'qwe',
    ts: 'x',
  });
  return 't_1';
}

const open = (review: string, threadId: string) =>
  mock.commands.executeCommand('review.openComment', { review, threadId });

const alive = () => mock.state.createdThreads.filter((t) => !t.disposed);

beforeEach(() => {
  mock.__reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  service = new ReviewService(dir);
  ui = new CommentsUI();
  subscriptions = [];
  registerCommands(
    { subscriptions } as never,
    service,
    ui,
    new ReviewTree(service),
  );
});

afterEach(() => {
  for (const s of subscriptions) s.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('review.openComment', () => {
  it('opens the file at the re-anchored line and expands the widget', async () => {
    service.createReview('r');
    const threadId = addThread();
    // A line was inserted above since the comment was made: the click must
    // land on the re-anchored line, not the stored one.
    mock.state.textDocuments = [doc('a.ts', 'x\nl1\nl2\n')];
    ui.render(service.view('r'));
    const widget = alive()[0];
    widget.collapsibleState = mock.CommentThreadCollapsibleState.Collapsed;

    await open('r', threadId);

    expect(mock.state.shownDocuments).toHaveLength(1);
    expect(mock.state.shownDocuments[0].options?.selection?.start.line).toBe(1);
    expect(widget.collapsibleState).toBe(mock.CommentThreadCollapsibleState.Expanded);
  });

  it('opens the file without a widget for a resolved thread', async () => {
    service.createReview('r');
    const threadId = addThread();
    service.apply({ op: 'resolve', thread: threadId, ts: 'x' });
    mock.state.textDocuments = [doc('a.ts', 'l1\nl2\n')];

    await open('r', threadId);

    expect(mock.state.shownDocuments).toHaveLength(1);
    expect(alive()).toHaveLength(0);
    expect(mock.state.messages).toHaveLength(0);
  });

  it('asks before switching to an inactive review and stops on dismiss', async () => {
    service.createReview('r1');
    const threadId = addThread();
    service.createReview('r2');
    mock.state.textDocuments = [doc('a.ts', 'l1\nl2\n')];

    await open('r1', threadId);

    expect(mock.state.messages).toEqual([
      expect.objectContaining({
        severity: 'info',
        items: ['Make review "r1" active'],
      }),
    ]);
    expect(mock.state.shownDocuments).toHaveLength(0);
    expect(service.active()).toBe('r2');
  });

  it('activates the review and finishes navigation when the button is pressed', async () => {
    service.createReview('r1');
    const threadId = addThread();
    service.createReview('r2');
    mock.state.textDocuments = [doc('a.ts', 'l1\nl2\n')];
    mock.state.messageResponse = (_msg, items) => items[0];

    await open('r1', threadId);

    expect(service.active()).toBe('r1');
    expect(mock.state.shownDocuments).toHaveLength(1);
    expect(alive()).toHaveLength(1);
    expect(alive()[0].collapsibleState).toBe(mock.CommentThreadCollapsibleState.Expanded);
  });

  it('shows an error and stops when the file cannot be opened', async () => {
    service.createReview('r');
    const threadId = addThread('gone.ts');

    await open('r', threadId);

    expect(mock.state.messages).toEqual([
      expect.objectContaining({ severity: 'error' }),
    ]);
    expect(mock.state.messages[0].message).toContain('gone.ts');
    expect(mock.state.shownDocuments).toHaveLength(0);
  });

  it('warns when the thread no longer exists', async () => {
    service.createReview('r');

    await open('r', 'vanished');

    expect(mock.state.messages).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
    expect(mock.state.shownDocuments).toHaveLength(0);
  });
});
