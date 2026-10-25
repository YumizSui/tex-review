import {describe,it,expect} from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

describe('installed CLI response decoding',()=>{
 it.each([true,false])('decodes split Japanese and emoji and accepts only an intact revision (valid=%s)',async(validRevision)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tr-utf8-')),endpoint=path.join(root,'api.sock');
  const text='疑似パープレキシティ😀を確認する。'.repeat(800),revision=validRevision?createHash('sha256').update(text).digest('hex'):'invalid-revision';
  const payload=Buffer.from(JSON.stringify({ok:true,result:{text,revision}})+'\n','utf8');
  const japanese=payload.indexOf(Buffer.from('疑')),emoji=payload.indexOf(Buffer.from('😀'));
  const cuts=[japanese+1,japanese+2,emoji+1,emoji+2,emoji+3,...Array.from({length:Math.floor(payload.length/8192)},(_,i)=>(i+1)*8192),payload.length].sort((a,b)=>a-b);
  const sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
   sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
   socket.once('data',()=>{void(async()=>{let start=0;for(const end of cuts){socket.write(payload.subarray(start,end));start=end;await delay(15);}socket.end();})();});
  });
  try{
   await new Promise<void>(resolve=>server.listen(endpoint,resolve));
   fs.mkdirSync(path.join(root,'.review'));fs.writeFileSync(path.join(root,'.review/api.json'),JSON.stringify({endpoint,session:'fixture'}));
   const result=await new Promise<{code:number|null;out:string;err:string}>(resolve=>{
    const child=spawn(process.execPath,[path.resolve('bin/tex-review.mjs'),'read','source.tex'],{cwd:root,stdio:['ignore','pipe','pipe']});
    const out:Buffer[]=[],err:Buffer[]=[];child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>err.push(chunk));
    child.on('close',code=>resolve({code,out:Buffer.concat(out).toString('utf8'),err:Buffer.concat(err).toString('utf8')}));
   });
   if(!validRevision){expect(result.code).toBe(1);expect(result.out).toBe('');expect(result.err).toContain('revision integrity');return;}
   expect(result.code,result.err).toBe(0);const decoded=JSON.parse(result.out);
   expect(decoded.result.text === text, 'Complete UTF-8 source round-trip').toBe(true);expect(decoded.result.text).not.toContain('\uFFFD');
   expect(createHash('sha256').update(decoded.result.text).digest('hex')).toBe(decoded.result.revision);
  }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));fs.rmSync(root,{recursive:true,force:true});}
 },10000);
});
