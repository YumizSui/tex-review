import { describe, it, expect } from 'vitest';
import { commentHighlights } from '../../src/core/commentHighlights';
describe('comment highlight coverage', () => {
  it('paints repeated and partially overlapping comments only once', () => {
    expect(commentHighlights([{from:1,to:8,selected:false},{from:1,to:8,selected:false},{from:4,to:10,selected:false}]))
      .toEqual([{from:1,to:10,selected:false}]);
  });
  it('gives selected comments precedence without nesting background colors', () => {
    expect(commentHighlights([{from:1,to:10,selected:false},{from:3,to:7,selected:true},{from:5,to:9,selected:true}]))
      .toEqual([{from:1,to:3,selected:false},{from:3,to:9,selected:true},{from:9,to:10,selected:false}]);
  });
  it('keeps gaps and ignores empty ranges', () => {
    expect(commentHighlights([{from:1,to:2,selected:false},{from:4,to:5,selected:false},{from:2,to:2,selected:true}]))
      .toEqual([{from:1,to:2,selected:false},{from:4,to:5,selected:false}]);
  });
});
