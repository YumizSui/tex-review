import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkpointPath, readCheckpoints, writeCheckpoint } from '../../src/core/sourceCheckpoints';
import { sourceRevision } from '../../src/core/sourceSnapshots';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-state-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const state = (text: string) => ({ version: 1 as const, file: 'chapter.tex', revision: sourceRevision(text), text, entries: { t: { signature: 's', position: { from: 0, to: 1, status: 'attached' as const } } } });
describe('bounded source checkpoints', () => {
  it('retains exactly current and previous generations and skips identical writes', () => {
    for (let i = 0; i < 50; i++) writeCheckpoint(dir, state(`revision ${i}`));
    expect(readCheckpoints(dir, 'chapter.tex').map(c => c.text)).toEqual(['revision 49', 'revision 48']);
    writeCheckpoint(dir, state('revision 49'));
    expect(readCheckpoints(dir, 'chapter.tex').map(c => c.text)).toEqual(['revision 49', 'revision 48']);
    expect(fs.readdirSync(path.join(dir, 'anchors'))).toHaveLength(2);
  });
  it('recovers from an invalid current generation using the validated previous one', () => {
    writeCheckpoint(dir, state('first')); writeCheckpoint(dir, state('second'));
    fs.writeFileSync(checkpointPath(dir, 'chapter.tex'), '{broken');
    expect(readCheckpoints(dir, 'chapter.tex').map(c => c.text)).toEqual(['first']);
    writeCheckpoint(dir, state('third'));
    expect(readCheckpoints(dir, 'chapter.tex').map(c => c.text)).toEqual(['third', 'first']);
  });
  it('rejects changed positions even if the source text still has the correct hash', () => {
    writeCheckpoint(dir, state('first'));
    const p = checkpointPath(dir, 'chapter.tex'), envelope = JSON.parse(fs.readFileSync(p, 'utf8'));
    envelope.data.entries.t.position.to = 2; fs.writeFileSync(p, JSON.stringify(envelope));
    expect(readCheckpoints(dir, 'chapter.tex')).toEqual([]);
  });
  it('does not overwrite a checkpoint concurrently updated by another writer', () => {
    writeCheckpoint(dir, state('first'));
    const expected = readCheckpoints(dir, 'chapter.tex')[0];
    writeCheckpoint(dir, state('second'));
    expect(() => writeCheckpoint(dir, state('stale'), expected)).toThrow(/changed/);
    expect(readCheckpoints(dir, 'chapter.tex')[0].text).toBe('second');
  });
});
