import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChangeSet, Text } from '@codemirror/state';
import { PositionAnchor, VersionedAnchor, sourceText, offsets, lineRange, mapAnchor, migrateAnchor, rebaseAnchor, sourceChanges } from '../core/commentAnchors';
import { sourceRevision, readSnapshot } from '../core/sourceSnapshots';
import { readCheckpoints, writeCheckpoint, checkpointPath, SourceCheckpoint } from '../core/sourceCheckpoints';
import { workspaceFile } from '../core/safePaths';
import { ReviewEvent, ReviewView, Thread } from '../core/types';

interface Entry { position: PositionAnchor; signature: string }
interface Source {
  text: Text; revision: string; dirty: boolean; available: boolean;
  entries: Map<string, Entry>;
  history: Map<string, Map<string, PositionAnchor>>;
  checkpoints: SourceCheckpoint[]; checkpointStamp: string;
}
const signature = (thread: Thread) => JSON.stringify(thread.anchor ?? [thread.range, thread.snapshot]);
const key = (review: string, id: string) => JSON.stringify([review, id]);
/** One source authority for native editors, webviews, and persisted AI views. */
export class AnchorStore {
  private sources = new Map<string, Source>();
  constructor(private dir: string) {}
  private source(file: string): Source {
    let source = this.sources.get(file);
    if (!source) {
      let text = '', available = true;
      try { text = fs.readFileSync(workspaceFile(path.dirname(this.dir), file), 'utf8'); } catch { available = false; }
      const doc = sourceText(text);
      source = { text: doc, revision: sourceRevision(doc.toString()), dirty: false, available, entries: new Map(), history: new Map(), checkpoints: readCheckpoints(this.dir, file), checkpointStamp: this.savedStamp(file) };
      this.sources.set(file, source);
    }
    return source;
  }
  private savedStamp(file: string) {
    const target = checkpointPath(this.dir, file);
    return [target, target + '.previous'].map(p => {
      try { const s = fs.statSync(p); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
    }).join('|');
  }
  private refreshSaved(file: string, source: Source) {
    const stamp = this.savedStamp(file);
    if (stamp === source.checkpointStamp) return;
    source.checkpoints = readCheckpoints(this.dir, file); source.checkpointStamp = stamp;
    for (const checkpoint of source.checkpoints) {
      const positions = source.history.get(checkpoint.revision) ?? new Map<string, PositionAnchor>();
      for (const [id, entry] of source.entries) {
        const saved = checkpoint.entries[id];
        if (saved?.signature === entry.signature) positions.set(id, { ...saved.position });
      }
      source.history.set(checkpoint.revision, positions);
    }
    const current = source.checkpoints[0];
    if (!source.dirty && current?.revision === source.revision) {
      for (const [id, entry] of source.entries) {
        const saved = current.entries[id];
        if (saved?.signature === entry.signature) entry.position = { ...saved.position };
      }
    }
  }
  files() { return [...this.sources.keys()]; }
  text(file: string) { return this.source(file).text; }
  dirty(file: string) { return this.source(file).dirty; }
  private remember(source: Source) {
    source.history.set(source.revision, new Map([...source.entries].map(([id, entry]) => [id, { ...entry.position }])));
    if (source.history.size > 200) source.history.delete(source.history.keys().next().value!);
  }
  project(view: ReviewView, events: ReviewEvent[]): ReviewView {
    const present = new Set(view.threads.map(thread => key(view.name, thread.id)));
    for (const source of this.sources.values()) for (const id of source.entries.keys()) {
      if (JSON.parse(id)[0] === view.name && !present.has(id)) source.entries.delete(id);
    }
    const baselines = new Map<string, { text: Text; changes: ChangeSet } | null>(), checked = new Set<string>();
    return { ...view, threads: view.threads.map(thread => {
      const source = this.source(thread.file), id = key(view.name, thread.id), stamp = signature(thread);
      if (!checked.has(thread.file)) { this.refreshSaved(thread.file, source); checked.add(thread.file); }
      let entry = source.entries.get(id);
      if (!entry || entry.signature !== stamp) {
        // Reopening a previously saved revision can restore its exact positions,
        // even after deletion followed by Git checkout / Undo across a restart.
        let known: VersionedAnchor | undefined;
        for (const event of events) {
          if (event.op === 'add_thread' && event.id === thread.id && event.anchor?.revision === source.revision) known = event.anchor;
          if (event.op === 'set_anchors' && event.file === thread.file && event.revision === source.revision) {
            const a = event.anchors.find(a => a.thread === thread.id);
            if (a) known = { revision: event.revision, from: a.from, to: a.to, status: a.status };
          }
        }
        const saved = source.checkpoints.filter(c => c.entries[id]?.signature === stamp);
        const checkpoint = saved.find(c => c.revision === source.revision) ?? saved[0];
        const stored = checkpoint ? { ...checkpoint.entries[id].position, revision: checkpoint.revision } : known ?? thread.anchor;
        let position: PositionAnchor;
        if (!source.available) position = { ...offsets(source.text, thread.range), status: 'uncertain' };
        else if (!stored) position = migrateAnchor(source.text, thread.range, thread.snapshot);
        else if (stored.revision === source.revision && stored.from >= 0 && stored.to >= stored.from && stored.to <= source.text.length) position = { from: stored.from, to: stored.to, status: stored.status };
        else {
          const cacheKey = thread.file + ':' + stored.revision;
          if (!baselines.has(cacheKey)) {
            const baseline = checkpoint?.text ?? source.checkpoints.find(c => c.revision === stored.revision)?.text ?? readSnapshot(this.dir, stored.revision), text = baseline === null ? null : sourceText(baseline);
            baselines.set(cacheKey, text ? { text, changes: sourceChanges(text, source.text) } : null);
          }
          const baseline = baselines.get(cacheKey);
          if (!baseline || stored.from < 0 || stored.to < stored.from || stored.to > baseline.text.length) position = { ...offsets(source.text, thread.range), status: 'uncertain' };
          else position = rebaseAnchor(stored, baseline.text, source.text, baseline.changes);
        }
        entry = { position, signature: stamp }; source.entries.set(id, entry);
        for (const c of saved) {
          const positions = source.history.get(c.revision) ?? new Map<string, PositionAnchor>();
          positions.set(id, c.entries[id].position); source.history.set(c.revision, positions);
        }
        this.remember(source);
      }
      return { ...thread, range: source.available ? lineRange(source.text, entry.position) : thread.range,
        anchor: { ...entry.position, revision: source.revision }, sourceDirty: source.dirty };
    }) };
  }
  update(file: string, text: string, changes?: ChangeSet, dirty = false) {
    const source = this.source(file), after = sourceText(text), revision = sourceRevision(after.toString());
    const wasAvailable = source.available;
    source.dirty = dirty; source.available = true;
    if (revision === source.revision) {
      if (!wasAvailable) for (const [id, entry] of source.entries) entry.position = source.history.get(revision)?.get(id) ?? entry.position;
      return;
    }
    this.remember(source);
    const known = source.history.get(revision);
    const exact = changes && changes.length === source.text.length && changes.apply(source.text).eq(after);
    const mapping = exact ? changes : sourceChanges(source.text, after);
    for (const [id, entry] of source.entries) {
      entry.position = known?.get(id) ?? (exact ? mapAnchor(entry.position, mapping) : rebaseAnchor(entry.position, source.text, after, mapping));
    }
    source.text = after; source.revision = revision; this.remember(source);
  }
  disk(file: string) {
    const source = this.source(file);
    if (source.dirty) return;
    try { this.update(file, fs.readFileSync(workspaceFile(path.dirname(this.dir), file), 'utf8')); }
    catch { source.available = false; for (const entry of source.entries.values()) entry.position = { ...entry.position, status: 'uncertain' }; }
  }
  capture(file: string, range: Thread['range']): VersionedAnchor | undefined {
    const source = this.source(file);
    if (!source.available) return undefined;
    return { ...offsets(source.text, range), revision: source.revision };
  }
  checkpoint(file: string, allowDirty = false): void {
    const source = this.source(file);
    if (!source.available || (source.dirty && !allowDirty) || !source.entries.size) return;
    const state: SourceCheckpoint = { version: 1, file, text: source.text.toString(), revision: source.revision,
      entries: Object.fromEntries([...source.entries].map(([id, e]) => [id, { signature: e.signature, position: { ...e.position } }])) };
    writeCheckpoint(this.dir, state, source.checkpoints[0] ?? null);
    source.checkpoints = readCheckpoints(this.dir, file); source.checkpointStamp = this.savedStamp(file);
  }
  forgetReview(review: string): void {
    for (const source of this.sources.values()) for (const id of source.entries.keys()) {
      if (JSON.parse(id)[0] === review) source.entries.delete(id);
    }
  }
}
