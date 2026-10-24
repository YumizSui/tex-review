import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pdfSyncIssue } from '../../src/core/pdfSync';

describe('PDF synchronization freshness', () => {
  it('requires a matching synchronized build and saved current source', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-sync-'));
    try {
      const pdf = path.join(dir, 'main.pdf'), source = path.join(dir, 'chapter.tex'), sync = path.join(dir, 'main.synctex.gz');
      fs.writeFileSync(source, 'text'); fs.utimesSync(source, 1000, 1000);
      fs.writeFileSync(pdf, 'pdf'); fs.utimesSync(pdf, 2000, 2000);
      expect(pdfSyncIssue(pdf, [source], false)).toBe('missing');
      fs.writeFileSync(sync, 'sync'); fs.utimesSync(sync, 2000, 2000);
      expect(pdfSyncIssue(pdf, [source], false)).toBeNull();
      expect(pdfSyncIssue(pdf, [source], true)).toBe('stale');
      fs.utimesSync(source, 3000, 3000);
      expect(pdfSyncIssue(pdf, [source], false)).toBe('stale');
      fs.utimesSync(source, 1000, 1000); fs.utimesSync(pdf, 4000, 4000);
      expect(pdfSyncIssue(pdf, [source], false)).toBe('stale');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
