import { describe, expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceApiRuntime } from '../../src/vscode/sourceApiRuntime';

function deferred() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return { promise, release };
}
describe('source API admission and cancellation boundaries', () => {
    it('bounds the queue and never begins a write after its response deadline', async () => {
        const runtime = new SourceApiRuntime(() => false, () => {}, { documentTimeoutMs: 10, requestTimeoutMs: 60, maxQueued: 1 });
        const gate = deferred(); let writes = 0, queued = 0;
        try {
            const first = runtime.submit({ op: 'transact' }, async () => {
                await gate.promise;
                return runtime.step('editor.apply', () => ++writes, { mutation: true });
            });
            const second = runtime.submit({ op: 'transact' }, async () => ++queued);
            expect(await runtime.submit({ op: 'read' }, async () => null)).toMatchObject({ code: 'QUEUE_FULL', outcome: 'not_started' });
            expect(await first).toMatchObject({ code: 'OPERATION_TIMEOUT', outcome: 'pending' });
            expect(await second).toMatchObject({ code: 'QUEUE_TIMEOUT', outcome: 'not_started' });
            gate.release(); await delay(10);
            expect(writes).toBe(0); expect(queued).toBe(0);
            expect(runtime.status().active).toBeNull();
        } finally { gate.release(); runtime.dispose(); }
    });
    it('fences new saves after disposal even when an issued edit finishes later', async () => {
        const runtime = new SourceApiRuntime(() => true, () => {}, { documentTimeoutMs: 10, requestTimeoutMs: 100 });
        const gate = deferred(); let saves = 0;
        const result = runtime.submit({ op: 'transact' }, async () => {
            await runtime.step('editor.apply', () => gate.promise, { mutation: true });
            return runtime.step('editor.save', () => ++saves, { mutation: true });
        });
        await delay(5);
        runtime.dispose();
        expect(await result).toMatchObject({ code: 'API_DISPOSED', outcome: 'pending' });
        gate.release(); await delay(10);
        expect(saves).toBe(0);
        expect(runtime.status()).toMatchObject({ state: 'disposed', recoveryRequired: true });
    });
    it('rejects an already disconnected request without running it', async () => {
        const runtime = new SourceApiRuntime(() => false, () => {}), controller = new AbortController();
        controller.abort(); let ran = false;
        expect(await runtime.submit({ op: 'transact' }, async () => { ran = true; }, controller.signal)).toMatchObject({ code: 'REQUEST_DISCONNECTED', outcome: 'not_started' });
        expect(ran).toBe(false); runtime.dispose();
    });
    it.each([{ documentTimeoutMs: 0 }, { requestTimeoutMs: 30000 }, { maxQueued: -1 }, { documentTimeoutMs: 20000 }])('rejects invalid API limits %j', limits => {
        expect(() => new SourceApiRuntime(() => false, () => {}, limits)).toThrow('API limits');
    });
});
