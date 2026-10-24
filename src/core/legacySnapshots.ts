import * as fs from 'node:fs';
import * as path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { rejectSymlink } from './safePaths';
import { sourceRevision } from './sourceSnapshots';

/** Called only after all current and hidden thread positions have a durable checkpoint. */
export function retireLegacySnapshots(dir: string, backupDir: string, covered: () => boolean) {
  const folder = path.join(dir, 'sources'); rejectSymlink(dir); rejectSymlink(folder);
  if (!fs.existsSync(folder) || !covered()) return { removed: 0, bytes: 0 };
  const files: Record<string, string> = {};
  for (const name of fs.readdirSync(folder).sort()) {
    if (!/^[a-f0-9]{64}\.txt$/.test(name)) continue;
    const file = path.join(folder, name); rejectSymlink(file);
    const text = fs.readFileSync(file, 'utf8');
    if (sourceRevision(text) === name.slice(0, -4)) files[name] = text;
  }
  if (!Object.keys(files).length) return { removed: 0, bytes: 0 };
  // A single recovery archive outside the project preserves pre-migration history.
  const serialized = JSON.stringify({ version: 1, reviewDirectory: path.resolve(dir), files });
  rejectSymlink(backupDir); fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, sourceRevision(serialized) + '.json.gz'); rejectSymlink(backup);
  if (!fs.existsSync(backup)) {
    const tmp = backup + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, gzipSync(serialized)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, backup);
  }
  if (gunzipSync(fs.readFileSync(backup)).toString('utf8') !== serialized) throw new Error('Legacy source backup failed verification.');
  let removed = 0, bytes = 0;
  for (const [name, text] of Object.entries(files)) {
    if (!covered()) break; // Log writers may add comments while migration runs.
    const file = path.join(folder, name); rejectSymlink(file);
    try {
      if (fs.readFileSync(file, 'utf8') !== text) continue;
      fs.unlinkSync(file); removed++; bytes += Buffer.byteLength(text);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  if (!fs.readdirSync(folder).length) { try { fs.rmdirSync(folder); } catch (e) { if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; } }
  return { removed, bytes, backup };
}
