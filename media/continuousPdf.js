import { pdfLinkAt, resolvePdfDestination } from './pdfLinks.js';
/** Continuous pages with a small canvas window, so long theses stay inexpensive. */
export class ContinuousPdf {
  constructor(container, { onPage, onInverse, onError, onMeasure = () => {} }) {
    this.container = container; this.onPage = onPage; this.onInverse = onInverse; this.onError = onError;
    this.pages = []; this.generation = 0; this.navigation = 0; this.width = 0; this.running = false;
    this.onMeasure = onMeasure;
    container.addEventListener('scroll', () => { this.updatePage(); this.schedule(); }, { passive: true });
  }
  clear() {
    clearTimeout(this.timer); this.pending = false;
    this.generation++; this.navigation++; this.task?.cancel();
    for (const entry of this.pages) this.releaseCanvas(entry);
    this.pdf = null; this.pages = []; this.width = 0;
    this.container.replaceChildren();
  }
  async load(pdf) {
    this.clear(); const generation = this.generation; this.pdf = pdf;
    const first = await pdf.getPage(1);
    if (generation !== this.generation) return;
    const viewport = first.getViewport({ scale: 1 });
    for (let number = 1; number <= pdf.numPages; number++) {
      const sheet = document.createElement('div'); sheet.className = 'pdf-sheet'; sheet.dataset.page = number;
      sheet.setAttribute('aria-label', `Page ${number}`);
      sheet.addEventListener('click', event => { void this.clickPage(this.pages[number - 1], event).catch(error => this.onError(error)); });
      this.pages.push({ number, page: number === 1 ? first : null, sheet, width: viewport.width, height: viewport.height, scale: 1 });
      this.container.append(sheet);
    }
    this.resize();
  }
  async pageFor(entry) {
    if (entry.page) return entry.page;
    const pdf = this.pdf;
    const page = await (entry.loading ??= pdf.getPage(entry.number));
    if (this.pdf !== pdf) return null;
    entry.page = page;
    const viewport = page.getViewport({ scale: 1 });
    if (entry.width !== viewport.width || entry.height !== viewport.height) {
      entry.width = viewport.width; entry.height = viewport.height;
      this.width = 0; this.resize();
    }
    return page;
  }
  releaseCanvas(entry) {
    if (!entry.canvas) return;
    entry.canvas.remove(); entry.canvas.width = 0; entry.canvas.height = 0; entry.canvas = null;
    entry.page?.cleanup?.();
  }
  async clickPage(entry, event) {
    if (!entry) return;
    const pdf = this.pdf, page = await this.pageFor(entry);
    if (!page || this.pdf !== pdf) return;
    const rect = entry.sheet.getBoundingClientRect();
    const x = (event.clientX - rect.left) / entry.scale, y = (event.clientY - rect.top) / entry.scale;
    entry.annotations ??= page.getAnnotations({ intent: 'display' });
    const annotations = await entry.annotations;
    if (this.pdf !== pdf) return;
    const link = pdfLinkAt(annotations, page.getViewport({ scale: 1 }), x, y);
    if (link) {
      const destination = await resolvePdfDestination(pdf, link.dest);
      if (this.pdf === pdf && destination) this.goTo(destination.page, destination.y);
      return;
    }
    this.onInverse({ page: entry.number, x, y });
  }
  resize() {
    if (!this.pages.length || !this.container.clientWidth) return;
    const width = Math.max(40, this.container.clientWidth - 24);
    if (width !== this.width) {
      const current = this.pages.find(p => p.sheet.offsetTop + p.sheet.offsetHeight > this.container.scrollTop) || this.pages[0];
      const fraction = (this.container.scrollTop - current.sheet.offsetTop) / Math.max(1, current.sheet.offsetHeight);
      this.width = width; this.generation++; this.task?.cancel();
      for (const entry of this.pages) {
        entry.scale = width / entry.width;
        entry.sheet.style.width = `${width}px`; entry.sheet.style.height = `${entry.height * entry.scale}px`;
        this.releaseCanvas(entry);
      }
      this.container.scrollTop = current.sheet.offsetTop + fraction * current.sheet.offsetHeight;
    }
    this.updatePage(); this.schedule();
  }
  async goTo(number, y) {
    const entry = this.pages[Math.max(0, Math.min(this.pages.length - 1, number - 1))];
    if (!entry) return;
    const navigation = ++this.navigation;
    try { if (!await this.pageFor(entry) || navigation !== this.navigation) return; }
    catch (error) { this.onError(error); return; }
    this.container.querySelector('.pdf-highlight')?.remove();
    if (Number.isFinite(y)) {
      const marker = document.createElement('div'); marker.className = 'pdf-highlight';
      marker.style.top = `${Math.max(0, y * entry.scale - 5)}px`; entry.sheet.append(marker);
    }
    this.container.scrollTop = Math.max(0, entry.sheet.offsetTop - 12 + (Number.isFinite(y) ? y * entry.scale - this.container.clientHeight / 3 : 0));
    this.updatePage(); this.schedule();
  }
  updatePage() {
    const position = this.container.scrollTop + this.container.clientHeight * .25;
    const entry = this.pages.find(p => p.sheet.offsetTop + p.sheet.offsetHeight > position) || this.pages.at(-1);
    if (entry) this.onPage(entry.number);
  }
  schedule() {
    this.pending = true;
    clearTimeout(this.timer); this.timer = setTimeout(() => this.render(), 30);
  }
  async render() {
    if (this.running || !this.pdf || !this.container.clientWidth) return;
    this.running = true; this.pending = false; const generation = this.generation;
    const started = performance.now();
    try {
      const top = this.container.scrollTop, height = this.container.clientHeight;
      // Read page geometry before any canvas writes to avoid repeated forced layout.
      const visible = this.pages.filter(entry => entry.sheet.offsetTop + entry.sheet.offsetHeight >= top - height && entry.sheet.offsetTop <= top + height * 2);
      const keep = new Set(visible);
      for (const entry of this.pages) if (!keep.has(entry)) this.releaseCanvas(entry);
      for (const entry of visible) {
        if (generation !== this.generation || this.pending) break;
        if (entry.canvas) continue;
        const page = await this.pageFor(entry);
        if (!page || generation !== this.generation || this.pending) break;
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({ scale: entry.scale * (window.devicePixelRatio || 1) });
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        entry.canvas = canvas; entry.sheet.prepend(canvas);
        try {
          this.task = page.render({ canvasContext: canvas.getContext('2d'), viewport }); await this.task.promise;
        } catch (error) { canvas.remove(); if (entry.canvas === canvas) entry.canvas = null; throw error; }
      }
    } catch (error) { if (error.name !== 'RenderingCancelledException') this.onError(error); }
    finally { this.onMeasure('pdf.render', performance.now() - started); this.running = false; if (this.pending || generation !== this.generation) this.schedule(); }
  }
}
