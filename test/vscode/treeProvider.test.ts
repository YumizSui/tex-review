import { beforeEach, describe, expect, it } from 'vitest';
import { ReviewTree, Node } from '../../src/vscode/treeProvider';
import { ReviewService } from '../../src/vscode/reviewService';
import { ReviewView } from '../../src/core/types';
import * as mock from '../vscode-mock';

const reviewView: ReviewView = {
  version: 1,
  name: 'r',
  createdAt: '',
  threads: [
    {
      id: 't1',
      file: 'a.ts',
      range: { startLine: 1, endLine: 1 },
      snapshot: 'l1',
      status: 'open',
      createdAt: 'x',
      comments: [
        { id: 't1.c1', author: 'reviewer', body: 'qwe', createdAt: 'x' },
        { id: 't1.c2', author: 'agent', body: 'asd', createdAt: 'x' },
      ],
    },
  ],
};

const service = {
  active: () => 'r',
  list: () => ['r'],
  view: () => reviewView,
} as unknown as ReviewService;

describe('ReviewTree navigation commands', () => {
  beforeEach(() => mock.__reset());

  it('wires thread nodes to review.openComment with review and thread ids', () => {
    const tree = new ReviewTree(service);
    const [review] = tree.getChildren();
    const [thread] = tree.getChildren(review);
    const item = tree.getTreeItem(thread);

    expect(item.command?.command).toBe('review.openComment');
    expect(item.command?.arguments).toEqual([{ review: 'r', threadId: 't1' }]);
  });

  it('wires comment nodes to review.openComment with their thread ids', () => {
    const tree = new ReviewTree(service);
    const [review] = tree.getChildren();
    const [thread] = tree.getChildren(review);
    const comments = tree.getChildren(thread);

    expect(comments).toHaveLength(2);
    for (const c of comments as Extract<Node, { kind: 'comment' }>[]) {
      expect(c.review).toBe('r');
      expect(c.threadId).toBe('t1');
      const item = tree.getTreeItem(c);
      expect(item.command?.command).toBe('review.openComment');
      expect(item.command?.arguments).toEqual([{ review: 'r', threadId: 't1' }]);
    }
  });
});
