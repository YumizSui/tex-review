import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReviewService, nowIso } from '../../src/vscode/reviewService';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('ReviewService.suggestReviewName', () => {
  it('suggests a date-based name when none exists', () => {
    const svc = new ReviewService(dir);
    expect(svc.suggestReviewName()).toBe(`review-${nowIso().slice(0, 10)}`);
  });

  it('appends a numeric suffix to avoid collisions', () => {
    const svc = new ReviewService(dir);
    const base = `review-${nowIso().slice(0, 10)}`;
    svc.createReview(base);
    expect(svc.suggestReviewName()).toBe(`${base}-2`);
    svc.createReview(`${base}-2`);
    expect(svc.suggestReviewName()).toBe(`${base}-3`);
  });
});

describe('ReviewService.apply', () => {
  it('throws when no active review', () => {
    const svc = new ReviewService(dir);
    expect(() => svc.apply({ op: 'resolve', thread: 't_1', ts: 't' })).toThrow(/No active review/);
  });
});
