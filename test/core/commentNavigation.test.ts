import { describe, expect, it } from 'vitest';
import { adjacentComment } from '../../src/core/commentNavigation';
const entries = [{ id: 'later', from: 30 }, { id: 'first', from: 10 }, { id: 'same', from: 10 }];
describe('comment navigation', () => {
  it('follows source order, including distinct threads at the same position', () => {
    expect(adjacentComment(entries, 'first', 10, 1)).toBe('same');
    expect(adjacentComment(entries, 'later', 30, -1)).toBe('same');
  });
  it('wraps at either end and handles a single thread', () => {
    expect(adjacentComment(entries, 'later', 30, 1)).toBe('first');
    expect(adjacentComment(entries, 'first', 10, -1)).toBe('later');
    expect(adjacentComment(entries.slice(0, 1), 'later', 30, 1)).toBe('later');
  });
  it('starts at the cursor when no visible thread is selected', () => {
    expect(adjacentComment(entries, null, 20, 1)).toBe('later');
    expect(adjacentComment(entries, 'hidden', 20, -1)).toBe('same');
    expect(adjacentComment(entries, null, 10, 1)).toBe('first');
    expect(adjacentComment([], null, 0, 1)).toBeUndefined();
  });
});
