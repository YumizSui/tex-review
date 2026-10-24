import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFDict, PDFHexString, PDFRef } from 'pdf-lib';
import { annotatedPdf } from '../../src/core/annotatedPdf';
describe('PDF comments and replies', () => {
  it('preserves Japanese content and links replies to the first annotation', async () => {
    const doc = await PDFDocument.create(); doc.addPage([600,800]);
    const bytes = await annotatedPdf(await doc.save(), [{ page:1,x:100,y:120,thread:{
      id:'t_1',file:'chapter.tex',range:{startLine:12,endLine:12},snapshot:'対象',status:'open',createdAt:'2026-10-16T00:00:00Z',
      comments:[{id:'t_1.c1',author:'reviewer',body:'日本語のコメント',createdAt:'2026-10-16T00:00:00Z'},
        {id:'t_1.c2',author:'agent',body:'返信です',createdAt:'2026-10-16T00:00:01Z'}],
    }}]);
    const result=await PDFDocument.load(bytes), annotations=result.getPage(0).node.Annots()!;
    expect(annotations.size()).toBe(2);
    const first=result.context.lookup(annotations.get(0),PDFDict), reply=result.context.lookup(annotations.get(1),PDFDict);
    expect((first.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('日本語のコメント');
    expect((reply.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('返信です');
    expect((reply.get(PDFName.of('IRT')) as PDFRef).toString()).toBe(annotations.get(0).toString());
    expect(reply.get(PDFName.of('RT'))?.toString()).toBe('/R');
  });
});
