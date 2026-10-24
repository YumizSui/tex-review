import * as fs from 'node:fs';

export function pdfSyncIssue(pdf: string, sources: string[], dirty: boolean): 'missing' | 'stale' | null {
  const companions = [pdf.replace(/\.pdf$/i, '.synctex.gz'), pdf.replace(/\.pdf$/i, '.synctex')];
  if (!fs.existsSync(pdf)) return 'missing';
  const available = companions.filter(file => fs.existsSync(file));
  if (!available.length) return 'missing';
  const built = fs.statSync(pdf).mtimeMs;
  const syncTime = Math.max(...available.map(file => fs.statSync(file).mtimeMs));
  if (dirty || built > syncTime + 2000 || sources.some(file => fs.existsSync(file) && fs.statSync(file).mtimeMs > built)) return 'stale';
  return null;
}
