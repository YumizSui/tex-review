import { describe, it, expect } from 'vitest';
import { documentUpdate } from '../../src/core/documentSync';

describe('native document synchronization', () => {
  it('does not mistake a tab-return snapshot for a conflict with typing in progress', () => {
    expect(documentUpdate({ type: 'document', version: 2, text: 'saved' }, { version: 2, confirmed: 'saved', local: 'saved plus typing', inflight: 'saved plus' })).toBe('ignore');
  });
  it('acknowledges accepted input without discarding subsequent keystrokes', () => {
    expect(documentUpdate({ type: 'ack', version: 3, text: 'saved plus' }, { version: 2, confirmed: 'saved', local: 'saved plus typing', inflight: 'saved plus' })).toBe('ack');
  });
  it('reloads external changes when no input is pending and distinguishes a real collision', () => {
    const message = { type: 'document', version: 3, text: 'AI updated' };
    expect(documentUpdate(message, { version: 2, confirmed: 'saved', local: 'saved', inflight: null })).toBe('replace');
    expect(documentUpdate(message, { version: 2, confirmed: 'saved', local: 'my typing', inflight: null })).toBe('conflict');
  });
});


it('accepts a reopened native document whose version restarts, and rejects its retired snapshots', () => {
 const before = {version: 50, generation: 0, confirmed: 'old text', local: 'old text', inflight: null};
 expect(documentUpdate({type:'document',version:1,generation:1,text:'new disk text'},before)).toBe('replace');
 const reopened = {version:1,generation:1,confirmed:'new disk text',local:'new disk text',inflight:null};
 expect(documentUpdate({type:'document',version:51,generation:0,text:'old text'},reopened)).toBe('ignore');
 expect(documentUpdate({type:'document',version:1,generation:1,text:'new disk text'},reopened)).toBe('ignore');
});


it('treats an autosave snapshot of accepted input as acknowledgement while more typing is queued', () => {
 expect(documentUpdate({type:'document',version:3,text:'saved plus'}, {version:2,confirmed:'saved',local:'saved plus typing',inflight:'saved plus'})).toBe('ack');
});
it('refreshes an unchanged native base without falsely conflicting with local typing', () => {
 expect(documentUpdate({type:'document',version:4,text:'saved'}, {version:2,confirmed:'saved',local:'saved plus typing',inflight:'saved plus'})).toBe('refresh');
});
