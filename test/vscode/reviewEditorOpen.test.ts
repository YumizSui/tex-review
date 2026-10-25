import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ReviewEditor } from '../../src/vscode/reviewEditor';
import { ReviewService } from '../../src/vscode/reviewService';
afterEach(() => vi.restoreAllMocks());
describe('manuscript session entry points', () => {
  it('reuses the session and transfers the selected text without opening another custom tab', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-session-open-'));
    fs.writeFileSync(path.join(root, 'chapter.tex'), '1234567890');
    const uri = { scheme: 'file', fsPath: path.join(root, 'chapter.tex'), toString: () => 'file://' + path.join(root, 'chapter.tex') };
    const editor = new ReviewEditor({ workspaceState: { get: () => undefined }, subscriptions: [] } as any,
      { uri: { fsPath: root } } as any, new ReviewService(path.join(root, '.review')));
    Object.assign(vscode.window, { activeTextEditor: { document: { uri, getText: () => '1234567890', offsetAt: (p: number) => p }, selection: { start: 2, end: 8 } } });
    const reveal = vi.fn(), postMessage = vi.fn().mockResolvedValue(true);
    Object.assign(editor, {session: {reveal,webview:{postMessage}},sessionReady:true,selectedRoot:undefined});
    const open = vi.spyOn(vscode.commands,'executeCommand');
    await editor.open(true);
    expect(reveal).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({type:'requestNavigation',file:'chapter.tex',selection:{from:2,to:8,compose:true},explicit:true,root:undefined});
    fs.rmSync(root,{recursive:true,force:true});
  });
  it('reveals an existing manuscript even when no native editor is active',async()=>{
    const editor = new ReviewEditor({workspaceState:{get:()=>undefined},subscriptions:[]} as any,{uri:{fsPath:'/workspace'}} as any,new ReviewService('/workspace/.review'));
    Object.assign(vscode.window,{activeTextEditor:undefined});const reveal=vi.fn();Object.assign(editor,{session:{reveal}});
    await editor.open();expect(reveal).toHaveBeenCalledOnce();
  });
});
