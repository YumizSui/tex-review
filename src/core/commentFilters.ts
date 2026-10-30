import type { Thread } from './types';
export const commentTagIds = ['action', 'question', 'todo', 'note'] as const;
export type CommentTag = typeof commentTagIds[number];
export const commentTagLabels: Record<CommentTag, string> = { action: 'Action required', question: 'Question', todo: 'TODO', note: 'Note' };
export function commentTags(value?: readonly string[]): CommentTag[] {
  const chosen = Array.isArray(value) ? value : [];
  const tags = commentTagIds.filter(tag => chosen.includes(tag));
  return tags.length ? tags : ['action'];
}
/** New writes use one type; commentTags still reads historical multi-tag threads. */
export function commentTypeTags(value: unknown = ['action']): CommentTag[] {
  if (!Array.isArray(value) || value.length > 1 || value.some(tag => !commentTagIds.includes(tag)))
    throw new Error('Choose one comment type: action, question, todo, or note.');
  return commentTags(value);
}
export const commentReplyFilters = ['all', 'ai-replied', 'no-ai-reply'] as const;
export type CommentReplyFilter = typeof commentReplyFilters[number];
export const commentReplyLabels: Record<CommentReplyFilter, string> = {
  all: 'Any reply status', 'ai-replied': 'AI replied, unresolved', 'no-ai-reply': 'No AI reply, unresolved',
};
const normalized = (text: string) => text.normalize('NFKC').toLowerCase();
export function commentMatches(thread: Thread, query = '', tags: readonly string[] = [], replies: CommentReplyFilter = 'all'): boolean {
  if (replies !== 'all') {
    // Include AI-authored openings; a later human reply starts a new turn.
    const aiReplied = thread.comments.at(-1)?.author === 'agent';
    if (thread.status !== 'open' || (replies === 'ai-replied' ? !aiReplied : aiReplied)) return false;
  }
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
