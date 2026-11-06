import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ReviewService } from './reviewService';
import { planTransaction, reviewRevision, SourceTransaction, SourceEdit } from '../core/sourceTransaction';
import { sourceText } from '../core/commentAnchors';
import { sourceRevision } from '../core/sourceSnapshots';
import { workspaceFile, rejectSymlink } from '../core/safePaths';
import { readLog } from '../core/storage';
import { checkpointPath } from '../core/sourceCheckpoints';
import { SetAnchorsEvent } from '../core/types';
import { assertSourceSaveStable, SourceSavePolicy } from '../core/sourceSavePolicy';
export interface SourceAccess {
    read(file: string): Promise<{
        text: string;
        dirty: boolean;
        version: number;
        savePolicy?: SourceSavePolicy;
    }>;
    apply(file: string, before: string, version: number, edits: SourceEdit[]): Promise<boolean>;
    save(file: string): Promise<boolean>;
}
interface Result {
    id: string;
    revision: string;
    committed: boolean;
    recovered?: boolean;
}
interface Journal {
    id: string;
    file: string;
    digest: string;
    before: string;
    after: string;
    revision: string;
    events: Array<{
        review: string;
        event: SetAnchorsEvent;
    }>;
}
/** One durable intent, bounded receipts, and idempotent event publication. No source-history copies. */
export class SourceTransactions {
    private dir: string;
    constructor(private root: string, private service: ReviewService, private access: SourceAccess) {
        this.dir = workspaceFile(root, '.review/transactions');
        rejectSymlink(path.dirname(this.dir));
        rejectSymlink(this.dir);
        fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
    private target(name: string) { const p = path.join(this.dir, name); rejectSymlink(this.dir); rejectSymlink(p); return p; }
    private write(name: string, value: unknown) {
        const target = this.target(name), tmp = this.target('.' + randomUUID() + '.tmp');
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify(value));
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, target);
        // Persist the rename before changing source or removing the journal.
        if (process.platform !== 'win32') {
            const directory = fs.openSync(this.dir, 'r');
            try {
                fs.fsyncSync(directory);
            }
            finally {
                fs.closeSync(directory);
            }
        }
    }
    private receipts(): Array<{
        id: string;
        digest: string;
        result: Result;
    }> {
        try {
            return JSON.parse(fs.readFileSync(this.target('receipts.json'), 'utf8'));
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return [];
            throw e;
        }
    }
    private receipt(journal: Journal, result: Result) {
        const receipts = this.receipts().filter(r => r.id !== journal.id);
        receipts.push({ id: journal.id, digest: journal.digest, result });
        this.write('receipts.json', receipts.slice(-100));
        fs.unlinkSync(this.target('pending.json'));
    }
    private pending(): Journal | undefined {
        try {
            const envelope = JSON.parse(fs.readFileSync(this.target('pending.json'), 'utf8'));
            if (!envelope.data || sourceRevision(JSON.stringify(envelope.data)) !== envelope.checksum)
                throw new Error('Transaction journal failed its integrity check.');
            return envelope.data;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                return;
            throw e;
        }
    }
    private views() { return this.service.list().map(name => this.service.view(name)); }
    private hasEvent(review: string, id: string) { return readLog(path.join(this.root, '.review'), review).some(e => e.op === 'set_anchors' && e.transaction === id); }
    private disk(file: string) { return sourceText(fs.readFileSync(workspaceFile(this.root, file), 'utf8')).toString(); }
    private async verifySaved(journal: Journal, message: string) {
        const current = await this.access.read(journal.file);
        if (current.dirty || sourceText(current.text).toString() !== journal.after || this.disk(journal.file) !== journal.after)
            throw new Error(message);
    }
    private finish(journal: Journal, recovered = false): Result {
        this.service.updateDocument(journal.file, journal.after, undefined, false);
        for (const { review, event } of journal.events)
            if (!this.hasEvent(review, journal.id))
                this.service.apply(event, review);
        // Verify each intended correspondence before declaring the transaction complete.
        for (const { review, event } of journal.events) {
            const view = this.service.view(review);
            for (const expected of event.anchors) {
                const actual = view.threads.find(t => t.id === expected.thread)?.anchor;
                if (!actual || actual.revision !== event.revision || actual.from !== expected.from || actual.to !== expected.to || actual.status !== expected.status)
                    throw new Error('Comment transaction verification failed. Recovery is required.');
            }
        }
        for (const file of [workspaceFile(this.root, journal.file), checkpointPath(path.join(this.root, '.review'), journal.file), ...journal.events.map(e => path.join(this.root, '.review', e.review + '.log.jsonl'))]) {
            if (!fs.existsSync(file))
                continue;
            rejectSymlink(file);
            const fd = fs.openSync(file, 'r');
            try {
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
        }
        if (process.platform !== 'win32')
            for (const directory of new Set([path.dirname(workspaceFile(this.root, journal.file)), path.join(this.root, '.review'), path.dirname(checkpointPath(path.join(this.root, '.review'), journal.file))])) {
                if (!fs.existsSync(directory))
                    continue;
                const fd = fs.openSync(directory, 'r');
                try {
                    fs.fsyncSync(fd);
                }
                finally {
                    fs.closeSync(fd);
                }
            }
        const result = { id: journal.id, revision: journal.revision, committed: true, ...(recovered ? { recovered: true } : {}) };
        this.receipt(journal, result);
        this.service.endTransaction();
        return result;
    }
    async recover(): Promise<Result | undefined> {
        const journal = this.pending();
        if (!journal)
            return;
        if (!this.service.transactionPending)
            this.service.beginTransaction();
        workspaceFile(this.root, journal.file);
        if (sourceRevision(journal.after) !== journal.revision)
            throw new Error('Invalid transaction journal. Manual recovery is required.');
        const current = await this.access.read(journal.file), text = sourceText(current.text).toString();
        const disk = this.disk(journal.file);
        const published = journal.events.some(e => this.hasEvent(e.review, journal.id));
        if (text === journal.before && disk === journal.before && !current.dirty && !published) {
            const result = { id: journal.id, revision: sourceRevision(text), committed: false, recovered: true };
            this.receipt(journal, result);
            this.service.endTransaction();
            return result;
        }
        if (text !== journal.after || disk !== journal.after && (!current.dirty || disk !== journal.before))
            throw new Error('A pending transaction conflicts with subsequent source changes. The journal is retained; no source was overwritten.');
        if (current.dirty) {
            assertSourceSaveStable(journal.after, current.savePolicy);
            if (!await this.access.save(journal.file))
                throw new Error('Unable to save the pending transaction. Retry recovery after resolving the save failure.');
        }
        await this.verifySaved(journal, 'Source changed during transaction recovery. The journal is retained.');
        return this.finish(journal, true);
    }
    async read(file: string) {
        await this.recover();
        this.validateFile(file);
        const current = await this.access.read(file), text = sourceText(current.text).toString();
        this.service.updateDocument(file, text, undefined, current.dirty);
        const views = this.views();
        return { file, text, reviews: this.service.list(), activeReview: this.service.active(), revision: sourceRevision(text), reviewRevision: reviewRevision(views, file), dirty: current.dirty,
            threads: views.flatMap(view => view.threads.filter(t => t.file === file).map(t => ({ review: view.name, ...t, currentQuote: t.anchor ? text.slice(t.anchor.from, t.anchor.to) : undefined }))) };
    }
    private validateFile(file: string) { if (typeof file !== 'string' || (!/\.(tex|txt|md|markdown)$/i.test(file) && !this.service.trackedFiles().includes(file)))
        throw new Error('Only workspace text sources are supported.'); workspaceFile(this.root, file); }
    async transact(request: SourceTransaction) {
        this.validateFile(request.file);
        const digest = sourceRevision(JSON.stringify(request));
        const receipt = this.receipts().find(r => r.id === request.id);
        if (receipt) {
            if (receipt.digest !== digest)
                throw new Error('Transaction ID was already used for a different request.');
            return receipt.result;
        }
        await this.recover();
        // A recovered transaction may have just completed this exact request.
        const recovered = this.receipts().find(r => r.id === request.id);
        if (recovered) {
            if (recovered.digest !== digest)
                throw new Error('Transaction ID mismatch.');
            return recovered.result;
        }
        const current = await this.access.read(request.file), before = sourceText(current.text).toString();
        if (current.dirty)
            throw new Error('Save or discard existing editor changes before an AI transaction.');
        if (sourceText(fs.readFileSync(workspaceFile(this.root, request.file), 'utf8')).toString() !== before)
            throw new Error('Disk and editor differ. Wait for the source to reload.');
        this.service.updateDocument(request.file, before, undefined, false);
        const plan = planTransaction(request, before, this.views());
        assertSourceSaveStable(plan.after, current.savePolicy);
        if (request.dryRun)
            return { id: request.id, revision: plan.revision, committed: false, validated: true, anchors: plan.events };
        const journal: Journal = { id: request.id, file: request.file, digest, before, after: plan.after, revision: plan.revision, events: plan.events };
        this.service.beginTransaction();
        let attempted = false, refused = false;
        try {
            this.write('pending.json', { data: journal, checksum: sourceRevision(JSON.stringify(journal)) });
            if (reviewRevision(this.views(), request.file) !== request.reviewRevision)
                throw new Error('Comments changed before the transaction was applied.');
            attempted = true;
            if (!await this.access.apply(request.file, before, current.version, plan.edits)) {
                refused = true;
                throw new Error('Editor revision changed before the transaction was applied.');
            }
            const applied = await this.access.read(request.file);
            if (sourceText(applied.text).toString() !== plan.after)
                throw new Error('Source changed during the transaction. Recovery is required.');
            this.service.updateDocument(request.file, plan.after, plan.changes, true);
            if (!await this.access.save(request.file))
                throw new Error('Unable to save the transaction. Recovery is required.');
            await this.verifySaved(journal, 'Saved source or editor differs from the transaction. Recovery is required.');
            return this.finish(journal);
        }
        catch (error) {
            // Failure before any change is an abort. Later failures retain the complete intent for recovery.
            let state;
            try { state = await this.access.read(request.file); }
            catch { throw error; } // An unavailable editor must retain the journal and the original failure.
            if ((!attempted || refused || sourceText(state.text).toString() === before && !state.dirty && this.disk(request.file) === before) && !journal.events.some(e => this.hasEvent(e.review, journal.id))) {
                if (fs.existsSync(this.target('pending.json')))
                    this.receipt(journal, { id: request.id, revision: request.revision, committed: false });
                this.service.endTransaction();
            }
            throw error;
        }
    }
}
