import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { ReviewService } from '../../src/vscode/reviewService';

/** Run via --extensionTestsPath in a disposable workspace, never a real document workspace. */
export async function run() {
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  assert.ok(root.includes('tex-anchor-runtime-qa'));
  const extension = vscode.extensions.getExtension('furui-local.tex-review');
  assert.ok(extension); await extension.activate();
  const migrationLog = path.join(root, 'expected-legacy-log.txt');
  if (fs.existsSync(migrationLog)) {
    assert.equal(fs.existsSync(path.join(root, '.review', 'sources')), false);
    assert.equal(fs.readFileSync(path.join(root, '.review', 'legacy.log.jsonl'), 'utf8'), fs.readFileSync(migrationLog, 'utf8'));
    assert.equal(new ReviewService(path.join(root, '.review')).view('legacy').threads[0].range.startLine, 2);
  }
  const file = path.join(root, 'main.tex'), dir = path.join(root, '.review');
  const original = 'same\nsame\nend\n'; fs.writeFileSync(file, original);
  const fixture = new ReviewService(dir); fixture.createReview('runtime');
  fixture.apply({ op: 'add_thread', id: 'native', file: 'main.tex', range: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }, snapshot: 'same', author: 'test', body: 'Follow second occurrence', ts: new Date().toISOString() });
  const doc = await vscode.workspace.openTextDocument(file);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'runtime.view.json'), 'utf8')).threads[0];
  let edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'same\n');
  assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save();
  assert.equal(read().range.startLine, 3); assert.equal(read().anchor.status, 'attached'); assert.equal(read().sourceDirty, false);
  // Two non-adjacent edits must not swallow the comment's target.
  edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(0, 0), 'prefix\n'); edit.replace(doc.uri, new vscode.Range(3, 0, 3, 3), 'tail');
  assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save();
  assert.equal(read().range.startLine, 4); assert.equal(read().anchor.status, 'attached');
  edit = new vscode.WorkspaceEdit(); edit.delete(doc.uri, new vscode.Range(3, 0, 3, 4));
  assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save(); assert.equal(read().anchor.status, 'deleted');
  edit = new vscode.WorkspaceEdit(); edit.insert(doc.uri, new vscode.Position(3, 0), 'same');
  assert.ok(await vscode.workspace.applyEdit(edit)); await doc.save(); assert.equal(read().anchor.status, 'attached');
  assert.equal(read().range.startLine, 4);
  assert.equal(new ReviewService(dir).view('runtime').threads[0].range.startLine, 4);
  fs.writeFileSync(path.join(root, 'PASS.json'), JSON.stringify({ nativeEdits: true, multiEdit: true, deletedUndo: true, saveReload: true, legacyMigration: fs.existsSync(migrationLog) }));
}
