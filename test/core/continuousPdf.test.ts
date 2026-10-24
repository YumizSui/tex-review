import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContinuousPdf } from '../../media/continuousPdf.js';

class Element {
  style: Record<string,string>={}; dataset: Record<string,unknown>={}; children: Element[]=[]; parent?: Element;
  width=0; height=0; clientWidth=624; clientHeight=600; private scroll=0;
  get scrollTop(){return this.scroll;} set scrollTop(value:number){this.scroll=Math.max(0,value);}
  get offsetHeight(){return Number.parseFloat(this.style.height)||0;}
  get offsetTop(): number {const siblings=this.parent?.children??[];return 12+siblings.slice(0,siblings.indexOf(this)).reduce((n,e)=>n+e.offsetHeight+12,0);}
  addEventListener(){} setAttribute(){} getContext(){return {};}
  append(e:Element){this.children.push(e);e.parent=this;} prepend(e:Element){this.children.unshift(e);e.parent=this;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(e=>e!==this);}
  replaceChildren(){for(const e of this.children)e.parent=undefined;this.children=[];}
  querySelector(){return null;}
}
function fixture(count=200){
 vi.useFakeTimers();vi.stubGlobal('document',{createElement:()=>new Element()});vi.stubGlobal('window',{devicePixelRatio:2});
 const container=new Element();
 const page={getViewport:({scale}:{scale:number})=>({width:600*scale,height:800*scale}),render:vi.fn(()=>({promise:Promise.resolve(),cancel:vi.fn()})),cleanup:vi.fn()};
 const pdf={numPages:count,getPage:vi.fn(async()=>page)};
 const viewer=new ContinuousPdf(container,{onPage:vi.fn(),onInverse:vi.fn(),onError:vi.fn()});
 return {viewer,pdf,page,container};
}
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('bounded continuous PDF work',()=>{
 it('opens a long PDF without fetching every page, then fetches only nearby pages',async()=>{
  const {viewer,pdf}=fixture();await viewer.load(pdf);
  expect(viewer.pages).toHaveLength(200);expect(pdf.getPage).toHaveBeenCalledTimes(1);
  await viewer.render();expect(pdf.getPage.mock.calls.length).toBeLessThan(5);
 });
 it('releases bitmap memory when a canvas is evicted or the document is cleared',async()=>{
  const {viewer,pdf,container}=fixture();await viewer.load(pdf);await viewer.render();
  const canvas=viewer.pages[0].canvas;expect(canvas.width).toBeGreaterThan(0);
  container.scrollTop=20*812;await viewer.render();expect(canvas.width).toBe(0);expect(canvas.height).toBe(0);
  const retained=viewer.pages.filter((p:any)=>p.canvas).map((p:any)=>p.canvas);expect(retained.length).toBeLessThan(5);
  viewer.clear();for(const c of retained)expect(c.width).toBe(0);
 });
 it('stops an obsolete render batch after scrolling during a slow page render',async()=>{
  const {viewer,pdf,page,container}=fixture();let finish!:()=>void;
  page.render.mockImplementationOnce(()=>({promise:new Promise<void>(r=>finish=r),cancel:vi.fn()}));
  await viewer.load(pdf);const rendering=viewer.render();await Promise.resolve();await Promise.resolve();
  expect(finish).toBeTypeOf('function');container.scrollTop=40*812;viewer.schedule();finish();await rendering;
  expect(pdf.getPage).toHaveBeenCalledTimes(1);
  await viewer.render();expect(pdf.getPage.mock.calls.length).toBeLessThan(6);
  expect(viewer.pages[40].canvas).toBeTruthy();
 });
 it('ignores a first-page fetch that completes after the PDF has been replaced',async()=>{
  const {viewer,pdf}=fixture();let finish!: (value:unknown)=>void;
  const old={numPages:200,getPage:()=>new Promise(r=>finish=r)};const loading=viewer.load(old);
  await viewer.load(pdf);finish(await pdf.getPage());await loading;
  expect(viewer.pdf).toBe(pdf);expect(viewer.pages).toHaveLength(200);
 });
 it('uses the target page size before navigating to a differently sized page',async()=>{
  const {viewer,pdf,page,container}=fixture();
  const landscape={...page,getViewport:({scale}:{scale:number})=>({width:800*scale,height:600*scale})};
  pdf.getPage.mockImplementation(async(number?:number)=>number===50?landscape:page);
  await viewer.load(pdf);await viewer.goTo(50,100);
  const target=viewer.pages[49];expect(target.scale).toBe(.75);
  expect(container.scrollTop).toBe(target.sheet.offsetTop-12+75-container.clientHeight/3);
 });
});
