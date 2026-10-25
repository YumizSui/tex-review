import { ChangeSet } from '@codemirror/state';
import { sourceText, offsets, mapAnchor, lineRange } from './commentAnchors';
import { sourceRevision } from './sourceSnapshots';
import { ReviewView, SetAnchorsEvent } from './types';
export interface SourceEdit {
    from: number;
    to: number;
    before: string;
    text: string;
}
export interface AnchorTarget {
    review: string;
    thread: string;
    from: number;
    to: number;
    quote: string;
}
export interface SourceTransaction {
    id: string;
    file: string;
    revision: string;
    reviewRevision: string;
    edits: SourceEdit[];
    anchors: AnchorTarget[];
    dryRun?: boolean;
}
export const reviewRevision = (views: ReviewView[], file: string) => sourceRevision(JSON.stringify(views.map(v => ({ name: v.name, threads: v.threads.filter(t => t.file === file) }))));
export function planTransaction(request: SourceTransaction, before: string, views: ReviewView[]) {
    if (!request || !/^[a-zA-Z0-9_-]{8,100}$/.test(request.id) || typeof request.file !== 'string')
        throw new Error('Invalid transaction identity.');
    const base = sourceText(before);
    if (request.revision !== sourceRevision(base.toString()) || request.reviewRevision !== reviewRevision(views, request.file))
        throw new Error('Revision conflict. Read the source and comments again.');
    if (!Array.isArray(request.edits) || !request.edits.length || request.edits.length > 1000 || !Array.isArray(request.anchors))
        throw new Error('Provide edits and an anchors array.');
    const edits = [...request.edits].sort((a, b) => a.from - b.from || a.to - b.to);
    let end = -1;
    for (const edit of edits) {
        if (!Number.isSafeInteger(edit.from) || !Number.isSafeInteger(edit.to) || edit.from < 0 || edit.to < edit.from || edit.to > base.length || edit.from <= end || typeof edit.text !== 'string' || edit.text.includes('\r') || base.sliceString(edit.from, edit.to) !== edit.before)
            throw new Error('Invalid, overlapping, or stale edit. Use LF-normalized UTF-16 offsets.');
        end = edit.to === edit.from ? edit.to : edit.to - 1;
    }
    const changes = ChangeSet.of(edits.map(e => ({ from: e.from, to: e.to, insert: e.text })), base.length);
    const after = changes.apply(base), revision = sourceRevision(after.toString());
    const targets = new Map<string, AnchorTarget>();
    for (const target of request.anchors) {
        const key = JSON.stringify([target.review, target.thread]);
        if (targets.has(key) || !Number.isSafeInteger(target.from) || !Number.isSafeInteger(target.to) || target.from < 0 || target.to < target.from || target.to > after.length || typeof target.quote !== 'string' || after.sliceString(target.from, target.to) !== target.quote)
            throw new Error('Invalid or ambiguous comment destination.');
        targets.set(key, target);
    }
    const missing: Array<{
        review: string;
        thread: string;
    }> = [];
    const events: Array<{
        review: string;
        event: SetAnchorsEvent;
    }> = [];
    for (const view of views) {
        const anchors: SetAnchorsEvent['anchors'] = [];
        for (const thread of view.threads.filter(t => t.file === request.file)) {
            const current = thread.anchor || offsets(base, thread.range), key = JSON.stringify([view.name, thread.id]);
            const target = targets.get(key);
            targets.delete(key);
            const touched = edits.some(e => e.from === e.to ? e.from > current.from && e.from < current.to : e.from < current.to && e.to > current.from);
            const mapped = mapAnchor(current, changes);
            if (!target && (touched || current.status === 'attached' && mapped.status !== 'attached'))
                missing.push({ review: view.name, thread: thread.id });
            const position = target ? { from: target.from, to: target.to, status: 'attached' as const } : mapped;
            anchors.push({ thread: thread.id, ...position, range: lineRange(after, position) });
        }
        if (anchors.length)
            events.push({ review: view.name, event: { op: 'set_anchors', file: request.file, revision, anchors, ts: new Date().toISOString(), transaction: request.id } });
    }
    if (targets.size)
        throw new Error('A comment destination names an unknown review or thread in this file.');
    if (missing.length)
        throw Object.assign(new Error('Every affected comment requires an explicit destination.'), { missing });
    return { before: base.toString(), after: after.toString(), revision, changes, events, edits };
}
