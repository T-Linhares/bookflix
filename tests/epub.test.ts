import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { readEpub, writeEpub } from '../server/formats/epub.ts';
import { splitSeriesFromTitle, metaFromFilename } from '../server/formats/filename.ts';
import { partialMd5OfBuffer } from '../server/util.ts';
import { makeEpub } from './helpers.ts';

describe('epub metadata', () => {
  it('reads embedded metadata', async () => {
    const buf = await makeEpub({ title: 'The Final Empire', authors: ['Brandon Sanderson'], series: 'Mistborn', index: 1, publisher: 'Tor', year: 2006, cover: true });
    const { meta, cover } = await readEpub(buf);
    expect(meta).toMatchObject({ title: 'The Final Empire', authors: ['Brandon Sanderson'], series: 'Mistborn', seriesIndex: 1, publisher: 'Tor', year: 2006, language: 'en' });
    expect(cover?.ext).toBe('png');
  });

  it('round-trips written metadata without keeping stale fields', async () => {
    const buf = await makeEpub({ title: 'old', authors: ['Old Author'], series: 'Old Series', index: 9, publisher: 'Old' });
    const out = await writeEpub(buf, {
      title: 'Elantris',
      subtitle: 'Edição Especial',
      authors: ['Brandon Sanderson', 'Outro & Co'],
      series: 'Cosmere',
      seriesIndex: 0.5,
      publisher: 'Tor <Books>',
      year: 2005,
      description: 'Custa $5 & "vale".',
      tags: ['Fantasy', 'Magic'],
    });
    const { meta } = await readEpub(out);
    expect(meta.title).toBe('Elantris: Edição Especial');
    expect(meta.authors).toEqual(['Brandon Sanderson', 'Outro & Co']);
    expect(meta.series).toBe('Cosmere');
    expect(meta.seriesIndex).toBe(0.5);
    expect(meta.publisher).toBe('Tor <Books>');
    expect(meta.year).toBe(2005);
    expect(meta.description).toBe('Custa $5 & "vale".');
    expect(meta.tags).toEqual(['Fantasy', 'Magic']);
    const zip = await JSZip.loadAsync(out);
    const opf = await zip.file('OEBPS/content.opf')!.async('string');
    expect(opf.match(/calibre:series"/g)).toHaveLength(1);
    expect(opf).not.toContain('Old Author');
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
  });

  it('replaces the cover image', async () => {
    const buf = await makeEpub({ title: 'x', authors: ['a'], cover: true });
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)]);
    const out = await writeEpub(buf, { title: 'x', authors: ['a'], tags: [] }, { data: png, ext: 'png' });
    expect((await readEpub(out)).cover?.data.equals(png)).toBe(true);
  });

  it('partial md5 is a 32-char hex digest', async () => {
    const buf = await makeEpub({ title: 'x' });
    expect(partialMd5OfBuffer(buf)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('filename heuristics', () => {
  it('extracts series from title patterns', () => {
    expect(splitSeriesFromTitle('The Final Empire (Mistborn, #1)')).toEqual({ title: 'The Final Empire', series: 'Mistborn', seriesIndex: 1 });
    expect(splitSeriesFromTitle('Mistborn #2 - The Well of Ascension')).toEqual({ title: 'The Well of Ascension', series: 'Mistborn', seriesIndex: 2 });
    expect(splitSeriesFromTitle('Dune')).toEqual({ title: 'Dune' });
  });
  it('reads Autor - Título file names', () => {
    expect(metaFromFilename('C:/x/Frank Herbert - Dune.epub')).toMatchObject({ title: 'Dune', authors: ['Frank Herbert'] });
  });
});

describe('filename parsing: shadow-library layout and false series', () => {
  it('reads Título -- Autor -- Ano -- Editora -- ISBN -- md5 -- Anna’s Archive', () => {
    const m = metaFromFilename('O Carteiro -- David Brin -- 2014 -- Aleph -- 9788576572008 -- 0123456789abcdef0123456789abcdef -- Anna’s Archive.epub');
    expect(m).toMatchObject({ title: 'O Carteiro', authors: ['David Brin'], year: 2014, publisher: 'Aleph', isbn: '9788576572008' });
    expect(m.series).toBeUndefined();
    expect(m.seriesIndex).toBeUndefined();
  });

  it('copes with missing parts and several ISBNs', () => {
    const m = metaFromFilename('Duna -- Frank Herbert -- 8576572001, 9788576572008 -- Anna’s Archive.epub');
    expect(m).toMatchObject({ title: 'Duna', authors: ['Frank Herbert'], isbn: '8576572001' });
    expect(m.year).toBeUndefined();
  });

  it('never reads a bare number as a series index', () => {
    expect(splitSeriesFromTitle('Fahrenheit 451 - Ray Bradbury')).toEqual({ title: 'Fahrenheit 451 - Ray Bradbury' });
    expect(splitSeriesFromTitle('O Carteiro - 2014 - Aleph')).toEqual({ title: 'O Carteiro - 2014 - Aleph' });
    expect(metaFromFilename('Apollo 13 - Jim Lovell.epub').series).toBeUndefined();
  });

  it('still understands explicit markers and rejects year-sized indexes', () => {
    expect(splitSeriesFromTitle('Mistborn Book 2 - The Well of Ascension')).toEqual({ title: 'The Well of Ascension', series: 'Mistborn', seriesIndex: 2 });
    expect(splitSeriesFromTitle('Foo (Bar #3)')).toEqual({ title: 'Foo', series: 'Bar', seriesIndex: 3 });
    expect(splitSeriesFromTitle('Foo (Bar #2014)')).toEqual({ title: 'Foo (Bar #2014)' });
  });
});
