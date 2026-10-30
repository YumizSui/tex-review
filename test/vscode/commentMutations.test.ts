import {describe,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {ReviewService} from '../../src/vscode/reviewService';
import {SourceTransactions} from '../../src/vscode/sourceTransactions';
import {CommentMutations} from '../../src/vscode/commentMutations';
import {CommentMutation} from '../../src/core/commentMutation';
import {commentMatches} from '../../src/core/commentFilters';
import {readLog} from '../../src/core/storage';

describe('comment API mutations',()=>{
 async function fixture(file = 'a.tex'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tr-comment-')),dir=path.join(root,'.review'),text='日本語の本文。\n';
  fs.writeFileSync(path.join(root,file),text);
  const service=new ReviewService(dir);service.createReview('review');
  service.updateDocument(file,text);service.apply({op:'add_thread',id:'t_one',file,range:{startLine:1,endLine:1},snapshot:text.trim(),body:'元のコメント',author:'reviewer',ts:'2026-10-26T00:00:00Z'});
  const access={read:async()=>({text,dirty:false,version:1}),apply:vi.fn(),save:vi.fn()};
  const sources=new SourceTransactions(root,service,access),api=new CommentMutations(root,service,sources);
  const read=await sources.read(file),original=service.view('review').threads[0];
  const request:CommentMutation={id:'comment_request_01',file,review:'review',thread:'t_one',reviewRevision:read.reviewRevision,action:'reply',body:'修正しました。😀'};
  return {root,dir,file,text,service,sources,api,access,request,original};
 }
 it.each(['a.tex','notes.txt','README.md'])('replies to %s with UTF-8, preserves source/anchors, and retries once after restart',async(file)=>{
  const f=await fixture(file);await f.api.mutate(f.request);
  const service=new ReviewService(f.dir),sources=new SourceTransactions(f.root,service,f.access),restarted=new CommentMutations(f.root,service,sources);
  expect(await restarted.mutate(f.request)).toMatchObject({committed:true});
  const thread=service.view('review').threads[0];expect(thread.comments).toHaveLength(2);expect(thread.comments[1]).toMatchObject({body:f.request.body,author:'agent'});
  expect(thread.snapshot).toBe(f.original.snapshot);expect(thread.anchor).toEqual(f.original.anchor);expect(thread.status).toBe('open');
  expect(fs.readFileSync(path.join(f.root,f.file),'utf8')).toBe(f.text);expect(f.access.apply).not.toHaveBeenCalled();expect(f.access.save).not.toHaveBeenCalled();
  expect(readLog(f.dir,'review')).toHaveLength(2);
  await expect(restarted.mutate({...f.request,body:'different'})).rejects.toThrow('different request');
 });
 it.each(['a.tex','notes.txt','README.md'])('creates an AI thread on %s with exact anchors and durable retries',async(file)=>{
  const f=await fixture(file),state=await f.sources.read(file);
  const request:CommentMutation={id:'create_request_01',action:'create',file,review:'review',revision:state.revision,reviewRevision:state.reviewRevision,from:0,to:3,quote:'日本語',body:'この説明を確認してください。😀',tags:['question']};
  const before=readLog(f.dir,'review').length;
  expect(await f.api.mutate({...request,dryRun:true})).toMatchObject({validated:true,committed:false});
  expect(readLog(f.dir,'review')).toHaveLength(before);
  const result=await f.api.mutate(request);
  const service=new ReviewService(f.dir),sources=new SourceTransactions(f.root,service,f.access),restarted=new CommentMutations(f.root,service,sources);
  expect(await restarted.mutate(request)).toEqual(result);
  const thread=(await sources.read(file)).threads.find(t=>t.id===result.thread)!;
  expect(thread).toMatchObject({snapshot:'日本語',currentQuote:'日本語',tags:['question'],status:'open',anchor:{revision:state.revision,from:0,to:3,status:'attached'},range:{startLine:1,endLine:1,startColumn:1,endColumn:4}});
  expect(thread.comments).toEqual([expect.objectContaining({author:'agent',body:request.body})]);
  expect(commentMatches(thread,'',[],'ai-replied')).toBe(true);
  expect(commentMatches(thread,'',[],'no-ai-reply')).toBe(false);
  expect(readLog(f.dir,'review')).toHaveLength(before+1);
  expect(f.access.apply).not.toHaveBeenCalled();expect(f.access.save).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(f.root,file),'utf8')).toBe(f.text);
  await expect(restarted.mutate({...request,body:'different'})).rejects.toThrow('different request');
 });
 it('discovers an empty review and creates there without switching the active review',async()=>{
  const f=await fixture();f.service.createReview('empty');f.service.setActive('review');
  const state=await f.sources.read(f.file);
  expect(state.reviews).toEqual(expect.arrayContaining(['review','empty']));expect(state.activeReview).toBe('review');
  const result=await f.api.mutate({id:'create_empty_01',action:'create',file:f.file,review:'empty',revision:state.revision,reviewRevision:state.reviewRevision,from:0,to:3,quote:'日本語',body:'New review comment.'});
  expect(f.service.view('empty').threads[0].id).toBe(result.thread);expect(f.service.active()).toBe('review');
 });
 it('rejects stale source, wrong quote, invalid offsets, tags and spoofing before creation',async()=>{
  const f=await fixture(),state=await f.sources.read(f.file);
  const request={id:'create_invalid_01',action:'create',file:f.file,review:'review',revision:state.revision,reviewRevision:state.reviewRevision,from:0,to:3,quote:'日本語',body:'Check this.'};
  for(const change of [{revision:'0'.repeat(64)},{quote:'wrong'},{from:-1},{to:999},{from:0.5},{to:1,quote:3},{tags:['invalid']},{tags:['question','todo']},{author:'reviewer'},{thread:'chosen_by_client'},{body:''},{review:'missing'}]){
   await expect(f.api.mutate({...request,...change} as any)).rejects.toThrow();
   expect(readLog(f.dir,'review')).toHaveLength(1);
  }
  f.service.apply({op:'reply',thread:'t_one',body:'human update',author:'reviewer',ts:'now'});
  await expect(f.api.mutate(request as CommentMutation)).rejects.toThrow('Revision conflict');
 });
 it('creates against the current dirty buffer without saving, and tracks later source edits',async()=>{
  const f=await fixture('README.md'),text='😀日本語\r\n本文';
  vi.spyOn(f.access,'read').mockResolvedValue({text,dirty:true,version:2});
  const state=await f.sources.read(f.file);
  const request:CommentMutation={id:'create_dirty_01',action:'create',file:f.file,review:'review',revision:state.revision,reviewRevision:state.reviewRevision,from:2,to:5,quote:'日本語',body:'Check this.'};
  const result=await f.api.mutate(request);
  const created=(await f.sources.read(f.file)).threads.find(t=>t.id===result.thread)!;
  expect(created).toMatchObject({currentQuote:'日本語',tags:['action'],sourceDirty:true,anchor:{from:2,to:5,status:'attached'}});
  const latest=await f.sources.read(f.file);
  await expect(f.api.mutate({...request,id:'create_surrogate_01',reviewRevision:latest.reviewRevision,from:0,to:1,quote:'\uD83D'})).rejects.toThrow('Unicode');
  vi.spyOn(f.access,'read').mockResolvedValue({text:'prefix '+state.text,dirty:true,version:3});
  const moved=(await f.sources.read(f.file)).threads.find(t=>t.id===result.thread)!;
  expect(moved.currentQuote).toBe('日本語');expect(moved.anchor?.from).toBe(9);
  expect(f.access.save).not.toHaveBeenCalled();expect(f.access.apply).not.toHaveBeenCalled();
 });
 it('recovers creation after an interrupted append without creating a second thread',async()=>{
  const f=await fixture(),state=await f.sources.read(f.file);
  const request:CommentMutation={id:'create_interrupt_01',action:'create',file:f.file,review:'review',revision:state.revision,reviewRevision:state.reviewRevision,from:0,to:0,quote:'',body:'Point comment.'};
  const original=f.service.apply.bind(f.service);
  vi.spyOn(f.service,'apply').mockImplementation((event,review)=>{original(event,review);throw new Error('interrupted');});
  await expect(f.api.mutate(request)).rejects.toThrow('interrupted');
  expect(await f.api.mutate(request)).toMatchObject({committed:true});
  expect(f.service.view('review').threads).toHaveLength(2);
  expect(readLog(f.dir,'review')).toHaveLength(2);
 });
 it('moves a thread to another file with all comments, type and status intact',async()=>{
  const f=await fixture(),dest='destination.md',text='前文。日本語の本文。後文。';fs.writeFileSync(path.join(f.root,dest),text);
  vi.spyOn(f.access,'read').mockImplementation(async(file?:string)=>({text:file===dest?text:f.text,dirty:false,version:1}));
  f.service.apply({op:'reply',thread:'t_one',body:'existing reply',author:'agent',ts:'now'});
  f.service.apply({op:'resolve',thread:'t_one',ts:'now'});
  const original=f.service.view('review').threads[0],before=await f.sources.read(f.file),target=await f.sources.read(dest);
  const request:CommentMutation={id:'move_thread_001',action:'move',file:f.file,review:'review',thread:'t_one',reviewRevision:before.reviewRevision,destination:{file:dest,revision:target.revision,reviewRevision:target.reviewRevision,from:3,to:10,quote:text.slice(3,10)}};
  expect(await f.api.mutate({...request,dryRun:true})).toMatchObject({committed:false});
  const result=await f.api.mutate(request);expect(await f.api.mutate(request)).toEqual(result);
  const service=new ReviewService(f.dir),moved=service.view('review').threads[0];
  expect(moved).toMatchObject({file:dest,id:original.id,snapshot:original.snapshot,comments:original.comments,status:'resolved',tags:original.tags,anchor:{from:3,to:10,status:'attached'}});
  expect((await f.sources.read(f.file)).threads).toHaveLength(0);
  expect(fs.readFileSync(path.join(f.root,f.file),'utf8')).toBe(f.text);expect(fs.readFileSync(path.join(f.root,dest),'utf8')).toBe(text);
  await expect(f.api.mutate({...request,id:'move_wrong_001',destination:{...request.destination,quote:'wrong'}})).rejects.toThrow();
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
   await f.api.mutate({id:'request_'+i,file:f.file,review:'review',thread:'t_one',reviewRevision:state.reviewRevision,action,...(action==='set_tags'?{tags:['question'] as const}: {})} as CommentMutation);
   const thread=f.service.view('review').threads[0];expect(thread.status).toBe(action==='resolve'?'resolved':'open');expect(thread.tags).toEqual(['question']);expect(thread.comments).toEqual(f.original.comments);expect(thread.anchor).toEqual(f.original.anchor);
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
  await expect(f.api.mutate({...base,reviewRevision:current.reviewRevision,action:'set_tags',tags:['invalid'] as any})).rejects.toThrow('Choose one comment type');
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
