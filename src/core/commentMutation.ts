import { commentTypeTags, CommentTag } from './commentFilters';
import { ReviewEvent, Thread } from './types';
export interface CommentMutation {
  id: string;
  file: string;
  review: string;
  thread: string;
  reviewRevision: string;
  action: 'reply' | 'resolve' | 'reopen' | 'set_tags';
  body?: string;
  tags?: CommentTag[];
  dryRun?: boolean;
}
export function validateCommentMutation(request: CommentMutation) {
  if (!request || typeof request !== 'object' || typeof request.id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.id) ||
      typeof request.file !== 'string' || typeof request.review !== 'string' || typeof request.thread !== 'string' || !request.thread || request.thread.length > 200 ||
      typeof request.reviewRevision !== 'string' || !/^[a-f0-9]{64}$/.test(request.reviewRevision) ||
      !['reply','resolve','reopen','set_tags'].includes(request.action) || (request.dryRun !== undefined && typeof request.dryRun !== 'boolean'))
    throw new Error('Invalid comment request.');
  const fields = ['id','file','review','thread','reviewRevision','action','dryRun', ...(request.action === 'reply' ? ['body'] : request.action === 'set_tags' ? ['tags'] : [])];
  if (Object.keys(request).some(key => !fields.includes(key))) throw new Error('Unexpected comment request field.');
  if (request.action === 'reply' && (typeof request.body !== 'string' || !request.body.trim() || request.body.length > 100000)) throw new Error('Provide a nonempty reply body (at most 100000 characters).');
  if (request.action === 'set_tags') { if (request.tags === undefined) throw new Error('Provide a tags array containing one comment type.'); commentTypeTags(request.tags); }
}
export function commentMutationEvent(request: CommentMutation, thread: Thread, ts: string): ReviewEvent {
  if (thread.id !== request.thread || thread.file !== request.file) throw new Error('Comment does not belong to the requested source.');
  switch (request.action) {
    case 'reply': return {op:'reply',thread:thread.id,author:'agent',body:request.body!,ts};
    case 'set_tags': return {op:'set_tags',thread:thread.id,tags:commentTypeTags(request.tags),ts};
    case 'resolve': case 'reopen': return {op:request.action,thread:thread.id,ts};
  }
}
