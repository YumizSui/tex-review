import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { writeSnapshot } from '../../src/core/sourceSnapshots';
import { retireLegacySnapshots } from '../../src/core/legacySnapshots';
let root: string, dir: string, backup: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'review-migrate-')); dir = path.join(root, '.review'); backup = path.join(root, 'backup'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
it('verifies a recovery archive before removing legacy files', () => {
  const a = writeSnapshot(dir, 'first'), b = writeSnapshot(dir, 'second');
  const result = retireLegacySnapshots(dir, backup, () => true);
  expect(result.removed).toBe(2); expect(fs.existsSync(path.join(dir, 'sources'))).toBe(false);
  expect(JSON.parse(gunzipSync(fs.readFileSync(result.backup!)).toString()).files).toEqual({ [a + '.txt']: 'first', [b + '.txt']: 'second' });
});
it('keeps files when mapping is not covered or comments arrive during migration', () => {
  writeSnapshot(dir, 'first'); writeSnapshot(dir, 'second');
  expect(retireLegacySnapshots(dir, backup, () => false).removed).toBe(0);
  let calls = 0;
  expect(retireLegacySnapshots(dir, backup, () => ++calls < 3).removed).toBe(1);
  expect(fs.readdirSync(path.join(dir, 'sources'))).toHaveLength(1);
});
