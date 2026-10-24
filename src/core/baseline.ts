import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workspaceFile } from './safePaths';
const run = promisify(execFile);
const options = (cwd: string) => ({ cwd, timeout: 10_000, maxBuffer: 16_000_000 });
export type Baseline = { kind: 'git'; revision: string; label: string } | { kind: 'file'; path: string; source: string; label: string };
export async function checkpoints(root: string): Promise<{ revision: string; label: string; description: string }[]> {
  const { stdout } = await run('git', ['log', '-40', '--format=%H%x1f%h%x1f%s'], options(root));
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const [revision, label, ...subject] = line.split('\x1f');
    return { revision, label, description: subject.join(' ') };
  });
}
export async function checkpoint(root: string, ref: string): Promise<Baseline> {
  const { stdout } = await run('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], options(root));
  const revision = stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new Error('Invalid checkpoint');
  // Freeze branch/tag names to the resolved commit, so comparison stays stable.
  return { kind: 'git', revision, label: revision.slice(0, 8) };
}
export async function baselineText(root: string, source: string, baseline: Baseline): Promise<string | null> {
  workspaceFile(root, source);
  if (baseline.kind === 'file') {
    if (baseline.source !== source) return null;
    if (!fs.statSync(baseline.path).isFile() || fs.statSync(baseline.path).size > 16_000_000) throw new Error('Invalid baseline file');
    return fs.readFileSync(baseline.path, 'utf8').replace(/\r\n/g, '\n');
  }
  if (!/^[a-f0-9]{40,64}$/.test(baseline.revision)) throw new Error('Invalid checkpoint');
  // Resolve from the repository root, including workspaces opened in a subdirectory.
  const { stdout: prefix } = await run('git', ['rev-parse', '--show-prefix'], options(root));
  const gitPath = (prefix.trim() + source.split(path.sep).join('/'));
  const { stdout } = await run('git', ['show', `${baseline.revision}:${gitPath}`], options(root));
  return stdout.replace(/\r\n/g, '\n');
}
