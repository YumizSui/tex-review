import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { projectSources } from '../../src/core/projectSources';
import { projectComments } from '../../src/core/projectComments';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-manuscript-'));
afterEach(() => { for (const name of fs.readdirSync(root)) fs.rmSync(path.join(root,name), {recursive:true,force:true}); });
const put = (name:string,text:string) => { fs.mkdirSync(path.dirname(path.join(root,name)),{recursive:true}); fs.writeFileSync(path.join(root,name),text); };
describe('manuscript membership',()=>{
  it('uses exact recorder inputs, retaining build order and excluding unrelated sources',()=>{
    put('main.tex','\\input{excluded}'); put('chapter.tex',''); put('excluded.tex',''); put('other.tex','');
    put('build/main.fls',`PWD ${root}\nINPUT ./main.tex\nINPUT chapter.tex\nINPUT chapter.tex\nINPUT /outside.tex\n`);
    expect(projectSources(root,'main.tex',path.join(root,'build/main.pdf'))).toEqual({files:['main.tex','chapter.tex'],origin:'recorder'});
    put('build/main.fls',`PWD ${root}\nINPUT main.tex\n`);
    expect(projectSources(root,'main.tex',path.join(root,'build/main.pdf')).files).toEqual(['main.tex']);
  });
  it('falls back to SyncTeX and does not follow a symlink outside the workspace',()=>{
    put('main.tex',''); put('ja/chapter.tex',''); fs.symlinkSync('/etc/hosts',path.join(root,'outside.tex'));
    fs.writeFileSync(path.join(root,'main.synctex.gz'),gzipSync('Input:1:main.tex\nInput:2:ja/chapter.tex\nInput:3:outside.tex\n'));
    expect(projectSources(root,'main.tex',path.join(root,'main.pdf'))).toEqual({files:['main.tex','ja/chapter.tex'],origin:'synctex'});
  });
  it('traverses literal includes only, handles cycles and ignores commented includes',()=>{
    put('main.tex','\\input{ja/a}\n% \\include{other}\n\\include{ja/b}');
    put('ja/a.tex','\\input{main}');put('ja/b.tex','');put('other.tex','');
    expect(projectSources(root,'main.tex').files).toEqual(['main.tex','ja/a.tex','ja/b.tex']);
  });
  it('keeps languages separate and includes shared source in either root',()=>{
    put('main.tex','\\input{en}\\input{shared}');put('main_ja.tex','\\input{ja}\\input{shared}');
    for(const name of ['en','ja','shared','unrelated']) put(name+'.tex','');
    expect(projectSources(root,'main.tex').files).toEqual(['main.tex','en.tex','shared.tex']);
    expect(projectSources(root,'main_ja.tex').files).toEqual(['main_ja.tex','ja.tex','shared.tex']);
  });
  it('sorts comments across included files with a stable order for the same line',()=>{
    const make=(id:string,file:string,line:number,status='open')=>({id,file,range:{startLine:line},status} as any);
    const threads=[make('z','b.tex',1),make('b','a.tex',9),make('a','a.tex',9),make('outside','outside.tex',1),make('resolved','a.tex',1,'resolved')];
    expect(projectComments(threads,['a.tex','b.tex']).map(t=>t.id)).toEqual(['a','b','z']);
    expect(projectComments(threads,['b.tex','a.tex'],true).map(t=>t.id)).toEqual(['z','resolved','a','b']);
  });
});
