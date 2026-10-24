import { describe,it,expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectTargets,targetPdf } from '../../src/core/projectTargets';
describe('multiple root documents',()=>{
  it('finds both languages and prefers a PDF with SyncTeX next to it',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tex-roots-'));
    try {
      fs.writeFileSync(path.join(dir,'main.tex'),'\\documentclass{article}');
      fs.writeFileSync(path.join(dir,'main_ja.tex'),'\\documentclass[11pt]{book}');
      fs.writeFileSync(path.join(dir,'chapter.tex'),'\\section{Fragment}');
      fs.mkdirSync(path.join(dir,'build/ja'),{recursive:true});
      fs.writeFileSync(path.join(dir,'main_ja.pdf'),'root');
      fs.writeFileSync(path.join(dir,'build/ja/main_ja.pdf'),'built');
      fs.writeFileSync(path.join(dir,'build/ja/main_ja.synctex.gz'),'sync');
      expect(projectTargets(dir).map(t=>t.root)).toEqual(['main.tex','main_ja.tex']);
      expect(targetPdf(dir,'main_ja.tex')).toBe(path.join(dir,'build/ja/main_ja.pdf'));
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
  it('does not prefer an obsolete synchronized PDF over a newer external build',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tex-roots-'));
    try {
      fs.mkdirSync(path.join(dir,'build/tex-review/main'),{recursive:true});
      const old=path.join(dir,'build/tex-review/main/main.pdf'), latest=path.join(dir,'main.pdf');
      fs.writeFileSync(old,'old'); fs.writeFileSync(old.replace('.pdf','.synctex.gz'),'sync');
      fs.writeFileSync(latest,'new'); fs.utimesSync(old,1000,1000); fs.utimesSync(latest,2000,2000);
      expect(targetPdf(dir,'main.tex')).toBe(latest);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });

});
