import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateReviewName, workspaceFile } from '../../src/core/safePaths';

describe('review path boundaries', () => {
  it('accepts Japanese and ordinary review names', () => {
    expect(validateReviewName('博士論文-確認')).toBe('博士論文-確認');
  });
  it.each(['../escape', '/tmp/x', '..\\escape', '', ' ', '..', 'x\n', 'a/b'])('rejects %j', (name) => {
    expect(() => validateReviewName(name)).toThrow();
  });
  it('rejects new output paths under a symlink escaping the workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-boundary-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'review-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'build'), 'dir');
      expect(() => workspaceFile(root, 'build/new/output.pdf')).toThrow();
    } finally { fs.rmSync(root, { recursive: true }); fs.rmSync(outside, { recursive: true }); }
  });
  it('rejects workspace escapes and absolute paths', () => {
    expect(() => workspaceFile('/tmp', '../etc/passwd')).toThrow();
    expect(() => workspaceFile('/tmp', '/etc/passwd')).toThrow();
    expect(workspaceFile('/tmp', 'chapter.tex')).toBe('/tmp/chapter.tex');
  });
});
