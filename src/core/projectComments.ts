import { Thread } from './types';
/** Build-input order, then source position. Stable IDs distinguish co-located threads. */
export function projectComments(threads: Thread[], files: string[], resolved = false): Thread[] {
  const order = new Map(files.map((file, index) => [file, index]));
  return threads.filter(thread => order.has(thread.file) && (resolved || thread.status === 'open')).sort((a, b) =>
    order.get(a.file)! - order.get(b.file)! || a.range.startLine - b.range.startLine ||
    (a.range.startColumn || 1) - (b.range.startColumn || 1) || a.id.localeCompare(b.id));
}
