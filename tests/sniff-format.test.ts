import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { applyMeta, detectFormat, readMeta } from '../server/formats/index.ts';
import { makeEpub } from './helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-sniff-'));

async function makePdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  doc.setTitle('Embutido');
  return Buffer.from(await doc.save());
}

describe('detectFormat trusts the bytes over the extension', () => {
  it('a PDF named .epub (Anna\'s Archive does this) is a pdf', async () => {
    const f = path.join(tmp(), 'livro.epub');
    fs.writeFileSync(f, await makePdf());
    expect(await detectFormat(f)).toBe('pdf');
  });

  it('a real EPUB stays epub', async () => {
    const f = path.join(tmp(), 'livro.epub');
    fs.writeFileSync(f, await makeEpub({ title: 'x', authors: ['a'] }));
    expect(await detectFormat(f)).toBe('epub');
  });

  it('unknown content keeps the extension', async () => {
    const f = path.join(tmp(), 'livro.mobi');
    fs.writeFileSync(f, Buffer.from('BOOKMOBI-not-a-real-file'));
    expect(await detectFormat(f)).toBe('mobi');
  });
});

describe('a PDF disguised as .epub', () => {
  it('is read as a pdf instead of silently losing its metadata', async () => {
    const f = path.join(tmp(), 'Titulo -- Autor.epub');
    fs.writeFileSync(f, await makePdf());
    const { meta, sources } = await readMeta(f);
    expect(meta.title).toBe('Embutido');
    expect(sources.title).toBe('embedded');
  });

  it('is saved as a valid pdf, without the "end of central directory" zip error', async () => {
    const out = await applyMeta(await makePdf(), 'pdf', { title: 'Novo', authors: ['Fulano'], tags: [] });
    expect(out.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(out)).getTitle()).toBe('Novo');
  });
});
