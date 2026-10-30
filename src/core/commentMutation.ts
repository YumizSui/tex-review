import { commentTypeTags, CommentTag } from './commentFilters';
import { sourceText, lineRange } from './commentAnchors';
import { sourceRevision } from './sourceSnapshots';
import { AddThreadEvent, ReviewEvent, Thread } from './types';
interface CommentMutationBase {
  id: string;
  file: string;
  review: string;
  reviewRevision: string;
  body?: string;
  tags?: CommentTag[];
  dryRun?: boolean;
}
export type ExistingCommentMutation = CommentMutationBase & { thread: string; action: 'reply' | 'resolve' | 'reopen' | 'set_tags' };
export type CreateCommentMutation = CommentMutationBase & { action: 'create'; revision: string; from: number; to: number; quote: string };
export type CommentMutation = ExistingCommentMutation | CreateCommentMutation;
export function validateCommentMutation(request: CommentMutation) {
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.id) ||
      typeof request.file !== 'string' || typeof request.review !== 'string' ||
      typeof request.reviewRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.reviewRevision) ||
      !['create','reply','resolve','reopen','set_tags'].includes(request.action) || (request.dryRun !== undefined && typeof request.dryRun !== 'boolean'))
    throw new Error('Invalid comment request.');
  const fields = ['id','file','review','reviewRevision','action','dryRun', ...(request.action === 'create' ? ['revision','from','to','quote','body','tags'] : ['thread', ...(request.action === 'reply' ? ['body'] : request.action === 'set_tags' ? ['tags'] : [])])];
  if (Object.keys(request).some(key => !fields.includes(key))) throw new Error('Unexpected comment request field.');
  if (request.action !== 'create' && (typeof request.thread !== 'string' || !request.thread || request.thread.length > 200)) throw new Error('Invalid comment thread.');
  if ((request.action === 'reply' || request.action === 'create') && (typeof request.body !== 'string' || !request.body.trim() || request.body.length > 100000)) throw new Error('Provide a nonempty comment body (at most 100000 characters).');
  if (request.action === 'create') {
    if (typeof request.revision !== 'string' || !/^[a-f0-9]{64}$/.test(request.revision) || !Number.isSafeInteger(request.from) || !Number.isSafeInteger(request.to) || request.from < 0 || request.to < request.from || typeof request.quote !== 'string') throw new Error('Invalid comment target.');
    commentTypeTags(request.tags);
  }
  if (request.action === 'set_tags') { if (request.tags === undefined) throw new Error('Provide a tags array containing one comment type.'); commentTypeTags(request.tags); }
}
export function commentMutationEvent(request: ExistingCommentMutation, thread: Thread, ts: string): ReviewEvent {
  if (thread.id !== request.thread || thread.file !== request.file) throw new Error('Comment does not belong to the requested source.');
  switch (request.action) {
    case 'reply': return {op:'reply',thread:thread.id,author:'agent',body:request.body!,ts};
    case 'set_tags': return {op:'set_tags',thread:thread.id,tags:commentTypeTags(request.tags),ts};
    case 'resolve': case 'reopen': return {op:request.action,thread:thread.id,ts};
  }
}

export function createCommentThreadId(request: CreateCommentMutation): string {
  return 't_api_' + sourceRevision(request.id);
}
export function createCommentEvent(request: CreateCommentMutation, text: string, ts: string): AddThreadEvent {
  if (sourceRevision(text) !== request.revision) throw new Error('Source revision conflict. Read the source again.');
  if (request.to > text.length || text.slice(request.from, request.to) !== request.quote) throw new Error('Comment target quote does not match the source.');
  const splitsSurrogate = (offset: number) => offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
  if (splitsSurrogate(request.from) || splitsSurrogate(request.to)) throw new Error('Comment target splits a Unicode character.');
  const anchor = {revision:request.revision,from:request.from,to:request.to,status:'attached' as const};
  return {op:'add_thread',id:createCommentThreadId(request),file:request.file,range:lineRange(sourceText(text),anchor),anchor,snapshot:request.quote,author:'agent',body:request.body!,tags:commentTypeTags(request.tags),ts};
}
