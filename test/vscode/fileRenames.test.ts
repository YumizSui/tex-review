import {describe,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {ReviewService} from '../../src/vscode/reviewService';
import {FileRenames,sourceAliases,validateRenameRequest} from '../../src/vscode/fileRenames';
import {readLog} from '../../src/core/storage';

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'tr-rename-')),dir=path.join(root,'.review'),text='先頭\n対象の文章。\n末尾\n';
 fs.writeFileSync(path.join(root,'old.md'),text);
 const service=new ReviewService(dir);
 for(const name of ['one','two']) {
  service.createReview(name);service.updateDocument('old.md',text);
  service.apply({op:'add_thread',id:'thread_'+name,file:'old.md',range:{startLine:2,endLine:2},snapshot:'対象の文章。',body:'元のコメント',author:'reviewer',tags:['question'],ts:'now'},name);
  service.apply({op:'reply',thread:'thread_'+name,body:'AI返信',author:'agent',ts:'now'},name);
  service.apply({op:'resolve',thread:'thread_'+name,ts:'now'},name);
 }
 service.apply({op:'delete_thread',thread:'thread_two',ts:'now'},'two');
 service.checkpoint('old.md');
 return {root,dir,text,service,renames:new FileRenames(root,service)};
}
describe('reviewed file renames',()=>{
 it('moves all reviews, hidden/resolved threads and anchor checkpoints, preserving identity and history',()=>{
  const f=fixture(),original=f.service.view('one').threads[0],notified=vi.fn();f.service.onSourceRenamed(notified);
  const before=fs.readFileSync(path.join(f.root,'old.md'));
  f.renames.stage([{from:'old.md',to:'new.md'}],'rename_test_001','dry-run',false,true);
  expect(f.service.transactionPending).toBe(false);expect(fs.existsSync(path.join(f.dir,'rename-pending.json'))).toBe(false);
  f.renames.stage([{from:'old.md',to:'new.md'}],'rename_test_001');
  fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));f.renames.recover();
  const restarted=new ReviewService(f.dir),thread=restarted.view('one').threads[0];
  expect(thread).toMatchObject({...original,file:'new.md'});
  expect(restarted.view('two').threads).toHaveLength(0);
  expect(restarted.view('two',true).threads[0]).toMatchObject({file:'new.md',status:'resolved'});
  expect(sourceAliases(f.root,'new.md')).toEqual(['old.md']);
  expect(fs.readFileSync(path.join(f.root,'new.md'))).toEqual(before);
  expect(f.service.trackedFiles()).not.toContain('old.md');expect(notified).toHaveBeenCalledWith('old.md','new.md');
  expect(fs.readdirSync(path.join(f.dir,'anchors')).filter(n=>n.endsWith('.json'))).toHaveLength(1);
 });
 it('recovers a crash after only the first review event, without duplicate events',()=>{
  const f=fixture(),apply=f.service.apply.bind(f.service);
  f.renames.stage([{from:'old.md',to:'new.md'}],'rename_crash_001');fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));
  vi.spyOn(f.service,'apply').mockImplementation((event,review)=>{const result=apply(event,review);throw new Error('crash');return result;});
  expect(()=>f.renames.recover()).toThrow('crash');
  const service=new ReviewService(f.dir),restarted=new FileRenames(f.root,service);restarted.recover();
  for(const name of ['one','two']) {
   expect(service.view(name,true).threads[0].file).toBe('new.md');
   expect(readLog(f.dir,name).filter(e=>e.op==='rename_file')).toHaveLength(1);
  }
 });
 it('aborts a cancelled rename and refuses conflicting external changes',()=>{
  const f=fixture();f.renames.stage([{from:'old.md',to:'new.md'}]);
  expect(f.renames.recover()).toMatchObject({committed:false});expect(f.service.transactionPending).toBe(false);
  f.renames.stage([{from:'old.md',to:'new.md'}]);fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));fs.writeFileSync(path.join(f.root,'new.md'),'unrelated');
  expect(()=>f.renames.recover()).toThrow('conflict');expect(fs.readFileSync(path.join(f.root,'new.md'),'utf8')).toBe('unrelated');
  expect(fs.existsSync(path.join(f.dir,'rename-pending.json'))).toBe(true);
 });
 it('rejects a corrupt intent before publishing source or review changes',()=>{
  const f=fixture();f.renames.stage([{from:'old.md',to:'new.md'}]);fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));
  const p=path.join(f.dir,'rename-pending.json'),plan=JSON.parse(fs.readFileSync(p,'utf8'));plan.files[0].text='corrupted';fs.writeFileSync(p,JSON.stringify(plan));
  expect(()=>f.renames.recover()).toThrow('Corrupt');expect(readLog(f.dir,'one').filter(e=>e.op==='rename_file')).toHaveLength(0);
  expect(fs.readFileSync(path.join(f.root,'new.md'),'utf8')).toBe(f.text);
 });
 it('follows unique identical external renames and refuses ambiguous copies',()=>{
  const f=fixture();fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));f.service.syncDisk('old.md');
  f.renames.followExternal('new.md');expect(f.service.view('one').threads[0]).toMatchObject({file:'new.md',anchor:{status:'attached'}});
  fs.writeFileSync(path.join(f.root,'copy.md'),f.text);f.service.updateDocument('copy.md',f.text);fs.unlinkSync(path.join(f.root,'copy.md'));
  fs.renameSync(path.join(f.root,'new.md'),path.join(f.root,'third.md'));f.renames.followExternal('third.md');
  expect(f.service.view('one').threads[0].file).toBe('new.md');
 });
 it('renames a directory batch and retains path ancestry across repeated renames',()=>{
  const f=fixture();fs.mkdirSync(path.join(f.root,'folder'));fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'folder/old.md'));
  f.renames.followExternal('folder/old.md');
  f.renames.stage([{from:'folder/old.md',to:'renamed/old.md'}],'rename_folder_001');
  fs.renameSync(path.join(f.root,'folder'),path.join(f.root,'renamed'));f.renames.recover();
  expect(sourceAliases(f.root,'renamed/old.md')).toEqual(['folder/old.md','old.md']);
  expect(f.service.view('one').threads[0].file).toBe('renamed/old.md');
 });
 it('keeps bounded retry receipts and rejects changed requests under the same ID',()=>{
  const f=fixture(),plan=f.renames.stage([{from:'old.md',to:'new.md'}],'rename_receipt_001','test-digest');
  fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));f.renames.recover();
  expect(f.renames.receipt(plan.id,'test-digest')).toBeTruthy();expect(()=>f.renames.receipt(plan.id,'other')).toThrow('different');
  expect(fs.existsSync(path.join(f.dir,'rename-pending.json'))).toBe(false);
  expect(fs.readFileSync(path.join(f.dir,'paths.json'),'utf8')).not.toContain(f.text);
 });
 it('validates rename request types and rejects unexpected fields',()=>{
  const base={id:'rename_request_01',file:'old.md',toFile:'new.md',revision:'a'.repeat(64),reviewRevision:'b'.repeat(64)};
  expect(()=>validateRenameRequest(base)).not.toThrow();
  for(const change of [{id:undefined},{revision:undefined},{dryRun:'yes'},{extra:'x'}]) expect(()=>validateRenameRequest({...base,...change} as any)).toThrow();
 });
 it('keeps native unsaved text anchored when the editor renames its clean disk counterpart',()=>{
  const f=fixture(),edited='inserted\n'+f.text;f.service.updateDocument('old.md',edited,undefined,true);
  const before=f.service.view('one').threads[0];
  f.renames.stage([{from:'old.md',to:'new.md'}],'native_dirty_01',undefined,false,false,true);
  fs.renameSync(path.join(f.root,'old.md'),path.join(f.root,'new.md'));f.renames.recover();
  expect(f.service.view('one').threads[0]).toMatchObject({file:'new.md',sourceDirty:true,anchor:before.anchor});
  expect(fs.readFileSync(path.join(f.root,'new.md'),'utf8')).toBe(f.text);
 });
 it('rejects dirty files, existing destinations and paths outside the workspace',()=>{
  const f=fixture();f.service.updateDocument('old.md',f.text,undefined,true);
  expect(()=>f.renames.stage([{from:'old.md',to:'new.md'}])).toThrow('Save');
  f.service.updateDocument('old.md',f.text);fs.writeFileSync(path.join(f.root,'new.md'),'existing');
  expect(()=>f.renames.stage([{from:'old.md',to:'new.md'}])).toThrow();
  expect(()=>f.renames.stage([{from:'old.md',to:'../escape.md'}])).toThrow();
 });
});
