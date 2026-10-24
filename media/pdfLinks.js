/** PDF destinations use zero-based pages and PDF coordinates, not SyncTeX positions. */
export async function resolvePdfDestination(pdf, target) {
  const destination = typeof target === 'string' ? await pdf.getDestination(target) : target;
  if (!Array.isArray(destination) || destination.length < 2) return null;
  const index = Number.isInteger(destination[0]) ? destination[0] : await pdf.getPageIndex(destination[0]);
  if (!Number.isInteger(index) || index < 0 || index >= pdf.numPages) return null;
  const page = await pdf.getPage(index + 1), viewport = page.getViewport({ scale: 1 });
  const kind = destination[1]?.name;
  const top = kind === 'XYZ' ? destination[3] : kind === 'FitH' || kind === 'FitBH' ? destination[2] : kind === 'FitR' ? destination[5] : null;
  return { page: index + 1, y: Number.isFinite(top) ? viewport.convertToViewportPoint(page.view[0], top)[1] : undefined };
}

export function pdfLinkAt(annotations, viewport, x, y) {
  const [px, py] = viewport.convertToPdfPoint(x, y);
  return annotations.find(annotation => {
    if (annotation.subtype !== 'Link' || !annotation.dest || !Array.isArray(annotation.rect)) return false;
    const [x1, y1, x2, y2] = annotation.rect;
    return px >= Math.min(x1, x2) && px <= Math.max(x1, x2) && py >= Math.min(y1, y2) && py <= Math.max(y1, y2);
  });
}
