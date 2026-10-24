import { ReviewEvent, ReviewView, Thread } from './types';

export function fold(name: string, events: ReviewEvent[], includeDeleted = false): ReviewView {
  const order: string[] = [];
  const byId = new Map<string, Thread>();

  const deletedThreads = new Set<string>(), deletedComments = new Set<string>();

  for (const e of events) {
    switch (e.op) {
      case 'add_thread': {
        if (byId.has(e.id)) break;
        byId.set(e.id, {
          id: e.id,
          file: e.file,
          range: e.range,
          snapshot: e.snapshot,
          ...(e.anchor ? { anchor: e.anchor } : {}),
          status: 'open',
          createdAt: e.ts,
          comments: [{ id: `${e.id}.c1`, author: e.author, body: e.body, createdAt: e.ts }],
        });
        order.push(e.id);
        break;
      }
      case 'set_anchors': {
        for (const a of e.anchors) {
          const thread = byId.get(a.thread);
          if (thread?.file === e.file) byId.set(a.thread, { ...thread, range: a.range,
            anchor: { revision: e.revision, from: a.from, to: a.to, status: a.status } });
        }
        break;
      }
      case 'reply': {
        const t = byId.get(e.thread);
        if (!t) break;
        byId.set(t.id, {
          ...t,
          comments: [
            ...t.comments,
            {
              id: `${t.id}.c${t.comments.length + 1}`,
              author: e.author,
              body: e.body,
              createdAt: e.ts,
            },
          ],
        });
        break;
      }
      case 'resolve': {
        const t = byId.get(e.thread);
        if (t) byId.set(t.id, { ...t, status: 'resolved' });
        break;
      }
      case 'reopen': {
        const t = byId.get(e.thread);
        if (t) byId.set(t.id, { ...t, status: 'open' });
        break;
      }
      case 'delete_thread': deletedThreads.add(e.thread); break;
      case 'restore_thread': deletedThreads.delete(e.thread); break;
      case 'delete_comment': deletedComments.add(e.comment); break;
      case 'restore_comment': deletedComments.delete(e.comment); break;
      case 'edit_comment': {
        // The comment id is `<thread>.c<N>`; derive the thread from it.
        const threadId = e.comment.slice(0, e.comment.lastIndexOf('.c'));
        const t = byId.get(threadId);
        if (!t) break;
        const idx = t.comments.findIndex((c) => c.id === e.comment);
        if (idx === -1) break;
        const comments = t.comments.slice();
        comments[idx] = { ...comments[idx], body: e.body, editedAt: e.ts };
        byId.set(t.id, { ...t, comments });
        break;
      }
    }
  }

  return {
    version: 1,
    name,
    createdAt: events.length ? events[0].ts : '',
    threads: order.filter(id => includeDeleted || !deletedThreads.has(id)).map(id => {
      const thread = byId.get(id)!;
      return { ...thread, comments: thread.comments.filter(c => !deletedComments.has(c.id)) };
    }).filter(thread => thread.comments.length > 0),
  };
}
