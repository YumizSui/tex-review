import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { baselineText, checkpoint, checkpoints } from '../../src/core/baseline';

describe('comparison baselines', () => {
  it('freezes a checkpoint and reads matching included files, including a nested workspace', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-checkpoint-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    try {
      git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
      fs.mkdirSync(path.join(root, 'paper/chapters'), { recursive: true });
      fs.writeFileSync(path.join(root, 'paper/chapters/a.tex'), 'baseline 日本語\n');
      git('add', '.'); git('commit', '-m', 'baseline');
      const baseline = await checkpoint(root, 'HEAD');
      fs.writeFileSync(path.join(root, 'paper/chapters/a.tex'), 'current\n');
      git('add', '.'); git('commit', '-m', 'current');
      expect((await checkpoints(root))[0].description).toBe('current');
      expect(await baselineText(root, 'paper/chapters/a.tex', baseline)).toBe('baseline 日本語\n');
      expect(await baselineText(path.join(root, 'paper'), 'chapters/a.tex', baseline)).toBe('baseline 日本語\n');
      await expect(checkpoint(root, '--output=/tmp/anything')).rejects.toThrow();
      await expect(baselineText(root, 'missing.tex', baseline)).rejects.toThrow();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('reads a separate file without changing either file and limits it to the selected source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-baseline-'));
    try {
      const baselinePath = path.join(root, 'old.tex'); fs.writeFileSync(baselinePath, 'old\r\n');
      const baseline = { kind: 'file' as const, path: baselinePath, source: 'current.tex', label: 'old.tex' };
      expect(await baselineText(root, 'current.tex', baseline)).toBe('old\n');
      expect(await baselineText(root, 'other.tex', baseline)).toBeNull();
      expect(fs.readFileSync(baselinePath, 'utf8')).toBe('old\r\n');
      expect(fs.existsSync(path.join(root, 'current.tex'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
