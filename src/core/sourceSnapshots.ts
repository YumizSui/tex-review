import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { rejectSymlink } from './safePaths';
export const sourceRevision = (text: string) => createHash('sha256').update(text).digest('hex');
export function readSnapshot(dir: string, revision: string): string | null {
  if (!/^[a-f0-9]{64}$/.test(revision)) return null;
  rejectSymlink(dir); rejectSymlink(path.join(dir, 'sources'));
  const file = path.join(dir, 'sources', revision + '.txt'); rejectSymlink(file);
  try { const text = fs.readFileSync(file, 'utf8'); return sourceRevision(text) === revision ? text : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function writeSnapshot(dir: string, text: string): string {
  const revision = sourceRevision(text), folder = path.join(dir, 'sources');
  rejectSymlink(dir); rejectSymlink(folder); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, revision + '.txt'); rejectSymlink(file);
  try { fs.writeFileSync(file, text, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readSnapshot(dir, revision) !== text) throw new Error('Source snapshot failed its integrity check.'); }
  return revision;
}
