import * as fs from 'node:fs';
import { retireLegacySnapshots } from '../core/legacySnapshots';
import { readCheckpoints, checkpointPath } from '../core/sourceCheckpoints';
import { ChangeSet } from '@codemirror/state';
import { AnchorStore } from './anchorStore';
import { ReviewEvent, ReviewView } from '../core/types';
import { fold } from '../core/events';
import * as storage from '../core/storage';

// ISO-8601 UTC timestamp, wrapped so callers don't touch Date directly.
export function nowIso(): string {
  return new Date().toISOString();
}

export class ReviewService {
  private readonly anchors: AnchorStore;
  constructor(private readonly dir: string) { this.anchors = new AnchorStore(dir); }

  updateDocument(file: string, text: string, changes?: ChangeSet, dirty = false): void {
    // Populate all review anchors against the old revision before mapping edits.
    for (const name of this.list()) this.view(name);
    this.anchors.update(file, text, changes, dirty);
  }

  refreshAll(): void {
    for (const name of this.list()) storage.writeView(this.dir, name, this.view(name));
  }

  syncDisk(file: string): void {
    for (const name of this.list()) this.view(name);
    this.anchors.disk(file); this.checkpoint(file); this.refreshAll();
  }

  checkpoint(file: string): void {
    for (const name of this.list()) this.view(name);
    this.anchors.checkpoint(file);
  }

  reattach(threadId: string, range: import('../core/types').LineRange, name: string): void {
    const thread = this.view(name).threads.find(thread => thread.id === threadId);
    if (!thread) throw new Error('Comment not found.');
    const anchor = this.anchors.capture(thread.file, range);
    if (!anchor) throw new Error('Cannot read the comment source.');
    this.apply({ op: 'set_anchors', file: thread.file, revision: anchor.revision,
      anchors: [{ thread: thread.id, range, from: anchor.from, to: anchor.to, status: 'attached' }], ts: nowIso() }, name);
  }

  initializeAnchors(): void {
    this.refreshAll();
    for (const file of this.anchors.files()) this.checkpoint(file);
    this.refreshAll();
  }

  migrateLegacySnapshots(backupDir: string) {
    const names = this.list();
    const logs = names.map(name => fs.readFileSync(storage.logPath(this.dir, name), 'utf8'));
    const states = new Map<string, ReturnType<typeof readCheckpoints>[number] | undefined>();
    for (const name of names) {
      const events = storage.readLog(this.dir, name), all = fold(name, events, true);
      const projected = this.anchors.project(all, events);
      for (let i = 0; i < all.threads.length; i++) {
        const thread = all.threads[i];
        if (!states.has(thread.file)) states.set(thread.file, readCheckpoints(this.dir, thread.file)[0]);
        const state = states.get(thread.file), current = projected.threads[i].anchor;
        const saved = state?.entries[JSON.stringify([name, thread.id])];
        if (!state || !current || this.anchors.dirty(thread.file) || state.revision !== current.revision ||
            saved?.signature !== JSON.stringify(thread.anchor ?? [thread.range, thread.snapshot]) ||
            JSON.stringify(saved.position) !== JSON.stringify({ from: current.from, to: current.to, status: current.status })) {
          return { removed: 0, bytes: 0 };
        }
      }
    }
    const durable = [...states.keys()].flatMap(file => {
      const target = checkpointPath(this.dir, file);
      return [target, target + '.previous'].filter(p => fs.existsSync(p)).map(p => [p, fs.readFileSync(p, 'utf8')] as const);
    });
    const covered = () => JSON.stringify(this.list()) === JSON.stringify(names) &&
      names.every((name, i) => fs.readFileSync(storage.logPath(this.dir, name), 'utf8') === logs[i]) &&
      durable.every(([p, text]) => fs.existsSync(p) && fs.readFileSync(p, 'utf8') === text);
    return retireLegacySnapshots(this.dir, backupDir, covered);
  }

  active(): string | null {
    return storage.readState(this.dir).active;
  }

  list(): string[] {
    return storage.listReviews(this.dir);
  }

  setActive(name: string): void {
    storage.writeState(this.dir, { active: name });
  }

  createReview(name: string): void {
    storage.ensureLog(this.dir, name);
    storage.writeView(this.dir, name, this.view(name));
    this.setActive(name);
  }

  // A date-based default review name that doesn't collide with an existing one.
  // Used when a comment is added with no active review and we offer a name to create.
  suggestReviewName(): string {
    const base = `review-${nowIso().slice(0, 10)}`;
    const existing = new Set(this.list());
    if (!existing.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  deleteReview(name: string): void {
    const wasActive = this.active();
    storage.removeReview(this.dir, name);
    this.anchors.forgetReview(name);
    for (const file of this.anchors.files()) this.checkpoint(file);
    if (wasActive === name) {
      const remaining = this.list();
      storage.writeState(this.dir, { active: remaining[0] ?? null });
    }
  }

  view(name: string): ReviewView {
    const events = storage.readLog(this.dir, name);
    // Hidden threads must keep following the source so Restore works after a restart.
    const projected = this.anchors.project(fold(name, events, true), events);
    const visible = new Set(fold(name, events).threads.map(t => t.id));
    return { ...projected, threads: projected.threads.filter(t => visible.has(t.id)) };
  }

  // Recompute and persist the active review's view. Safe to call on every
  // render — used to keep view.json current after external (agent) log writes.
  refreshView(): ReviewView | null {
    const name = this.active();
    if (!name) return null;
    const v = this.view(name);
    storage.writeView(this.dir, name, v);
    return v;
  }

  // Append an event to a review (defaults to the active one), rebuild + persist
  // its view, return it. Pass `target` to act on a non-active review, e.g. from
  // the tree panel context menu.
  apply(event: ReviewEvent, target?: string): ReviewView {
    const name = target ?? this.active();
    if (!name) throw new Error('No active review. Create one first.');
    if (event.op === 'add_thread' && !event.anchor) event = { ...event, anchor: this.anchors.capture(event.file, event.range) };
    if (event.op === 'add_thread' || event.op === 'set_anchors') {
      for (const review of this.list()) this.view(review);
      const events = [...storage.readLog(this.dir, name), event];
      this.anchors.project(fold(name, events, true), events);
      // Persist the new target before publishing its event. An interrupted append
      // leaves an ignored entry; it cannot leave a comment without its baseline.
      this.anchors.checkpoint(event.file, true);
    }
    storage.appendEvent(this.dir, name, event);
    const v = this.view(name);
    storage.writeView(this.dir, name, v);
    return v;
  }
}
