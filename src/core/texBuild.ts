import * as fs from 'node:fs';
import * as path from 'node:path';
export type BuildMode = 'preview' | 'full';
export function texBuildPlan(engine: string, source: string, out: string, requested: BuildMode, initialized: boolean) {
  if (!['pdflatex', 'xelatex', 'lualatex'].includes(engine)) throw new Error('Unsupported TeX engine');
  const mode = requested === 'preview' && initialized ? 'preview' : 'full';
  const common = ['-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error'];
  return mode === 'preview'
    ? { mode, binary: engine, args: [...common, '-recorder', '-output-directory=' + out, source] }
    : { mode, binary: 'latexmk', args: [engine === 'pdflatex' ? '-pdf' : '-' + engine, ...common, '-outdir=' + out, source] };
}

export function previewIsCurrent(root: string, out: string, stem: string): boolean {
  try {
    const pdfTime = fs.statSync(path.join(out, stem + '.pdf')).mtimeMs;
    if (![stem + '.synctex.gz', stem + '.synctex'].some(file => fs.existsSync(path.join(out, file)))) return false;
    const inputs = fs.readFileSync(path.join(out, stem + '.fls'), 'utf8').split('\n').filter(line => line.startsWith('INPUT ')).map(line => path.resolve(root, line.slice(6).trim()));
    return inputs.length > 0 && [...new Set(inputs)].every(file => fs.statSync(file).mtimeMs <= pdfTime);
  } catch { return false; }
}
