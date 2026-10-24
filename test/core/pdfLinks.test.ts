import { describe, it, expect, vi } from 'vitest';
import { pdfLinkAt, resolvePdfDestination } from '../../media/pdfLinks.js';
import { ContinuousPdf } from '../../media/continuousPdf.js';

const viewport = { convertToPdfPoint: (x: number, y: number) => [x, 800 - y], convertToViewportPoint: (x: number, y: number) => [x, 800 - y] };
const page = { view: [0, 0, 600, 800], getViewport: () => viewport };
describe('PDF internal links take priority over inverse SyncTeX', () => {
  it('finds the annotation at the clicked PDF point', () => {
    const link = { subtype: 'Link', dest: 'chapter.1', rect: [50, 700, 500, 720] };
    expect(pdfLinkAt([link], viewport, 100, 90)).toBe(link);
    expect(pdfLinkAt([link], viewport, 100, 130)).toBeUndefined();
  });
  it('resolves named destinations to physical page numbers and viewport coordinates', async () => {
    const ref = { num: 21, gen: 0 };
    const pdf = { numPages: 20, getDestination: vi.fn().mockResolvedValue([ref, { name: 'XYZ' }, 70, 650, null]), getPageIndex: vi.fn().mockResolvedValue(14), getPage: vi.fn().mockResolvedValue(page) };
    expect(await resolvePdfDestination(pdf, 'chapter.1')).toEqual({ page: 15, y: 150 });
    expect(pdf.getPageIndex).toHaveBeenCalledWith(ref);
    expect(await resolvePdfDestination(pdf, [2, { name: 'Fit' }])).toEqual({ page: 3, y: undefined });
    expect(await resolvePdfDestination(pdf, [2, { name: 'FitH' }, 700])).toEqual({ page: 3, y: 100 });
  });
  it('navigates a TOC link inside the PDF without sending an inverse-search request', async () => {
    const inverse = vi.fn(), goTo = vi.fn(), pdf = { numPages: 20, getDestination: async () => [14, { name: 'XYZ' }, 70, 650, null], getPage: async () => page };
    const viewer = Object.assign(Object.create(ContinuousPdf.prototype), { pdf, onInverse: inverse, goTo });
    const entry = { number: 3, scale: .5, sheet: { getBoundingClientRect: () => ({ left: 10, top: 20 }) }, page: { ...page, getAnnotations: async () => [{ subtype: 'Link', dest: 'chapter.1', rect: [50, 700, 500, 720] }] } };
    await viewer.clickPage(entry, { clientX: 60, clientY: 65 });
    expect(goTo).toHaveBeenCalledWith(15, 150); expect(inverse).not.toHaveBeenCalled();
    await viewer.clickPage(entry, { clientX: 60, clientY: 100 });
    expect(inverse).toHaveBeenCalledWith({ page: 3, x: 100, y: 160 });
  });
});
