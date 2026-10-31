import fs from 'node:fs/promises';
import path from 'node:path';
import { readEpub, writeEpub } from './epub.ts';
import { readPdf, writePdf } from './pdf.ts';
import { metaFromFilename } from './filename.ts';
import { Cover, Meta } from './types.ts';
import { norm } from '../util.ts';
import { scanFrontMatter } from './frontmatter.ts';

export * from './types.ts';
export { metaFromFilename, splitSeriesFromTitle } from './filename.ts';

export const formatOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** Formats whose metadata we can write back into the file. */
export const WRITABLE = new Set(['epub', 'pdf']);

/** Reads embedded metadata, filling gaps from the file name. */
export async function readMeta(file: string): Promise<{ meta: Meta; cover?: Cover; sources: Record<string, string> }> {
  const fmt = formatOf(file);
  const buf = await fs.readFile(file);
  let embedded: Meta | undefined;
  let cover: Cover | undefined;
  try {
    if (fmt === 'epub') ({ meta: embedded, cover } = await readEpub(buf));
    else if (fmt === 'pdf') embedded = await readPdf(buf);
  } catch {
    // corrupt file: rely on file name
  }
  const fromName = metaFromFilename(file);
  const meta: Meta = { ...fromName, ...(embedded ?? { authors: [], tags: [] }) };
  const sources: Record<string, string> = {};
  for (const k of Object.keys(meta) as (keyof Meta)[]) {
    const v = meta[k];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    const e = embedded?.[k];
    sources[k] = e != null && !(Array.isArray(e) && !e.length) ? 'embedded' : 'filename';
  }
  // what the OPF does not say is often printed in the book itself (copyright page, synopsis)
  if (fmt === 'epub') {
    const fm = await scanFrontMatter(buf);
    const fill = <K extends keyof Meta>(k: K, v: Meta[K] | undefined) => {
      if (v != null && (meta[k] == null || meta[k] === '')) {
        meta[k] = v;
        sources[k] = 'livro';
      }
    };
    fill('isbn', fm.isbn);
    fill('year', fm.year);
    fill('publisher', fm.publisher);
    fill('language', fm.language);
    fill('description', fm.synopsis);
  }
  // embedded PDFs often carry junk titles; prefer the file name when it looks cleaner
  if (fmt === 'pdf' && embedded?.title && /^(microsoft word|untitled|document)/i.test(embedded.title)) {
    meta.title = fromName.title;
    sources.title = 'filename';
  }
  if (!meta.authors.length) meta.authors = fromName.authors;
  if (norm(meta.title) === '' && fromName.title) meta.title = fromName.title;
  return { meta, cover, sources };
}

/** Returns the file bytes with `meta` (and optional cover) written inside, when the format supports it. */
export async function applyMeta(buf: Buffer, fmt: string, meta: Meta, cover?: Cover): Promise<Buffer> {
  if (fmt === 'epub') return writeEpub(buf, meta, cover);
  if (fmt === 'pdf') return writePdf(buf, meta);
  return buf;
}
