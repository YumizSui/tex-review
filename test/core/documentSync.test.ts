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
