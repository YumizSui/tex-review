import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewService } from '../../src/vscode/reviewService';
import { ReviewPanel } from '../../src/vscode/reviewPanel';

vi.mock('vscode', async () => {
  const base = await import('../vscode-mock');
  return { ...base,
    OverviewRulerLane: { Right: 4 }, DecorationRangeBehavior: { ClosedClosed: 1 },
    ViewColumn: { One: 1, Two: 2, Beside: -2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Uri: { ...base.Uri, file: (file: string) => ({ fsPath: file }) },
    workspace: { ...base.workspace, getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
      get textDocuments() { return docs; }, openTextDocument: async () => docs[0] },
    window: { ...base.window, visibleTextEditors: [],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      showTextDocument: vi.fn(async () => ({ revealRange: vi.fn() })) },
  };
});
let dir: string;
let service: ReviewService;
let panel: ReviewPanel;
let docs: any[] = [];
let messages: any[];
const invoke = (m: unknown) => (panel as any).receive(m);
const event = { op: 'add_thread' as const, id: 't_1', file: 'a.tex', range: { startLine: 1, endLine: 1 },
  snapshot: '日本語の本文', body: '元コメント', author: 'reviewer', ts: '2026-10-16T00:00:00Z' };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-panel-'));
  fs.writeFileSync(path.join(dir, 'a.tex'), '日本語の本文\n');
  service = new ReviewService(path.join(dir, '.review')); service.createReview('thesis'); service.apply(event);
  docs = [{ uri: { fsPath: path.join(dir, 'a.tex') }, getText: () => '日本語の本文\n', lineCount: 2 }];
  messages = [];
  panel = new ReviewPanel({ subscriptions: [] } as any, { uri: { fsPath: dir } } as any, service);
  (panel as any).panel = { webview: { postMessage: (m: unknown) => { messages.push(m); return Promise.resolve(true); } }, dispose() {} };
});
afterEach(() => { panel.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('side-by-side review workflow', () => {
  it('adds a comment on relocated Japanese text without rewriting the existing log', async () => {
    docs[0].getText = () => '追加された行\n日本語の本文\n';
    const before = fs.readFileSync(path.join(dir, '.review/thesis.log.jsonl'), 'utf8');
    await invoke({ type: 'add', review: 'thesis', target: { file: 'a.tex', range: event.range, snapshot: event.snapshot }, body: '新しいコメント' });
    const view = service.view('thesis');
    expect(view.threads).toHaveLength(2);
    expect(view.threads[1].range.startLine).toBe(2);
    expect(fs.readFileSync(path.join(dir, '.review/thesis.log.jsonl'), 'utf8').startsWith(before)).toBe(true);
    expect(messages.some(m => m.type === 'saved')).toBe(true);
  });
  it('preserves old logs while replying, resolving, and reopening', async () => {
    await invoke({ type: 'reply', review: 'thesis', thread: 't_1', body: '返信\n2行目' });
    await invoke({ type: 'resolve', review: 'thesis', thread: 't_1' });
    expect(service.view('thesis').threads[0].status).toBe('resolved');
    await invoke({ type: 'reopen', review: 'thesis', thread: 't_1' });
    expect(service.view('thesis').threads[0].status).toBe('open');
    expect(service.view('thesis').threads[0].comments[1].body).toBe('返信\n2行目');
  });
  it('rejects a stale selection without adding a comment', async () => {
    docs[0].getText = () => '別の本文';
    await expect(invoke({ type: 'add', review: 'thesis', target: { file: 'a.tex', range: event.range, snapshot: event.snapshot }, body: 'x' })).rejects.toThrow('The text has changed');
    expect(service.view('thesis').threads).toHaveLength(1);
  });
  it('rejects a selection outside the workspace and a changed review', async () => {
    await expect(invoke({ type: 'add', review: 'thesis', target: { file: '../secret.tex', range: event.range, snapshot: event.snapshot }, body: 'x' })).rejects.toThrow();
    await expect(invoke({ type: 'reply', review: 'other', thread: 't_1', body: 'x' })).rejects.toThrow('The active review changed');
  });
  it('refreshes AI replies from an externally appended log', () => {
    fs.appendFileSync(path.join(dir, '.review/thesis.log.jsonl'), JSON.stringify({ op: 'reply', thread: 't_1', body: 'AIの返信', author: 'agent', ts: event.ts }) + '\n');
    panel.refresh();
    expect(messages.at(-1).threads[0].comments.at(-1).body).toBe('AIの返信');
  });
  it('allows reviewer edits but rejects edits to AI comments', async () => {
    service.apply({ op: 'reply', thread: 't_1', body: 'AI', author: 'agent', ts: event.ts });
    await invoke({ type: 'edit', review: 'thesis', thread: 't_1', comment: 't_1.c1', body: '変更' });
    expect(service.view('thesis').threads[0].comments[0].body).toBe('変更');
    await expect(invoke({ type: 'edit', review: 'thesis', thread: 't_1', comment: 't_1.c2', body: '変更' })).rejects.toThrow('This comment cannot');
  });
  it('navigates without invoking the native inline-comments API', async () => {
    const spy = vi.spyOn(vscode.comments, 'createCommentController');
    await invoke({ type: 'navigate', review: 'thesis', thread: 't_1' });
    expect(vscode.window.showTextDocument).toHaveBeenCalledWith(docs[0], expect.objectContaining({ preserveFocus: true }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
