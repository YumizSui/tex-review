import * as fs from 'fs';
import * as path from 'path';
import { workspaceFile } from './safePaths';
export interface ProjectTarget { root: string; pdf?: string }
/** Discover real root documents, not chapter fragments or build copies. */
export function projectTargets(root: string): ProjectTarget[] {
  return fs.readdirSync(root).filter(name => name.endsWith('.tex')).filter(name => {
    try {
      const file = workspaceFile(root, name);
      return fs.statSync(file).isFile() && /\\documentclass(?:\[|\{)/.test(fs.readFileSync(file, 'utf8'));
    } catch { return false; }
  }).map(name => ({ root: name, pdf: targetPdf(root, name) }));
}
export function targetPdf(root: string, rootFile: string): string | undefined {
  const stem = path.basename(rootFile, '.tex');
  const dirs = ['build/tex-review/' + stem, 'build/ja', 'build/en', 'build/diff-ja', 'build/checkpoint-diff', '', 'build'];
  const existing = dirs.map(dir => workspaceFile(root, path.join(dir, stem + '.pdf'))).filter(file => fs.existsSync(file));
  return existing.sort((a, b) => {
    const sync = (p: string) => Number(fs.existsSync(p.replace(/\.pdf$/i, '.synctex.gz')) || fs.existsSync(p.replace(/\.pdf$/i, '.synctex')));
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || sync(b) - sync(a);
  })[0];
}
