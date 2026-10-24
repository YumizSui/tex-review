import * as fs from 'node:fs';
import * as path from 'node:path';
import { PositionAnchor } from './commentAnchors';
import { rejectSymlink } from './safePaths';
import { sourceRevision } from './sourceSnapshots';

export interface CheckpointEntry { signature: string; position: PositionAnchor }
export interface SourceCheckpoint {
  version: 1;
  file: string;
  revision: string;
  text: string;
  entries: Record<string, CheckpointEntry>;
}
export function checkpointPath(dir: string, file: string): string {
  rejectSymlink(dir); rejectSymlink(path.join(dir, 'anchors'));
  return path.join(dir, 'anchors', sourceRevision(file) + '.json');
}
function read(file: string, source: string): SourceCheckpoint | null {
  rejectSymlink(file);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  try {
    const { data, checksum } = JSON.parse(raw);
    if (sourceRevision(JSON.stringify(data)) !== checksum || data.version !== 1 || data.file !== source ||
        typeof data.text !== 'string' || sourceRevision(data.text) !== data.revision || !data.entries || Array.isArray(data.entries)) return null;
    for (const value of Object.values(data.entries) as CheckpointEntry[]) {
      const p = value.position;
      if (typeof value.signature !== 'string' || !p || !Number.isInteger(p.from) || !Number.isInteger(p.to) ||
          p.from < 0 || p.to < p.from || p.to > data.text.length || !['attached', 'uncertain', 'deleted'].includes(p.status)) return null;
    }
    return data;
  } catch { return null; }
}
export function readCheckpoints(dir: string, file: string): SourceCheckpoint[] {
  const target = checkpointPath(dir, file);
  return [read(target, file), read(target + '.previous', file)].filter((x): x is SourceCheckpoint => x !== null);
}
function atomic(target: string, contents: string) {
  const tmp = target + '.tmp'; rejectSymlink(target); rejectSymlink(tmp);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'w'); fs.writeFileSync(fd, contents); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function encode(data: SourceCheckpoint) { return JSON.stringify({ data, checksum: sourceRevision(JSON.stringify(data)) }); }
/** A short local lock plus expected-state check prevents stale hosts overwriting a newer mapping. */
export function writeCheckpoint(dir: string, data: SourceCheckpoint, expected?: SourceCheckpoint | null): void {
  const target = checkpointPath(dir, data.file); fs.mkdirSync(path.dirname(target), { recursive: true });
  const lock = target + '.lock'; rejectSymlink(lock);
  if (fs.existsSync(lock)) {
    let dead = false;
    try { const pid = Number(fs.readFileSync(lock, 'utf8')); if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
    } else dead = Date.now() - fs.statSync(lock).mtimeMs > 30_000; } catch { /* A concurrent owner may have released it. */ }
    if (dead) { try { fs.unlinkSync(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  }
  const fd = fs.openSync(lock, 'wx');
  try {
    fs.writeFileSync(fd, String(process.pid));
    const current = read(target, data.file), fallback = current ?? read(target + '.previous', data.file);
    if (expected !== undefined && JSON.stringify(fallback) !== JSON.stringify(expected)) throw new Error('Source checkpoint changed in another editor. Refresh before saving comment positions.');
    const contents = encode(data);
    if (fallback && encode(fallback) === contents && current) return;
    if (current) atomic(target + '.previous', encode(current));
    atomic(target, contents);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
