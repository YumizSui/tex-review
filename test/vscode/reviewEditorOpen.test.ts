import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ReviewEditor } from '../../src/vscode/reviewEditor';
import { ReviewService } from '../../src/vscode/reviewService';

afterEach(() => vi.restoreAllMocks());
describe('native editor to review input', () => {
  it('opens the current selection and starts input when a review panel already exists', async () => {
    const uri = { scheme: 'file', toString: () => 'file:///workspace/chapter.tex' };
    const editor = new ReviewEditor({ workspaceState: { get: () => undefined }, subscriptions: [] } as any,
      { uri: { fsPath: '/workspace' } } as any, new ReviewService('/workspace/.review'));
    Object.assign(vscode.window, { activeTextEditor: { document: { uri, offsetAt: (p: number) => p }, selection: { start: 12, end: 28 } } });
    const postMessage = vi.fn().mockResolvedValue(true);
    (editor as any).panels.set(uri.toString(), { webview: { postMessage } });
    const open = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await editor.open(true);
    expect(open).toHaveBeenCalledWith('vscode.openWith', uri, 'texReview.editor');
    expect(postMessage).toHaveBeenCalledWith({ type: 'activateSelection', from: 12, to: 28, compose: true });
  });
});
