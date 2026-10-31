import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyseFrontMatter, detectLanguage, htmlToText } from '../server/formats/frontmatter.ts';
import { readMeta } from '../server/formats/index.ts';
import { searchBrasilApi } from '../server/metadata/providers.ts';
import { makeEpub } from './helpers.ts';

const COPYRIGHT = `<p>Copyright © 2014 by Isaac Asimov</p><p>Título original: I, Robot</p><p>Editora Aleph Ltda.</p><p>ISBN 978-85-7657-200-8</p>`;
const SYNOPSIS = `<h2>Sinopse</h2><p>Nove contos que acompanham a evolução dos robôs, das primeiras máquinas mudas aos cérebros positrônicos capazes de governar a economia mundial.</p><p>Cada história testa as Três Leis da Robótica.</p>`;
const PROSE = '<p>' + 'O robô não podia fazer mal a um ser humano, e ele sabia que para isso não havia nada que pudesse fazer com a máquina em que estava. '.repeat(30) + '</p>';

describe('front matter analysis', () => {
  it('turns XHTML into one line per block', () => {
    expect(htmlToText('<h1>A</h1><p>b &amp; c</p>')).toBe('A\nb & c');
  });

  it('finds ISBN, year, publisher and synopsis in a Portuguese copyright page', () => {
    const fm = analyseFrontMatter([htmlToText(COPYRIGHT), htmlToText(SYNOPSIS)]);
    expect(fm.isbn).toBe('9788576572008');
    expect(fm.year).toBe(2014);
    expect(fm.publisher).toBe('Editora Aleph'); // legal suffix dropped
    expect(fm.synopsis).toMatch(/^Nove contos/);
  });

  it('does not invent anything from a page that has none of it', () => {
    expect(analyseFrontMatter([htmlToText('<p>Capítulo 1</p><p>Era uma vez.</p>')])).toEqual({ language: undefined });
  });

  it('detects the language of the prose', () => {
    expect(detectLanguage(htmlToText(PROSE))).toBe('pt');
    expect(detectLanguage('The cat sat on the mat and the dog was with her. '.repeat(40))).toBe('en');
    expect(detectLanguage('curto')).toBeUndefined();
  });
});

describe('readMeta uses the text of the book for what the OPF lacks', () => {
  it('fills isbn, year, publisher, language and synopsis, labelled as coming from the book', async () => {
    const buf = await makeEpub({ title: 'Eu, Robô', authors: ['Isaac Asimov'], language: '', pages: [COPYRIGHT, SYNOPSIS, PROSE] });
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-fm-')), 'Isaac Asimov - Eu, Robô.epub');
    fs.writeFileSync(f, buf);
    const { meta, sources } = await readMeta(f);
    expect(meta).toMatchObject({ isbn: '9788576572008', year: 2014, publisher: 'Editora Aleph', language: 'pt' });
    expect(meta.description).toMatch(/^Nove contos/);
    expect(sources).toMatchObject({ isbn: 'livro', year: 'livro', publisher: 'livro', language: 'livro', description: 'livro', title: 'embedded' });
  });

  it('never overrides what the OPF already says', async () => {
    const buf = await makeEpub({ title: 'X', authors: ['Y'], publisher: 'Editora Certa', year: 2001, pages: [COPYRIGHT] });
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-fm-')), 'x.epub');
    fs.writeFileSync(f, buf);
    const { meta, sources } = await readMeta(f);
    expect(meta.publisher).toBe('Editora Certa');
    expect(meta.year).toBe(2001);
    expect(sources.publisher).toBe('embedded');
  });
});

describe('BrasilAPI', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps the registry record and keeps only the first (main) author', async () => {
    vi.stubGlobal('fetch', async () =>
      Response.json({ isbn: '9788535914849', title: '1984', authors: ['George Orwell', 'Alexandre Hubner', 'Heloisa Jahn'], publisher: 'Companhia das Letras', year: 2009, synopsis: 'Distopia.', page_count: 416, subjects: ['Literatura', 'Literatura'] }),
    );
    const [c] = await searchBrasilApi('9788535914849');
    expect(c.source).toBe('brasilapi');
    expect(c.meta).toMatchObject({ title: '1984', authors: ['George Orwell'], publisher: 'Companhia das Letras', year: 2009, pages: 416, description: 'Distopia.' });
    expect(c.meta.tags).toEqual(['Literatura']);
  });

  it('returns nothing for an unknown ISBN or without ISBN', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    expect(await searchBrasilApi('9780000000000')).toEqual([]);
    expect(await searchBrasilApi(undefined)).toEqual([]);
  });
});
