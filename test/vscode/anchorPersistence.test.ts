import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ChangeSet } from '@codemirror/state';
import { ReviewService } from '../../src/vscode/reviewService';
import { sourceText } from '../../src/core/commentAnchors';
import { checkpointPath, readCheckpoints } from '../../src/core/sourceCheckpoints';
import { writeSnapshot } from '../../src/core/sourceSnapshots';
import { readLog, appendEvent } from '../../src/core/storage';
let root: string, dir: string, service: ReviewService;
const file = 'main.tex';
const write = (text: string, name = file) => fs.writeFileSync(path.join(root, name), text);
function add(id = 't1', name = file, range = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 7 }, quote = 'target') {
  service.apply({ op: 'add_thread', id, file: name, range, snapshot: quote, author: 'reviewer', body: 'Review this', ts: '2026-10-16T00:00:00Z' });
}
const thread = (name = 'review') => service.view(name).threads[0];
function edit(before: string, specs: Parameters<typeof ChangeSet.of>[0]) {
  const changes = ChangeSet.of(specs, sourceText(before).length), after = changes.apply(sourceText(before)).toString();
  service.updateDocument(file, after, changes, true); return after;
}
function save(text: string) { write(text); service.updateDocument(file, text, undefined, false); service.checkpoint(file); service.refreshAll(); }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-persistence-')); dir = path.join(root, '.review');
  write('head\ntarget\nend'); service = new ReviewService(dir); service.createReview('review');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('versioned anchor persistence', () => {
  it('updates the AI view and reopens at the saved position without rewriting history', () => {
    add(); const original = fs.readFileSync(path.join(dir, 'review.log.jsonl'), 'utf8');
    const after = edit('head\ntarget\nend', { from: 0, insert: 'new\n' });
    expect(thread().range.startLine).toBe(3); expect(thread().sourceDirty).toBe(true);
    save(after); service = new ReviewService(dir); service.initializeAnchors();
    const view = JSON.parse(fs.readFileSync(path.join(dir, 'review.view.json'), 'utf8'));
    expect(view.threads[0].range.startLine).toBe(3); expect(view.threads[0].sourceDirty).toBe(false);
    expect(view.threads[0].snapshot).toBe('target');
    expect(fs.readFileSync(path.join(dir, 'review.log.jsonl'), 'utf8').startsWith(original)).toBe(true);
  });
  it('does not append checkpoints repeatedly when nothing changes', () => {
    add(); save('head\ntarget\nend'); const length = readLog(dir, 'review').length;
    save('head\ntarget\nend'); service.initializeAnchors(); expect(readLog(dir, 'review')).toHaveLength(length);
  });
  it('keeps the selected duplicate through edits, save and restart', () => {
    write('same\nsame'); service.updateDocument(file, 'same\nsame');
    add('t1', file, { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }, 'same');
    const after = edit('same\nsame', { from: 0, insert: 'same\n' }); save(after);
    service = new ReviewService(dir); expect(thread().range.startLine).toBe(3); expect(thread().anchor?.status).toBe('attached');
  });
  it('restores exact anchors on Undo and Redo including complete deletion', () => {
    add(); const original = 'head\ntarget\nend'; const deleted = edit(original, { from: 5, to: 11 });
    expect(thread().anchor?.status).toBe('deleted');
    edit(deleted, { from: 5, insert: 'target' }); expect(thread().anchor?.status).toBe('attached'); expect(thread().anchor?.to).toBe(11);
    edit(original, { from: 5, to: 11 }); expect(thread().anchor?.status).toBe('deleted');
  });
  it('retains the comment on edited text rather than looking for the old quote', () => {
    add(); const after = edit('head\ntarget\nend', { from: 5, to: 11, insert: 'rewritten text' }); save(after);
    service = new ReviewService(dir); expect(thread().anchor?.status).toBe('attached'); expect(thread().range.endColumn).toBe(15);
    expect(thread().snapshot).toBe('target');
  });
  it('recovers an offline insertion from the stored source revision', () => {
    add(); write('offline\nhead\ntarget\nend'); service = new ReviewService(dir); service.initializeAnchors();
    expect(thread().range.startLine).toBe(3); expect(thread().anchor?.status).toBe('attached');
  });
  it('restores a known historical revision after restart', () => {
    add(); save(edit('head\ntarget\nend', { from: 5, to: 11 }));
    write('head\ntarget\nend'); service = new ReviewService(dir); service.initializeAnchors();
    expect(thread().anchor?.status).toBe('attached'); expect(thread().range.endColumn).toBe(7);
  });
  it('marks offline target rewrites uncertain instead of attaching elsewhere', () => {
    add(); write('head\nchanged\nend'); service = new ReviewService(dir);
    expect(thread().anchor?.status).toBe('uncertain');
  });
  it('handles multiple reviews and files regardless of the active review', () => {
    add(); write('top\ntarget\nend', 'other.tex'); add('t2', 'other.tex');
    service.createReview('second'); add('t3'); save(edit('head\ntarget\nend', { from: 0, insert: 'new\n' }));
    expect(thread('review').range.startLine).toBe(3); expect(thread('second').range.startLine).toBe(3);
    expect(service.view('review').threads[1].range.startLine).toBe(2);
  });
  it('preserves an anchor through thread deletion and restoration in a running session', () => {
    add(); service.apply({ op: 'delete_thread', thread: 't1', ts: 'x' });
    save(edit('head\ntarget\nend', { from: 0, insert: 'new\n' }));
    service.apply({ op: 'restore_thread', thread: 't1', ts: 'y' }); expect(thread().range.startLine).toBe(3);
  });
  it('migrates old logs only once and preserves their original event', () => {
    appendEvent(dir, 'review', { op: 'add_thread', id: 'legacy', file, range: { startLine: 1, endLine: 1 }, snapshot: 'target', author: 'reviewer', body: 'old', ts: 'x' });
    service.initializeAnchors(); expect(thread().range.startLine).toBe(2);
    expect(readLog(dir, 'review')[0]).toMatchObject({ range: { startLine: 1 } });
    expect(readLog(dir, 'review')).toHaveLength(1);
    service = new ReviewService(dir); expect(thread().range.startLine).toBe(2);
  });
  it('reports missing/corrupt snapshots as uncertain instead of trusting stale coordinates', () => {
    add(); const revision = thread().anchor!.revision;
    fs.writeFileSync(checkpointPath(dir, file), 'corrupted'); write('new\nhead\ntarget\nend');
    service = new ReviewService(dir); expect(thread().anchor?.status).toBe('uncertain');
  });
  it('keeps live unsaved coordinates and explicitly flags them for AI readers', () => {
    add(); edit('head\ntarget\nend', { from: 0, insert: 'new\n' }); service.refreshAll();
    const view = JSON.parse(fs.readFileSync(path.join(dir, 'review.view.json'), 'utf8'));
    expect(view.threads[0].sourceDirty).toBe(true); expect(view.threads[0].range.startLine).toBe(3);
    service.checkpoint(file); expect(readLog(dir, 'review')).toHaveLength(1);
  });
});

describe('explicit anchor repair', () => {
  it('reattaches without replacing the quote, comment IDs or replies', () => {
    add(); service.apply({ op: 'reply', thread: 't1', body: 'Reply', author: 'reviewer', ts: 'r' });
    save(edit('head\ntarget\nend', { from: 5, to: 11 }));
    service.reattach('t1', { startLine: 3, startColumn: 1, endLine: 3, endColumn: 4 }, 'review');
    expect(thread().anchor?.status).toBe('attached'); expect(thread().range.startLine).toBe(3);
    expect(thread().snapshot).toBe('target'); expect(thread().comments.map(c => c.id)).toEqual(['t1.c1', 't1.c2']);
    service = new ReviewService(dir); expect(thread().range.startLine).toBe(3);
  });
});


describe('bounded anchor state', () => {
  it('keeps source files and log size bounded across many saves and restarts', () => {
    add(); const log = fs.readFileSync(path.join(dir, 'review.log.jsonl'), 'utf8');
    for (let i = 0; i < 60; i++) {
      const before = service.view('review').threads[0].range.startLine;
      const text = 'prefix\n'.repeat(i + 1) + 'head\ntarget\nend';
      save(text); service = new ReviewService(dir);
      expect(thread().range.startLine).toBe(before + 1);
    }
    expect(fs.readFileSync(path.join(dir, 'review.log.jsonl'), 'utf8')).toBe(log);
    expect(fs.readdirSync(path.join(dir, 'anchors'))).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'sources'))).toBe(false);
  });
  it('tracks hidden threads across edits and restart before restoration', () => {
    add(); service.apply({ op: 'delete_thread', thread: 't1', ts: 'x' });
    service = new ReviewService(dir); service.initializeAnchors();
    save(edit('head\ntarget\nend', { from: 0, insert: 'new\n' }));
    service = new ReviewService(dir); service.apply({ op: 'restore_thread', thread: 't1', ts: 'y' });
    expect(thread().range.startLine).toBe(3); expect(thread().anchor?.status).toBe('attached');
  });
  it('imports old source revisions without appending automatic events', () => {
    const before = 'head\ntarget\nend', revision = writeSnapshot(dir, before);
    appendEvent(dir, 'review', { op: 'add_thread', id: 'old', file, range: { startLine: 2, endLine: 2 }, snapshot: 'original quote',
      anchor: { revision, from: 5, to: 11, status: 'attached' }, author: 'reviewer', body: 'old', ts: 'x' });
    write('new\n' + before); service = new ReviewService(dir); service.initializeAnchors();
    expect(thread().range.startLine).toBe(3);
    expect(readLog(dir, 'review')).toHaveLength(1);
    fs.rmSync(path.join(dir, 'sources'), { recursive: true });
    service = new ReviewService(dir); expect(thread().range.startLine).toBe(3);
    expect(thread().snapshot).toBe('original quote'); expect(thread().anchor?.status).toBe('attached');
  });
  it('accepts an explicit externally appended anchor without reusing cached positions', () => {
    add(); save('new\nhead\ntarget\nend');
    const text = 'new\nhead\ntarget\nend', revision = thread().anchor!.revision;
    appendEvent(dir, 'review', { op: 'set_anchors', file, revision, ts: 'a', anchors: [
      { thread: 't1', from: 0, to: 3, range: { startLine: 1, endLine: 1 }, status: 'attached' }] });
    expect(thread().range.startLine).toBe(1); service.checkpoint(file);
    service = new ReviewService(dir); expect(thread().range.startLine).toBe(1);
    expect(readCheckpoints(dir, file)[0].text).toBe(text);
  });
});

describe('source storage migration', () => {
  it('checks visible and hidden targets before retiring source snapshots', () => {
    const revision = writeSnapshot(dir, 'head\ntarget\nend');
    appendEvent(dir, 'review', { op: 'add_thread', id: 'old', file, range: { startLine: 2, endLine: 2 }, snapshot: 'target',
      anchor: { revision, from: 5, to: 11, status: 'attached' }, author: 'reviewer', body: 'old', ts: 'x' });
    appendEvent(dir, 'review', { op: 'delete_thread', thread: 'old', ts: 'y' });
    expect(service.migrateLegacySnapshots(path.join(root, 'backup')).removed).toBe(0);
    service.initializeAnchors();
    expect(service.migrateLegacySnapshots(path.join(root, 'backup')).removed).toBe(1);
    service = new ReviewService(dir); service.apply({ op: 'restore_thread', thread: 'old', ts: 'z' });
    expect(thread().anchor?.status).toBe('attached'); expect(thread().range.startLine).toBe(2);
  });
});

it('loads new comment checkpoints created by another host without losing earlier threads', () => {
  // This host already has a source buffer when another host adds a comment.
  service.updateDocument(file, 'head\ntarget\nend');
  const other = new ReviewService(dir);
  other.apply({ op: 'add_thread', id: 'foreign', file, range: { startLine: 2, endLine: 2 }, snapshot: 'target', author: 'reviewer', body: 'other host', ts: 'x' });
  save(edit('head\ntarget\nend', { from: 0, insert: 'new\n' }));
  service = new ReviewService(dir);
  expect(thread().id).toBe('foreign'); expect(thread().range.startLine).toBe(3); expect(thread().anchor?.status).toBe('attached');
});

it('recovers matching positions from the previous checkpoint after current-file corruption', () => {
  add(); save('new\nhead\ntarget\nend');
  fs.writeFileSync(checkpointPath(dir, file), '{partial write');
  service = new ReviewService(dir);
  expect(thread().range.startLine).toBe(3); expect(thread().anchor?.status).toBe('attached');
  service.checkpoint(file); service = new ReviewService(dir);
  expect(thread().range.startLine).toBe(3);
});

it('ignores a checkpoint target whose event was never appended', () => {
  add(); const originalLog = fs.readFileSync(path.join(dir, 'review.log.jsonl'), 'utf8');
  service.reattach('t1', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 }, 'review');
  // Simulate a crash between checkpoint publication and event append.
  fs.writeFileSync(path.join(dir, 'review.log.jsonl'), originalLog);
  service = new ReviewService(dir);
  expect(thread().range.startLine).toBe(2); expect(thread().anchor?.status).toBe('attached');
});

it('retains exact mappings from another host when its source update arrives later', () => {
  add(); const other = new ReviewService(dir); other.view('review');
  const before = 'head\ntarget\nend', changes = ChangeSet.of({ from: 5, to: 11, insert: 'changed' }, before.length);
  const after = changes.apply(sourceText(before)).toString();
  other.updateDocument(file, after, changes, true); write(after);
  other.updateDocument(file, after, undefined, false); other.checkpoint(file);
  service.syncDisk(file);
  expect(thread().anchor?.status).toBe('attached'); expect(thread().range.endColumn).toBe(8);
});
