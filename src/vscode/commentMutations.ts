import * as fs from 'node:fs';
import * as path from 'node:path';
import { CommentMutation, validateCommentMutation, commentMutationEvent } from '../core/commentMutation';
import { sourceRevision } from '../core/sourceSnapshots';
import { readLog, logPath } from '../core/storage';
import { validateReviewName, workspaceFile } from '../core/safePaths';
import { ReviewService } from './reviewService';
import { SourceTransactions } from './sourceTransactions';
/** One validated operation is one append-only event, including its durable retry identity. */
export class CommentMutations {
  constructor(private root: string, private service: ReviewService, private sources: SourceTransactions) {}
  async mutate(request: CommentMutation) {
    validateCommentMutation(request);
    validateReviewName(request.review);
    workspaceFile(this.root, request.file);
    if (!request.file.endsWith('.tex')) throw new Error('Only workspace TeX sources are supported.');
    const digest = sourceRevision(JSON.stringify(request));
    const dir = path.join(this.root,'.review');
    if (!this.service.list().includes(request.review)) throw new Error('Review not found.');
    // Source recovery must finish before publishing any further review events.
    await this.sources.recover();
    const previous = readLog(dir,request.review).find(event => event.apiRequest?.id === request.id);
    const result = {id:request.id,review:request.review,thread:request.thread,action:request.action,committed:true};
    const sync = () => { const fd=fs.openSync(logPath(dir,request.review),'r');try {fs.fsyncSync(fd);}finally {fs.closeSync(fd);} };
    if (previous) {
      if (previous.apiRequest!.digest !== digest) throw new Error('Comment request ID was already used for a different request.');
      sync(); this.service.refreshAll(); return result;
    }
    const current = await this.sources.read(request.file);
    if (request.reviewRevision !== current.reviewRevision) throw new Error('Revision conflict. Read the source and comments again.');
    const thread = current.threads.find(thread => thread.review === request.review && thread.id === request.thread);
    if (!thread) throw new Error('Comment not found in this source.');
    const event = commentMutationEvent(request,thread,new Date().toISOString());
    if (request.dryRun) return {...result,committed:false,validated:true};
    // No await between the revision check and append: UI and API writers share this event loop.
    this.service.apply({...event,apiRequest:{id:request.id,digest}},request.review);
    sync();
    return result;
  }
}
