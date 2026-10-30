import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { workspaceFile, rejectSymlink } from '../core/safePaths';
import { sourceText } from '../core/commentAnchors';
import { sourceRevision } from '../core/sourceSnapshots';
import { readLog, logPath } from '../core/storage';
import { RenameFileEvent } from '../core/types';
import { ReviewService } from './reviewService';

interface Plan {
  id: string; digest: string;
  files: Array<{from:string;to:string;text:string;revision:string;diskRevision:string;dirty:boolean}>;
  events: Array<{review:string;event:RenameFileEvent}>;
}
interface Paths { aliases: Record<string,string[]>; receipts: Array<{id:string;digest:string}> }
export interface RenameRequest { id:string;file:string;toFile:string;revision:string;reviewRevision:string;dryRun?:boolean }
export function validateRenameRequest(r: RenameRequest) {
  if (!r || typeof r!=='object' || Object.keys(r).some(k=>!['id','file','toFile','revision','reviewRevision','dryRun'].includes(k)) || typeof r.id!=='string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(r.id) || typeof r.file!=='string' || typeof r.toFile!=='string' || typeof r.revision!=='string' || !/^[a-f0-9]{64}$/.test(r.revision) || typeof r.reviewRevision!=='string' || !/^[a-f0-9]{64}$/.test(r.reviewRevision) || (r.dryRun!==undefined&&typeof r.dryRun!=='boolean')) throw new Error('Invalid rename request.');
}
export function sourceAliases(root: string,file: string): string[] {
  const p=workspaceFile(root,'.review/paths.json'); rejectSymlink(p);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')).aliases?.[file] ?? [] : [];
}
/** An intent precedes the filesystem rename; replay only verified destinations. */
export class FileRenames {
  constructor(private root: string,private service: ReviewService) {}
  private store(file: string) { const p=workspaceFile(this.root,'.review/'+file);rejectSymlink(p);return p; }
  private journal() { const p=this.store('rename-pending.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')) as Plan:null; }
  private paths(): Paths { const p=this.store('paths.json');return fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{aliases:{},receipts:[]}; }
  private write(file: string,data: unknown) {
    const target=this.store(file),tmp=target+'.tmp';rejectSymlink(tmp);fs.mkdirSync(path.dirname(target),{recursive:true});
    const fd=fs.openSync(tmp,'w',0o600);try{fs.writeFileSync(fd,JSON.stringify(data));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(tmp,target);
    if (process.platform!=='win32') {const directory=fs.openSync(path.dirname(target),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
  }
  receipt(id: string,digest: string) {
    const receipt=this.paths().receipts.find(r=>r.id===id);
    if (receipt && receipt.digest!==digest) throw new Error('Rename request ID was already used for a different request.');
    return receipt;
  }
  pendingMatches(pairs: Array<{from:string;to:string}>) {
    const p=this.journal();return !!p && JSON.stringify(p.files.map(({from,to})=>({from,to})))===JSON.stringify(pairs);
  }
  stage(pairs: Array<{from:string;to:string}>, id='native_'+randomUUID(), digest=sourceRevision(JSON.stringify(pairs)), external=false, dryRun=false, allowDirty=false) {
    if (this.journal() || this.service.transactionPending) throw new Error('Recover the pending operation before renaming files.');
    if (!pairs.length || new Set(pairs.map(p=>p.from)).size!==pairs.length || new Set(pairs.map(p=>p.to)).size!==pairs.length || pairs.some(p=>pairs.some(q=>p.to===q.from))) throw new Error('Overlapping rename targets are not supported.');
    const plan: Plan={id,digest,files:[],events:[]};
    for (const {from,to} of pairs) {
      const old=workspaceFile(this.root,from),next=workspaceFile(this.root,to);rejectSymlink(old);rejectSymlink(next);
      if (path.relative(this.root,old).split(path.sep).join('/')!==from || path.relative(this.root,next).split(path.sep).join('/')!==to) throw new Error('Use canonical workspace-relative file paths.');
      if (this.service.list().some(name=>this.service.view(name,true).threads.some(t=>t.file===to))) throw new Error('Destination already has review comments. Move threads explicitly instead.');
      if (from===to || fs.existsSync(old)===external || fs.existsSync(next)!==external) throw new Error('Rename requires an existing source and a new destination.');
      const snapshot=this.service.renameSnapshot(from);
      const actual=sourceText(fs.readFileSync(external?next:old,'utf8')).toString();
      if ((snapshot.dirty && !allowDirty) || (!snapshot.dirty && snapshot.text!==actual)) throw new Error('Save and refresh the reviewed source before renaming.');
      plan.files.push({from,to,text:snapshot.text,revision:snapshot.revision,diskRevision:sourceRevision(actual),dirty:snapshot.dirty});
      for (const review of snapshot.reviews) if (review.anchors.length) plan.events.push({review:review.review,event:{op:'rename_file',fromFile:from,file:to,revision:snapshot.revision,anchors:review.anchors,renameId:id,ts:new Date().toISOString()}});
    }
    if (!dryRun) {this.write('rename-pending.json',plan);this.service.beginTransaction();} return plan;
  }
  recover() {
    const plan=this.journal();if (!plan) return {pending:false};
    if (!this.service.transactionPending) this.service.beginTransaction();
    const paths=this.paths();
    const published=plan.events.some(({review})=>readLog(path.join(this.root,'.review'),review).some(e=>e.op==='rename_file'&&e.renameId===plan.id));
    if (!published && plan.files.every(f=>fs.existsSync(workspaceFile(this.root,f.from))&&!fs.existsSync(workspaceFile(this.root,f.to)))) {
      fs.unlinkSync(this.store('rename-pending.json'));this.service.endTransaction();return {pending:false,committed:false,id:plan.id};
    }
    for (const f of plan.files) {
      if (typeof f.text!=='string' || sourceRevision(f.text)!==f.revision) throw new Error('Corrupt rename intent. Recovery is required.');
      const old=workspaceFile(this.root,f.from),next=workspaceFile(this.root,f.to);rejectSymlink(old);rejectSymlink(next);
      if (fs.existsSync(old) || !fs.existsSync(next) || sourceRevision(sourceText(fs.readFileSync(next,'utf8')).toString())!==(f.diskRevision??f.revision)) throw new Error('Renamed files conflict with the pending operation. No file was overwritten; recovery is required.');
    }
    for (const f of plan.files) this.service.updateDocument(f.to,f.text,undefined,f.dirty);
    for (const {review,event} of plan.events) {
      if (!readLog(path.join(this.root,'.review'),review).some(e=>e.op==='rename_file'&&e.renameId===plan.id&&e.fromFile===event.fromFile)) this.service.apply(event,review);
      const fd=fs.openSync(logPath(path.join(this.root,'.review'),review),'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    }
    for (const f of plan.files) {
      paths.aliases[f.to]=[...new Set([f.from,...(paths.aliases[f.from]??[]),...(paths.aliases[f.to]??[])])].filter(p=>p!==f.to);
      delete paths.aliases[f.from];
    }
    if (!paths.receipts.some(r=>r.id===plan.id)) paths.receipts.push({id:plan.id,digest:plan.digest});
    paths.receipts=paths.receipts.slice(-100);this.write('paths.json',paths);
    for (const f of plan.files) this.service.forgetSource(f.from);
    fs.unlinkSync(this.store('rename-pending.json'));this.service.endTransaction();
    for (const f of plan.files) this.service.sourceRenamed(f.from,f.to);
    return {pending:false,committed:true,id:plan.id};
  }
  followExternal(to: string) {
    if (this.journal() || this.service.transactionPending) return;
    const target=workspaceFile(this.root,to);if (!fs.existsSync(target)||!fs.statSync(target).isFile()) return;
    const text=sourceText(fs.readFileSync(target,'utf8')).toString();
    const matches=this.service.trackedFiles().filter(from=>from!==to&&!fs.existsSync(workspaceFile(this.root,from))).filter(from=>{
      const s=this.service.renameSnapshot(from);return !s.dirty&&s.text===text;
    });
    if (this.service.list().some(name=>this.service.view(name,true).threads.some(t=>t.file===to))) return;
    if (matches.length===1) {this.stage([{from:matches[0],to}],undefined,undefined,true);this.recover();}
  }
}
