import { PDFDocument } from 'pdf-lib';
import { Meta, emptyMeta } from './types.ts';

export async function readPdf(buf: Buffer): Promise<Meta> {
  const meta = emptyMeta();
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    meta.title = doc.getTitle() || undefined;
    const author = doc.getAuthor();
    if (author) meta.authors = author.split(/\s*[;,]\s*/).filter(Boolean);
    meta.description = doc.getSubject() || undefined;
    const kw = doc.getKeywords();
    if (kw) meta.tags = kw.split(/\s*[;,]\s*/).filter(Boolean);
    meta.pages = doc.getPageCount();
  } catch {
    // unreadable/encrypted PDF: fall back to filename heuristics upstream
  }
  return meta;
}

export async function writePdf(buf: Buffer, meta: Meta): Promise<Buffer> {
  const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
  const title = meta.title ? (meta.subtitle ? `${meta.title}: ${meta.subtitle}` : meta.title) : undefined;
  if (title) doc.setTitle(title);
  if (meta.authors.length) doc.setAuthor(meta.authors.join('; '));
  if (meta.description) doc.setSubject(meta.description.slice(0, 1000));
  const kw = [...meta.tags];
  if (meta.series) kw.push(`Série: ${meta.series}${meta.seriesIndex != null ? ` #${meta.seriesIndex}` : ''}`);
  if (kw.length) doc.setKeywords(kw);
  return Buffer.from(await doc.save());
}
