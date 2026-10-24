import { describe, it, expect } from 'vitest';
import { newThreadId } from '../../src/core/ids';

describe('newThreadId', () => {
  it('prefixes with t_', () => {
    expect(newThreadId(() => 0).startsWith('t_')).toBe(true);
  });

  it('is deterministic given a fixed rng', () => {
    expect(newThreadId(() => 0)).toBe(newThreadId(() => 0));
  });

  it('produces different ids for different rng values', () => {
    expect(newThreadId(() => 0.1)).not.toBe(newThreadId(() => 0.9));
  });
});
