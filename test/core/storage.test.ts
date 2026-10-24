import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as storage from '../../src/core/storage';
import { ReviewEvent } from '../../src/core/types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ev: ReviewEvent = {
  op: 'add_thread', id: 't_1', file: 'a.ts',
  range: { startLine: 1, endLine: 1 }, snapshot: 'x',
  author: 'reviewer', body: 'hi', ts: 't',
};

describe('storage', () => {
  it('appends and reads back events in order', () => {
    storage.appendEvent(dir, 'rev', ev);
    storage.appendEvent(dir, 'rev', { op: 'resolve', thread: 't_1', ts: 't2' });
    const log = storage.readLog(dir, 'rev');
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual(ev);
    expect(log[1]).toEqual({ op: 'resolve', thread: 't_1', ts: 't2' });
  });

  it('readLog returns [] for a missing log', () => {
    expect(storage.readLog(dir, 'nope')).toEqual([]);
  });

  it('readLog skips blank lines', () => {
    storage.ensureLog(dir, 'rev');
    fs.appendFileSync(storage.logPath(dir, 'rev'), '\n');
    storage.appendEvent(dir, 'rev', ev);
    expect(storage.readLog(dir, 'rev')).toHaveLength(1);
  });

  it('writes and reads the view file', () => {
    const view = { version: 1 as const, name: 'rev', createdAt: 't', threads: [] };
    storage.writeView(dir, 'rev', view);
    const raw = JSON.parse(fs.readFileSync(storage.viewPath(dir, 'rev'), 'utf8'));
    expect(raw).toEqual(view);
  });

  it('reads default state when absent and round-trips state', () => {
    expect(storage.readState(dir)).toEqual({ active: null });
    storage.writeState(dir, { active: 'rev' });
    expect(storage.readState(dir)).toEqual({ active: 'rev' });
  });

  it('lists reviews by log filename', () => {
    storage.ensureLog(dir, 'beta');
    storage.ensureLog(dir, 'alpha');
    expect(storage.listReviews(dir)).toEqual(['alpha', 'beta']);
  });

  it('removes a review log and view', () => {
    storage.ensureLog(dir, 'rev');
    storage.writeView(dir, 'rev', { version: 1, name: 'rev', createdAt: '', threads: [] });
    storage.removeReview(dir, 'rev');
    expect(storage.listReviews(dir)).toEqual([]);
    expect(fs.existsSync(storage.viewPath(dir, 'rev'))).toBe(false);
  });
});
