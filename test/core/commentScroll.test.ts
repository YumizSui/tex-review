import { describe, it, expect, vi } from 'vitest';
import { commentScrollHandler } from '../../media/commentScroll.js';

describe('comment scrolling gesture ownership', () => {
  const wheel = (target: any, deltaY = 20) => ({ target, deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, preventDefault: vi.fn() });
  it('does not switch from source to card as a card moves under the pointer', () => {
    const source = { scrollTop: 0 }, card = { scrollTop: 0 }; let time = 0;
    const scroll = commentScrollHandler(source, (target: any) => target, () => 20, () => time);
    scroll(wheel(null)); time += 30; scroll(wheel(card));
    expect(source.scrollTop).toBe(40); expect(card.scrollTop).toBe(0);
    time += 200; scroll(wheel(card)); expect(card.scrollTop).toBe(20);
  });
  it('keeps the card at its scroll boundary instead of moving the source', () => {
    const source = { scrollTop: 0 }, card = { get scrollTop() { return 100; }, set scrollTop(_value: number) {} }; let time = 0;
    const scroll = commentScrollHandler(source, (target: any) => target, () => 20, () => time);
    scroll(wheel(card)); time += 30; scroll(wheel(null));
    expect(source.scrollTop).toBe(0); expect(card.scrollTop).toBe(100);
  });
  it('leaves pinch zoom and horizontal gestures alone', () => {
    const source = { scrollTop: 0 }, scroll = commentScrollHandler(source, () => null, () => 20);
    const zoom = { ...wheel(null), ctrlKey: true }, horizontal = { ...wheel(null), deltaX: 50 };
    scroll(zoom); scroll(horizontal);
    expect(zoom.preventDefault).not.toHaveBeenCalled(); expect(horizontal.preventDefault).not.toHaveBeenCalled();
  });
});

describe('scroll chaining within the comments pane', () => {
  const container = (initial: number, max: number) => {
    let top=initial;
    return {get scrollTop(){return top;},set scrollTop(value:number){top=Math.max(0,Math.min(max,value));}};
  };
  const wheel = (target:any,deltaY:number) => ({target,deltaY,deltaX:0,deltaMode:0,ctrlKey:false,preventDefault:vi.fn()});
  it('hands remaining distance to the outer pane without waiting for a new gesture', () => {
    const outer=container(0,1000),inner=container(90,100);let time=0;
    const scroll=commentScrollHandler(outer,()=>inner,()=>20,()=>time,()=>outer);
    scroll(wheel(inner,30));expect(inner.scrollTop).toBe(100);expect(outer.scrollTop).toBe(20);
    time+=20;scroll(wheel(inner,30));expect(outer.scrollTop).toBe(50);
    time+=20;scroll(wheel(inner,-10));expect(outer.scrollTop).toBe(40);expect(inner.scrollTop).toBe(100);
  });
  it('chains from a reply field through its card before moving the outer list', () => {
    const outer=container(0,1000),card=container(0,20),input=container(0,10);let time=0;
    const scroll=commentScrollHandler(outer,()=>input,()=>20,()=>time,(owner:any)=>owner===input?card:outer);
    scroll(wheel(input,25));expect(input.scrollTop).toBe(10);expect(card.scrollTop).toBe(15);expect(outer.scrollTop).toBe(0);
    time+=20;scroll(wheel(input,25));expect(card.scrollTop).toBe(20);expect(outer.scrollTop).toBe(20);
  });
});
