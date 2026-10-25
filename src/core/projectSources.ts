import * as fs from 'node:fs';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { workspaceFile } from './safePaths';

export interface ProjectSources { files: string[]; origin: 'recorder' | 'synctex' | 'references' }
/** Only inspect the selected build's records or explicit includes. Never walk the workspace. */
export function projectSources(root: string, entry?: string, pdf?: string): ProjectSources {
  const files: string[] = [];
  const add = (name: string, cwd = root) => {
    try {
      const absolute = path.resolve(cwd, name);
      const file = path.relative(fs.realpathSync(root), fs.realpathSync(absolute));
      const full = workspaceFile(root, file);
      if (!/\.tex$/i.test(file) || !fs.statSync(full).isFile()) return;
      if (!files.includes(file)) files.push(file);
    } catch { /* TeX installations and references outside the workspace are not review targets. */ }
  };
  if (entry) add(entry);
  if (pdf) {
    try {
      const lines = fs.readFileSync(pdf.replace(/\.pdf$/i, '.fls'), 'utf8').split(/\r?\n/);
      const cwd = lines.find(line => line.startsWith('PWD '))?.slice(4) || root;
      let recorded = false;
      for (const line of lines) if (line.startsWith('INPUT ')) {
        const name = line.slice(6); add(name, cwd);
        try { if (files.includes(path.relative(fs.realpathSync(root), fs.realpathSync(path.resolve(cwd, name))))) recorded = true; } catch {}
      }
      if (recorded) return { files, origin: 'recorder' };
    } catch { /* Try SyncTeX or literal include references when recorder data is unavailable. */ }
    for (const suffix of ['.synctex.gz', '.synctex']) {
      try {
        const data = fs.readFileSync(pdf.replace(/\.pdf$/i, suffix));
        const text = (suffix.endsWith('.gz') ? gunzipSync(data) : data).toString('utf8');
        for (const line of text.split(/\r?\n/)) {
          const input = /^Input:\d+:(.+)$/.exec(line);
          if (input) add(input[1]);
        }
        if (files.length > (entry ? 1 : 0)) return { files, origin: 'synctex' };
      } catch { /* Fall through to source references. */ }
    }
  }
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    let text: string;
    try { text = fs.readFileSync(workspaceFile(root, file), 'utf8').replace(/(?<!\\)%[^\n]*/g, ''); } catch { return; }
    const refs = /\\(?:input|include|subfile)\s*(?:\{([^}]+)\}|([^\s{}]+))|\\(subimport|import)\s*\{([^}]+)\}\s*\{([^}]+)\}/g;
    for (const match of text.matchAll(refs)) {
      const name = match[3] ? path.join(match[4], match[5]) : match[1] || match[2];
      if (/[\\#$]/.test(name)) continue; // Dynamic TeX cannot be inferred safely without a build.
      const withExtension = path.extname(name) ? name : name + '.tex';
      const bases = match[3] === 'subimport' ? [path.dirname(workspaceFile(root, file))] : [root, path.dirname(workspaceFile(root, file))];
      for (const base of bases) {
        const before = files.length;
        add(withExtension, base);
        if (files.length > before) { visit(files[files.length - 1]); break; }
        if (files.includes(path.relative(root, path.resolve(base, withExtension)))) break;
      }
    }
  };
  if (entry) visit(entry);
  return { files, origin: 'references' };
}
