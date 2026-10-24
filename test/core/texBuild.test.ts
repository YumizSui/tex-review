import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { texBuildPlan, previewIsCurrent } from '../../src/core/texBuild';
describe('TeX build modes', () => {
  it('uses a full initial build before relying on cached auxiliary files', () => {
    expect(texBuildPlan('lualatex', 'main.tex', 'build', 'preview', false).binary).toBe('latexmk');
  });
  it('runs exactly one engine pass for initialized previews while retaining SyncTeX', () => {
    const plan = texBuildPlan('lualatex', 'main.tex', 'build', 'preview', true);
    expect(plan.binary).toBe('lualatex'); expect(plan.args).toContain('-synctex=1'); expect(plan.args).toContain('-recorder');
    expect(plan.args.at(-1)).toBe('main.tex');
  });
  it('keeps latexmk reference convergence for full builds', () => {
    const plan = texBuildPlan('pdflatex', 'main.tex', 'build', 'full', true);
    expect(plan.binary).toBe('latexmk'); expect(plan.args).toContain('-pdf');
  });
  it('skips an unchanged preview but rebuilds when a recorded input changes or disappears', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-preview-'));
    const out = path.join(root, 'build'); fs.mkdirSync(out);
    try {
      const source = path.join(root, 'chapter.tex'), pdf = path.join(out, 'main.pdf');
      fs.writeFileSync(source, 'source'); fs.utimesSync(source, 1000, 1000);
      fs.writeFileSync(pdf, 'pdf'); fs.utimesSync(pdf, 2000, 2000);
      fs.writeFileSync(path.join(out, 'main.synctex.gz'), 'sync');
      fs.writeFileSync(path.join(out, 'main.fls'), 'INPUT chapter.tex\n');
      expect(previewIsCurrent(root, out, 'main')).toBe(true);
      fs.utimesSync(source, 3000, 3000); expect(previewIsCurrent(root, out, 'main')).toBe(false);
      fs.unlinkSync(source); expect(previewIsCurrent(root, out, 'main')).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

});
