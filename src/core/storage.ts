import * as fs from 'fs';
import * as path from 'path';
import { ReviewEvent, ReviewView } from './types';
import { validateReviewName, rejectSymlink } from './safePaths';

function checked(dir: string, file: string): string {
  rejectSymlink(dir);
  const target = path.join(dir, file);
  rejectSymlink(target);
  return target;
}

export interface ReviewState {
  active: string | null;
}

export function logPath(dir: string, name: string): string {
  return checked(dir, `${validateReviewName(name)}.log.jsonl`);
}
export function viewPath(dir: string, name: string): string {
  return checked(dir, `${validateReviewName(name)}.view.json`);
}
export function statePath(dir: string): string {
  return checked(dir, 'state.json');
}

export function ensureLog(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const p = logPath(dir, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

export function appendEvent(dir: string, name: string, event: ReviewEvent): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logPath(dir, name), JSON.stringify(event) + '\n');
}

export function readLog(dir: string, name: string): ReviewEvent[] {
  const p = logPath(dir, name);
  if (!fs.existsSync(p)) return [];
  // The log is a multi-writer surface: agents append to it out-of-band, so a
  // single malformed line (partial write, crash mid-append, hand-edit) must not
  // take down the whole review. Skip lines that don't parse, warn, keep the rest.
  const events: ReviewEvent[] = [];
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim().length === 0) continue;
    try {
      events.push(JSON.parse(l) as ReviewEvent);
    } catch (err) {
      console.warn(`[review] skipping malformed log line ${i + 1} in ${p}: ${String(err)}`);
    }
  }
  return events;
}

function writeAtomic(target: string, contents: string): void {
  const tmp = target + '.tmp';
  rejectSymlink(target);
  rejectSymlink(tmp);
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

export function writeView(dir: string, name: string, view: ReviewView): void {
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(viewPath(dir, name), JSON.stringify(view, null, 2));
}

export function readState(dir: string): ReviewState {
  const p = statePath(dir);
  if (!fs.existsSync(p)) return { active: null };
  // A corrupt state.json must not make every command throw. Recover to "no
  // active review" rather than propagating a parse error into the whole UI.
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ReviewState;
    return { active: typeof parsed.active === 'string' ? validateReviewName(parsed.active) : null };
  } catch (err) {
    console.warn(`[review] state.json unreadable, resetting active review: ${String(err)}`);
    return { active: null };
  }
}

export function writeState(dir: string, state: ReviewState): void {
  if (state.active) validateReviewName(state.active);
  rejectSymlink(dir);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(statePath(dir), JSON.stringify(state, null, 2));
}

export function listReviews(dir: string): string[] {
  rejectSymlink(dir);
  if (!fs.existsSync(dir)) return [];
  const suffix = '.log.jsonl';
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length))
    .sort();
}

export function removeReview(dir: string, name: string): void {
  for (const p of [logPath(dir, name), viewPath(dir, name)]) {
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}
