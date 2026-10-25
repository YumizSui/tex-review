import { describe,it,expect } from 'vitest';
import { commentBottomPadding, layoutCards, layoutViewportCards } from '../../src/core/cardLayout';
describe('focused comment alignment', () => {
  const cards=[{id:'a',anchor:90,height:150},{id:'b',anchor:110,height:100},{id:'c',anchor:130,height:80}];
  it('pins a focused middle card and moves neighbors in both directions',()=>{
    expect(layoutCards(cards,'b')).toEqual([-50,110,220]);
  });
  it('never pushes the focused card downward when earlier cards are large',()=>{
    expect(layoutCards(cards,'c')).toEqual([-140,20,130]);
  });
  it('tracks the source scroll exactly for the focused card',()=>{
    const before=layoutCards(cards,'b');
    const after=layoutCards(cards.map(c=>({...c,anchor:c.anchor-55})),'b');
    expect(after[1]-before[1]).toBe(-55);
  });
  it('does not overlap unselected cards',()=>{
    expect(layoutCards(cards,null)).toEqual([90,250,360]);
  });
  it('keeps above-viewport cards in the layout without pushing visible cards down',()=>{
    const before=layoutCards(cards,null);
    const after=layoutCards(cards.map(c=>({...c,anchor:c.anchor-180})),null);
    expect(after).toEqual(before.map(top=>top-180));
    expect(after[0]).toBeLessThan(0);
  });

  it('does not let long offscreen discussions push a visible discussion down',()=>{
    const dense = Array.from({length:20},(_,i)=>({id:`old-${i}`,anchor:-3000+i*100,height:350}));
    dense.push({id:'visible',anchor:100,height:350},{id:'next',anchor:450,height:200});
    expect(layoutViewportCards(dense,null,800)[20]).toBe(100);
  });
  it('scrolls dense cards continuously across every automatic alignment handover',()=>{
    const dense=Array.from({length:180},(_,i)=>({id:String(i),anchor:12+i*42,height:i%9===0?450:270}));
    let previous=layoutViewportCards(dense,null,800),largest=0;
    for(let scroll=.25;scroll<2000;scroll+=.25){
      const tops=layoutViewportCards(dense.map(c=>({...c,anchor:c.anchor-scroll})),null,800);
      largest=Math.max(largest,...tops.map((top,i)=>Math.abs(top-previous[i])));
      if(scroll%50===0)for(let i=1;i<tops.length;i++)expect(tops[i]).toBeGreaterThanOrEqual(tops[i-1]+dense[i-1].height+10-1e-7);
      previous=tops;
    }
    expect(largest).toBeLessThan(5);
  });
  it('keeps selection exactly aligned until its whole card leaves the viewport',()=>{
    expect(layoutViewportCards(cards,'b',700)).toEqual(layoutCards(cards,'b'));
    const partial=cards.map(c=>({...c,anchor:c.anchor-150}));
    expect(layoutViewportCards(partial,'b',700)).toEqual(layoutCards(partial,'b'));
  });
  it('releases an offscreen selection continuously and ignores distant selections',()=>{
    const around=(scroll:number)=>layoutViewportCards(cards.map(c=>({...c,anchor:c.anchor-scroll})),'b',700);
    for(const boundary of [210,910,-590,-1290]){
      expect(Math.max(...around(boundary-.001).map((top,i)=>Math.abs(top-around(boundary+.001)[i])))).toBeLessThan(.1);
    }
    const distant=[{id:'far',anchor:-2000,height:300},{id:'visible',anchor:50,height:200}];
    expect(layoutViewportCards(distant,'far',700)).toEqual(layoutViewportCards(distant,null,700));
  });
  it('does not jump when several comments share the same source line',()=>{
    const group=[{id:'a',anchor:100,height:200},{id:'b',anchor:100,height:180},{id:'c',anchor:100,height:300},{id:'d',anchor:400,height:200}];
    const before=layoutViewportCards(group.map(c=>({...c,anchor:c.anchor-99.999})),null,700);
    const after=layoutViewportCards(group.map(c=>({...c,anchor:c.anchor-100.001})),null,700);
    expect(Math.max(...before.map((top,i)=>Math.abs(top-after[i])))).toBeLessThan(.1);
    expect(layoutViewportCards(group,'b',700)[1]).toBe(100);
  });
  it('returns to the same positions when scrolling back and handles an empty rail',()=>{
    expect(layoutViewportCards([],null,700)).toEqual([]);
    const first=layoutViewportCards(cards,null,700);
    layoutViewportCards(cards.map(c=>({...c,anchor:c.anchor-400})),null,700);
    expect(layoutViewportCards(cards,null,700)).toEqual(first);
  });
});

describe('end-of-source comment scroll range', () => {
  it('reserves room for a long final discussion without changing its source anchor', () => {
    expect(commentBottomPadding([{id:'end',anchor:250,height:220}],300)).toBe(182);
  });
  it('accounts for several discussions on the same final line', () => {
    const cards=[{id:'a',anchor:100,height:200},{id:'b',anchor:100,height:180},{id:'c',anchor:100,height:300}];
    expect(commentBottomPadding(cards,150)).toBe(662);
    expect(commentBottomPadding(cards.map(c=>({...c,anchor:c.anchor-500})), -350)).toBe(662);
  });
  it('removes extra space when comments are hidden or finish before the source', () => {
    expect(commentBottomPadding([],300)).toBe(0);
    expect(commentBottomPadding([{id:'early',anchor:30,height:100}],300)).toBe(0);
  });
});
