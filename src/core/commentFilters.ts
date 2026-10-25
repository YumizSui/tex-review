import type { Thread } from './types';
export const commentTagIds = ['action', 'question', 'todo', 'note'] as const;
export type CommentTag = typeof commentTagIds[number];
export const commentTagLabels: Record<CommentTag, string> = { action: 'Action required', question: 'Question', todo: 'TODO', note: 'Note' };
export function commentTags(value?: readonly string[]): CommentTag[] {
  const chosen = Array.isArray(value) ? value : [];
  const tags = commentTagIds.filter(tag => chosen.includes(tag));
  return tags.length ? tags : ['action'];
}
const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
export function commentMatches(thread: Thread, query = '', tags: readonly string[] = []): boolean {
  if (tags.length && !commentTags(thread.tags).some(tag => tags.includes(tag))) return false;
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  const text = normalized(thread.comments.map(comment => comment.body).join('\n'));
  return terms.every(term => text.includes(term));
}
export function commentPreview(thread: Thread, query = ''): string {
  const terms = normalized(query).trim().split(/\s+/).filter(Boolean);
  return (terms.length ? thread.comments.find(comment => terms.every(term => normalized(comment.body).includes(term))) : undefined)?.body
    || thread.comments[0]?.body || thread.snapshot;
}
