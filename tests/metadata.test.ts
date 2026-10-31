import { describe, expect, it } from 'vitest';
import { mergeCandidates } from '../server/metadata/index.ts';
import { cleanTags, parseOlSeries } from '../server/metadata/providers.ts';
import { similarity } from '../server/util.ts';

describe('title similarity', () => {
  it('accepts the same book with a subtitle and rejects omnibus editions', () => {
    expect(similarity('The Final Empire', 'The Final Empire: Mistborn Book One')).toBeGreaterThanOrEqual(0.6);
    expect(similarity('I, Robot', 'I, Robot')).toBe(1);
    expect(similarity('I, Robot', 'Works (Foundation / Foundation and Empire / I, Robot / Naked Sun / Second Foundation)')).toBeLessThan(0.6);
    // a sequel can pass the threshold, so providers rank by closeness: the exact title must outscore it
    expect(similarity('Dune', 'Dune Messiah')).toBeLessThan(similarity('Dune', 'Dune'));
  });
});

describe('metadata cascade merge', () => {
  const embedded = { source: 'embedded' as const, meta: { title: 'duna', authors: ['F. Herbert'], tags: ['SciFi'], series: 'Duna', seriesIndex: 1 } };
  const google = { source: 'google' as const, meta: { title: 'Duna', authors: ['Frank Herbert'], publisher: 'Aleph', year: 2017, description: 'Sinopse', tags: ['Ficção'] }, coverUrl: 'https://x/c.jpg' };
  const ol = { source: 'openlibrary' as const, meta: { title: 'Dune', authors: ['Frank Herbert'], publisher: 'Ace', year: 1990, series: 'Dune Chronicles', seriesIndex: 1, tags: ['Space'] } };

  it('takes each field from the highest-priority source that has it', () => {
    const m = mergeCandidates([embedded, google, ol]);
    expect(m.title).toEqual({ value: 'Duna', source: 'google' });
    expect(m.publisher).toEqual({ value: 'Aleph', source: 'google' }); // edition-specific data prefers Google
    expect(m.year).toEqual({ value: 2017, source: 'google' });
    expect(m.series).toEqual({ value: 'Duna', source: 'embedded' }); // what the file already says wins
    expect(m.seriesIndex).toEqual({ value: 1, source: 'embedded' });
    expect(m.description?.source).toBe('google');
    expect(m.cover?.value).toBe('https://x/c.jpg');
  });

  it('falls back to Open Library when Google has nothing', () => {
    const m = mergeCandidates([embedded, ol]);
    expect(m.publisher).toEqual({ value: 'Ace', source: 'openlibrary' });
  });

  it('uses Open Library series when the file has none', () => {
    const m = mergeCandidates([{ source: 'embedded', meta: { title: 'x', authors: [], tags: [] } }, ol]);
    expect(m.series).toEqual({ value: 'Dune Chronicles', source: 'openlibrary' });
  });

  it('never auto-merges a result found only in another language', () => {
    const foreign = { ...ol, crossLanguage: true };
    const m = mergeCandidates([embedded, foreign]);
    expect(m.publisher).toBeUndefined();
    expect(m.year).toBeUndefined();
    expect(m.title?.source).toBe('embedded');
    expect(m.authors?.value).toEqual(['Frank Herbert']); // names do not depend on language, so they are still used
  });

  it('takes Open Library tags only when nobody else has any', () => {
    expect(mergeCandidates([embedded, google, ol]).tags?.value).toEqual(['SciFi', 'Ficção']);
    expect(mergeCandidates([{ source: 'embedded', meta: { authors: [], tags: [] } }, ol]).tags?.value).toEqual(['Space']);
  });

  it('keeps embedded values when no site answered', () => {
    const m = mergeCandidates([embedded]);
    expect(m.title).toEqual({ value: 'duna', source: 'embedded' });
    expect(m.series?.source).toBe('embedded');
    expect(m.publisher).toBeUndefined();
  });

  it('merges tags without duplicates and caps them', () => {
    const tags = cleanTags(['Fiction / Science Fiction', 'science fiction', 'a'.repeat(40), 'Reading Level-Grade 9', 'NYT bestseller']);
    expect(tags).toEqual(['Fiction', 'Science Fiction']);
  });
});

describe('Open Library series strings', () => {
  it('parses name and number', () => {
    expect(parseOlSeries('Mistborn, #1')).toEqual({ series: 'Mistborn', seriesIndex: 1 });
    expect(parseOlSeries('The Stormlight Archive ; 2')).toEqual({ series: 'The Stormlight Archive', seriesIndex: 2 });
    expect(parseOlSeries('Discworld (Book 4)')).toEqual({ series: 'Discworld', seriesIndex: 4 });
    expect(parseOlSeries('Standalone Saga')).toEqual({ series: 'Standalone Saga', seriesIndex: undefined });
  });

  it('never reads a year as the book order', () => {
    expect(parseOlSeries('Oscar Moderni 2014').seriesIndex).toBeUndefined();
    expect(parseOlSeries('Collection, 1999').seriesIndex).toBeUndefined();
  });
});

describe('lookup with every site unavailable', () => {
  it('still produces clean, created values and explains the Google quota', async () => {
    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 429 }));
    try {
      const { lookupMetadata } = await import('../server/metadata/index.ts');
      const meta = { title: 'o hobbit (Terra Média, #1)', authors: [], tags: [] };
      const r = await lookupMetadata({ title: meta.title }, { meta, sources: { title: 'embedded' } });
      expect(r.merged.title).toEqual({ value: 'o hobbit', source: 'embedded' });
      expect(r.merged.series).toMatchObject({ value: 'Terra Média', source: 'gerado' });
      expect(r.merged.seriesIndex).toMatchObject({ value: 1 });
      expect(r.merged.description?.source).toBe('gerado');
      expect(r.warnings[0]).toMatch(/Google Books/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Google Books error classification', () => {
  it('tells a spent quota, a bad key and a disabled API apart', async () => {
    const { classifyGoogle, testGoogleKey } = await import('../server/metadata/providers.ts');
    expect(classifyGoogle({ status: 200 })).toBe('ok');
    expect(classifyGoogle({ status: 429, error: { errors: [{ reason: 'rateLimitExceeded' }] } })).toBe('quota');
    expect(classifyGoogle({ status: 400, error: { message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }], details: [{ reason: 'API_KEY_INVALID' }] } })).toBe('chave-invalida');
    expect(classifyGoogle({ status: 403, error: { details: [{ reason: 'SERVICE_DISABLED' }] } })).toBe('api-desativada');
    expect(classifyGoogle({ status: 0 })).toBe('offline');
    expect(classifyGoogle({ status: 500 })).toBe('erro 500');

    const { vi } = await import('vitest');
    vi.stubGlobal('fetch', async () => Response.json({ error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }, { status: 400 }));
    try {
      const r = await testGoogleKey('ruim');
      expect(r).toMatchObject({ ok: false, status: 'chave-invalida' });
      expect(r.message).toMatch(/não é válida/);
      vi.stubGlobal('fetch', async () => Response.json({ items: [{ volumeInfo: { title: 'I, Robot' } }] }));
      expect(await testGoogleKey('boa')).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Google results in another language than the file', () => {
  it('are kept as alternatives, with a real ISBN only', async () => {
    const { vi } = await import('vitest');
    const { searchGoogle } = await import('../server/metadata/providers.ts');
    vi.stubGlobal('fetch', async () =>
      Response.json({
        items: [
          { id: 'a', volumeInfo: { title: 'The Postman', authors: ['David Brin'], publisher: 'Bantam', publishedDate: '1986', language: 'en', industryIdentifiers: [{ type: 'OTHER', identifier: 'UOM:49015000014390' }] } },
          { id: 'b', volumeInfo: { title: 'The Postman', authors: ['David Brin'], language: 'en', industryIdentifiers: [{ type: 'ISBN_10', identifier: '0553274333' }, { type: 'ISBN_13', identifier: '9780553274332' }] } },
        ],
      }),
    );
    try {
      const r = await searchGoogle({ title: 'The Postman', authors: ['David Brin'], language: 'pt-BR' });
      expect(r.every((c) => c.crossLanguage)).toBe(true);
      const isbns = r.map((c) => c.meta.isbn);
      expect(isbns).toContain('9780553274332');
      expect(isbns.filter(Boolean)).toEqual(['9780553274332']); // the UOM:... record id is dropped
      expect((await searchGoogle({ title: 'The Postman', language: 'en' })).every((c) => !c.crossLanguage)).toBe(true);
      expect((await searchGoogle({ title: 'The Postman' })).every((c) => !c.crossLanguage)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('the "O Carteiro" case: Portuguese file, Google answers with the American edition', () => {
  it('keeps the file’s own data and invents no series', async () => {
    const { vi } = await import('vitest');
    const { lookupMetadata } = await import('../server/metadata/index.ts');
    const { metaFromFilename } = await import('../server/formats/filename.ts');
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('googleapis.com'))
        return Response.json({
          items: [{ id: 'a', volumeInfo: { title: 'The Postman', authors: ['David Brin'], publisher: 'Bantam', publishedDate: '1986', language: 'en', description: 'He was a survivor', industryIdentifiers: [{ type: 'OTHER', identifier: 'UOM:49015000014390' }] } }],
        });
      return new Response('{}', { status: 404 });
    });
    try {
      const meta = { ...metaFromFilename('O Carteiro -- David Brin -- 2014 -- Aleph -- 9788576572008 -- Anna’s Archive.epub'), language: 'pt-BR' };
      const sources = Object.fromEntries(Object.keys(meta).map((k) => [k, 'filename']));
      const r = await lookupMetadata({ title: meta.title, authors: meta.authors }, { meta, sources });
      const v = (k: string) => (r.merged as any)[k]?.value;
      expect(v('title')).toBe('O Carteiro');
      expect(v('publisher')).toBe('Aleph');
      expect(v('year')).toBe(2014);
      expect(v('isbn')).toBe('9788576572008');
      expect(v('series')).toBeUndefined();
      expect(v('seriesIndex')).toBeUndefined();
      expect(r.candidates.find((c) => c.source === 'google')?.crossLanguage).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
