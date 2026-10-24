import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { unifiedMergeView, getChunks, getOriginalDoc } from '@codemirror/merge';

describe('editable comparison', () => {
  it('keeps only current text in the document and recalculates diff after edits', () => {
    let state = EditorState.create({ doc: 'current\nunchanged\n', extensions: [
      unifiedMergeView({ original: 'baseline\nunchanged\n', mergeControls: false }),
    ] });
    expect(getChunks(state)?.chunks).toHaveLength(1);
    expect(state.doc.line(1).text).toBe('current');
    state = state.update({ changes: { from: 0, to: 7, insert: 'baseline' } }).state;
    expect(getChunks(state)?.chunks).toHaveLength(0);
    expect(getOriginalDoc(state).toString()).toBe('baseline\nunchanged\n');
  });
  it('uses current source line numbers for PDF sync despite deleted baseline lines', () => {
    const state = EditorState.create({ doc: 'start\ntarget\nend\n', extensions: [
      unifiedMergeView({ original: 'start\nremoved1\nremoved2\nremoved3\ntarget\nend\n', mergeControls: false }),
    ] });
    expect(getChunks(state)?.chunks.length).toBeGreaterThan(0);
    expect(state.doc.lineAt(state.doc.toString().indexOf('target')).number).toBe(2);
  });

});
