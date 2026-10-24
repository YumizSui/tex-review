import { PDFDocument, PDFName, PDFHexString, PDFString, PDFArray, PDFRef } from 'pdf-lib';
import { Thread } from './types';
export interface LocatedThread { thread: Thread; page: number; x: number; y: number }
/** Standard PDF Text annotations; /IRT + /RT preserve Acrobat-style replies. */
export async function annotatedPdf(input: Uint8Array, threads: LocatedThread[]): Promise<Uint8Array> {
  const document = await PDFDocument.load(input);
  const pages = document.getPages();
  for (const { thread, page: pageNumber, x, y } of threads) {
    const page = pages[pageNumber - 1];
    if (!page || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rectangle = [Math.max(0, x - 20), Math.max(0, page.getHeight() - y - 12), Math.max(0, x - 2), Math.max(0, page.getHeight() - y + 6)];
    const annots = page.node.Annots() ?? document.context.obj([]);
    if (!page.node.Annots()) page.node.set(PDFName.of('Annots'), annots);
    let parent: PDFRef | undefined;
    for (const [index, comment] of thread.comments.entries()) {
      const annotation = document.context.obj({
        Type: PDFName.of('Annot'), Subtype: PDFName.of('Text'), Rect: rectangle,
        Contents: PDFHexString.fromText(comment.body), T: PDFHexString.fromText(comment.author),
        Subj: PDFHexString.fromText(`${thread.file}:${thread.range.startLine}`),
        NM: PDFHexString.fromText(comment.id), Name: PDFName.of('Comment'), Open: false, F: 4,
        C: [0.25, 0.55, 0.9], M: PDFString.of('D:' + comment.createdAt.replace(/\D/g, '').slice(0, 14) + 'Z'),
        ...(parent ? { IRT: parent, RT: PDFName.of('R') } : {}),
        ...(thread.status === 'resolved' && index === 0 ? { StateModel: PDFString.of('Review'), State: PDFString.of('Completed') } : {}),
      });
      const ref = document.context.register(annotation);
      (annots as PDFArray).push(ref);
      if (!parent) parent = ref;
    }
  }
  return document.save();
}
