import {describe,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {ReviewService} from '../../src/vscode/reviewService';
import {SourceTransactions} from '../../src/vscode/sourceTransactions';
import {CommentMutations} from '../../src/vscode/commentMutations';
import {CommentMutation} from '../../src/core/commentMutation';
import {readLog} from '../../src/core/storage';

describe('comment API mutations',()=>{
 async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tr-comment-')),dir=path.join(root,'.review'),file='a.tex',text='日本語の本文。\n';
  fs.writeFileSync(path.join(root,file),text);
  const service=new ReviewService(dir);service.createReview('review');
  service.updateDocument(file,text);service.apply({op:'add_thread',id:'t_one',file,range:{startLine:1,endLine:1},snapshot:text.trim(),body:'元のコメント',author:'reviewer',ts:'2026-10-26T00:00:00Z'});
  const access={read:async()=>({text,dirty:false,version:1}),apply:vi.fn(),save:vi.fn()};
  const sources=new SourceTransactions(root,service,access),api=new CommentMutations(root,service,sources);
  const read=await sources.read(file),original=service.view('review').threads[0];
  const request:CommentMutation={id:'comment_request_01',file,review:'review',thread:'t_one',reviewRevision:read.reviewRevision,action:'reply',body:'修正しました。😀'};
  return {root,dir,file,text,service,sources,api,access,request,original};
 }
 it('appends one UTF-8 reply, preserves source/anchors, and retries once after restart',async()=>{
  const f=await fixture();await f.api.mutate(f.request);
  const service=new ReviewService(f.dir),sources=new SourceTransactions(f.root,service,f.access),restarted=new CommentMutations(f.root,service,sources);
  expect(await restarted.mutate(f.request)).toMatchObject({committed:true});
  const thread=service.view('review').threads[0];expect(thread.comments).toHaveLength(2);expect(thread.comments[1]).toMatchObject({body:f.request.body,author:'agent'});
  expect(thread.snapshot).toBe(f.original.snapshot);expect(thread.anchor).toEqual(f.original.anchor);expect(thread.status).toBe('open');
  expect(fs.readFileSync(path.join(f.root,f.file),'utf8')).toBe(f.text);expect(f.access.apply).not.toHaveBeenCalled();expect(f.access.save).not.toHaveBeenCalled();
  expect(readLog(f.dir,'review')).toHaveLength(2);
  await expect(restarted.mutate({...f.request,body:'different'})).rejects.toThrow('different request');
 });
 it('validates without appending and rejects a stale request after another writer replies',async()=>{
  const f=await fixture();expect(await f.api.mutate({...f.request,dryRun:true})).toMatchObject({validated:true,committed:false});expect(readLog(f.dir,'review')).toHaveLength(1);
  f.service.apply({op:'reply',thread:'t_one',body:'another writer',author:'reviewer',ts:'now'});
  await expect(f.api.mutate(f.request)).rejects.toThrow('Revision conflict');expect(readLog(f.dir,'review')).toHaveLength(2);
 });
 it('changes tags, resolves and reopens only on explicit operations, with fresh revisions',async()=>{
  const f=await fixture();
  for(const [i,action] of (['set_tags','resolve','reopen'] as const).entries()){
   const state=await f.sources.read(f.file);
   await f.api.mutate({id:'request_'+i,file:f.file,review:'review',thread:'t_one',reviewRevision:state.reviewRevision,action,...(action==='set_tags'?{tags:['question','todo'] as const}: {})} as CommentMutation);
   const thread=f.service.view('review').threads[0];expect(thread.status).toBe(action==='resolve'?'resolved':'open');expect(thread.tags).toEqual(['question','todo']);expect(thread.comments).toEqual(f.original.comments);expect(thread.anchor).toEqual(f.original.anchor);
  }
 });
 it('rejects malformed actions, unknown tags, wrong file, deleted thread, and author spoofing without appending',async()=>{
  const f=await fixture();
  for(const change of [{action:'delete_thread'},{action:'set_tags',body:undefined,tags:['typo']},{author:'reviewer'},{thread:'missing'},{file:'../outside.tex'}]){
   await expect(f.api.mutate({...f.request,...change} as any)).rejects.toThrow();expect(readLog(f.dir,'review')).toHaveLength(1);
  }
  f.service.apply({op:'delete_thread',thread:'t_one',ts:'now'});
  const state=await f.sources.read(f.file);
  await expect(f.api.mutate({...f.request,reviewRevision:state.reviewRevision})).rejects.toThrow('Comment not found');
 });
 it('allows tags on a dirty buffer, normalizes empty tags, and never saves the source',async()=>{
  const f=await fixture();vi.spyOn(f.access,'read').mockResolvedValue({text:f.text,dirty:true,version:2});
  const current=await f.sources.read(f.file);
  const {body,...base}=f.request;
  await expect(f.api.mutate({...base,reviewRevision:current.reviewRevision,action:'set_tags',tags:['invalid'] as any})).rejects.toThrow('Unknown comment tag');
  await f.api.mutate({...base,reviewRevision:current.reviewRevision,action:'set_tags',tags:[]});
  expect(f.service.view('review').threads[0].tags).toEqual(['action']);expect(f.access.save).not.toHaveBeenCalled();expect(f.access.apply).not.toHaveBeenCalled();
 });
 it('recovers a failure after append without publishing a duplicate reply',async()=>{
  const f=await fixture(),original=f.service.apply.bind(f.service);
  vi.spyOn(f.service,'apply').mockImplementation((event,review)=>{original(event,review);throw new Error('interrupted after append');});
  await expect(f.api.mutate(f.request)).rejects.toThrow('interrupted');
  expect(await f.api.mutate(f.request)).toMatchObject({committed:true});expect(f.service.view('review').threads[0].comments).toHaveLength(2);
 });
});
