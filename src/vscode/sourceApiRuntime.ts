export interface ApiResponse {
    ok: boolean;
    result?: unknown;
    error?: string;
    code?: string;
    stage?: string;
    outcome?: 'not_started' | 'pending';
    recoveryRequired?: boolean;
    missing?: unknown;
}
export interface ApiLimits {
    documentTimeoutMs: number;
    requestTimeoutMs: number;
    maxQueued: number;
}
export const defaultApiLimits: ApiLimits = { documentTimeoutMs: 5000, requestTimeoutMs: 20000, maxQueued: 64 };
interface RequestInfo { op: string; file?: string }
interface Job extends RequestInfo {
    id: number;
    accepted: number;
    deadline: number;
    started?: number;
    stage: string;
    stageStarted: number;
    mutationStarted: boolean;
    expired: boolean;
    disconnected: boolean;
    answered: boolean;
    work: () => Promise<unknown>;
    reply: (response: ApiResponse) => void;
    timer: ReturnType<typeof setTimeout>;
    detach: () => void;
}
export class ApiError extends Error {
    constructor(public code: string, message: string, public stage?: string) { super(message); }
}
/** The response deadline never releases a running writer's lock or cancels an editor RPC. */
export class SourceApiRuntime {
    readonly limits: ApiLimits;
    private active?: Job;
    private queue: Job[] = [];
    private sequence = 0;
    private disposed = false;
    private startup: 'starting' | 'ready' | 'recovery_required' = 'starting';
    private recent: Array<Record<string, unknown>> = [];
    constructor(private recoveryRequired: () => boolean, private log: (line: string) => void, limits: Partial<ApiLimits> = {}) {
        this.limits = { ...defaultApiLimits, ...limits };
        const { documentTimeoutMs, requestTimeoutMs, maxQueued } = this.limits;
        if (![documentTimeoutMs, requestTimeoutMs, maxQueued].every(n => Number.isSafeInteger(n) && n > 0)
            || documentTimeoutMs >= requestTimeoutMs || requestTimeoutMs >= 30000)
            throw new Error('API limits require 0 < document timeout < request timeout < 30000 ms and a positive queue limit.');
    }
    private record(job: Job, event: string, code?: string) {
        const entry = { time: new Date().toISOString(), request: job.id, op: job.op, file: job.file, stage: job.stage, event, code, elapsedMs: Date.now() - job.accepted };
        this.recent.push(entry);
        this.recent = this.recent.slice(-30);
        try { this.log(JSON.stringify(entry)); } catch { /* Output may already be disposed during shutdown. */ }
    }
    status() {
        const job = this.active;
        return {
            state: this.disposed ? 'disposed' : job?.expired ? 'stalled' : this.startup === 'starting' ? 'starting'
                : job ? 'running' : this.recoveryRequired() ? 'recovery_required' : this.startup,
            recoveryRequired: this.recoveryRequired(),
            active: job ? { request: job.id, op: job.op, file: job.file, stage: job.stage, elapsedMs: Date.now() - job.accepted,
                stageElapsedMs: Date.now() - job.stageStarted, mutationStarted: job.mutationStarted, responseExpired: job.expired } : null,
            queued: this.queue.filter(j => !j.expired && !j.disconnected).length,
            recent: [...this.recent],
        };
    }
    startupFinished(ok: boolean) { this.startup = ok ? 'ready' : 'recovery_required'; }
    private answer(job: Job, response: ApiResponse) {
        if (job.answered) return;
        job.answered = true;
        clearTimeout(job.timer);
        job.reply(response);
    }
    private failure(error: unknown): ApiResponse {
        const e = error as { code?: string; stage?: string; missing?: unknown };
        return { ok: false, error: String(error instanceof Error ? error.message : error), code: e?.code,
            stage: e?.stage, missing: e?.missing, recoveryRequired: this.recoveryRequired() };
    }
    submit(info: RequestInfo, work: () => Promise<unknown>, signal?: AbortSignal): Promise<ApiResponse> {
        if (this.disposed) return Promise.resolve(this.failure(new ApiError('API_DISPOSED', 'The source API is shutting down.')));
        if (signal?.aborted) return Promise.resolve({ ...this.failure(new ApiError('REQUEST_DISCONNECTED', 'Request disconnected before execution.')), outcome: 'not_started' });
        if (this.active?.expired) return Promise.resolve({ ...this.failure(new ApiError('OPERATION_IN_PROGRESS',
            'An editor operation is still running. Use status and retry the same request and ID after it settles.', this.active.stage)), outcome: 'not_started' });
        if (this.queue.length >= this.limits.maxQueued) return Promise.resolve({ ...this.failure(new ApiError('QUEUE_FULL', 'The source API queue is full.')), outcome: 'not_started' });
        return new Promise(resolve => {
            const accepted = Date.now();
            const job: Job = { ...info, id: ++this.sequence, accepted, deadline: accepted + this.limits.requestTimeoutMs,
                stage: 'queued', stageStarted: accepted, mutationStarted: false, expired: false, disconnected: signal?.aborted ?? false,
                answered: false, work, reply: resolve, timer: undefined!, detach: () => {} };
            job.timer = setTimeout(() => {
                job.expired = true;
                this.record(job, 'deadline', job.started === undefined ? 'QUEUE_TIMEOUT' : 'OPERATION_TIMEOUT');
                this.answer(job, { ...this.failure(new ApiError(job.started === undefined ? 'QUEUE_TIMEOUT' : 'OPERATION_TIMEOUT',
                    job.started === undefined ? 'Request expired before execution.' : 'Operation is still settling. Retry the same request and ID; use status for progress.', job.stage)),
                    outcome: job.started === undefined ? 'not_started' : 'pending' });
                if (job.started === undefined) this.remove(job);
            }, this.limits.requestTimeoutMs);
            const disconnect = () => {
                job.disconnected = true;
                this.record(job, 'disconnected');
                if (job.started === undefined) {
                    this.answer(job, { ...this.failure(new ApiError('REQUEST_DISCONNECTED', 'Request disconnected before execution.')), outcome: 'not_started' });
                    this.remove(job);
                }
            };
            signal?.addEventListener('abort', disconnect, { once: true });
            job.detach = () => signal?.removeEventListener('abort', disconnect);
            this.queue.push(job);
            this.record(job, 'accepted');
            this.pump();
        });
    }
    private remove(job: Job) {
        this.queue = this.queue.filter(j => j !== job);
        job.detach();
    }
    private pump() {
        if (this.active || this.disposed) return;
        const job = this.queue.shift();
        if (!job) return;
        this.active = job;
        job.started = Date.now();
        job.stage = 'dispatch';
        job.stageStarted = job.started;
        void (async () => {
            try {
                this.check();
                this.record(job, 'started');
                const result = await job.work();
                this.record(job, 'completed');
                this.answer(job, { ok: true, result });
            } catch (error) {
                this.record(job, 'failed', (error as ApiError)?.code);
                this.answer(job, this.failure(error));
            } finally {
                clearTimeout(job.timer);
                job.detach();
                this.active = undefined;
                this.pump();
            }
        })();
    }
    private check() {
        const job = this.active;
        if (this.disposed) throw new ApiError('API_DISPOSED', 'The source API is shutting down.', job?.stage);
        if (job && !job.mutationStarted && (job.disconnected || job.expired || Date.now() >= job.deadline))
            throw new ApiError('REQUEST_EXPIRED', 'Request ended before editing began.', job.stage);
    }
    /** Only document acquisition is raced. applyEdit/save stay locked until their real promise settles. */
    async step<T>(stage: string, work: () => PromiseLike<T> | T, options: { document?: boolean; mutation?: boolean } = {}): Promise<T> {
        this.check();
        const job = this.active!;
        const previous = { stage: job.stage, stageStarted: job.stageStarted };
        job.stage = stage;
        job.stageStarted = Date.now();
        if (options.mutation) job.mutationStarted = true;
        this.record(job, 'stage_started');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const pending = Promise.resolve().then(work);
            const result = options.document ? await Promise.race([pending, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new ApiError('DOCUMENT_OPEN_TIMEOUT', 'Editor document acquisition timed out.', stage)), this.limits.documentTimeoutMs);
            })]) : await pending;
            this.check();
            this.record(job, 'stage_completed');
            return result;
        } catch (error) {
            this.record(job, 'stage_failed', (error as ApiError)?.code);
            throw error;
        } finally {
            clearTimeout(timer);
            job.stage = previous.stage;
            job.stageStarted = previous.stageStarted;
        }
    }
    dispose() {
        this.disposed = true;
        for (const job of this.queue.splice(0)) {
            this.answer(job, { ...this.failure(new ApiError('API_DISPOSED', 'The source API is shutting down.')), outcome: 'not_started' });
            job.detach();
        }
        if (this.active) {
            this.answer(this.active, { ...this.failure(new ApiError('API_DISPOSED', 'The source API is shutting down.')), outcome: 'pending' });
            this.active.detach();
        }
    }
}
