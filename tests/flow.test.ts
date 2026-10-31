import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { makeEpub } from './helpers.ts';
import { readEpub } from '../server/formats/epub.ts';
import { partialMd5 } from '../server/util.ts';

let app: FastifyInstance;
let tmp: string;
let booksDir: string;
let bookId: number;
let committedPath: string;
let kindleDir: string;

const json = (r: { body: string }) => JSON.parse(r.body);

function multipart(name: string, data: Buffer) {
  const boundary = '----bookflixtest';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/epub+zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, data, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-flow-'));
  booksDir = path.join(tmp, 'Livros');
  fs.mkdirSync(booksDir);
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ingest -> library', () => {
  it('refuses to save before the Livros folder is configured', async () => {
    const original = await makeEpub({ title: 'Probe', authors: ['X'] });
    const m = multipart('probe.epub', original);
    const up = json(await app.inject({ method: 'POST', url: '/api/ingest/upload', ...m }));
    const res = await app.inject({ method: 'POST', url: `/api/ingest/${up[0].id}/preview`, payload: { meta: { title: 'Probe', authors: ['X'] } } });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/pasta Livros/);
    await app.inject({ method: 'DELETE', url: `/api/ingest/${up[0].id}` });
  });

  it('saves settings', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { booksDir, yearlyGoal: 12 } });
    expect(res.statusCode).toBe(200);
    expect(json(res).booksDir).toBe(booksDir);
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { booksDir: path.join(tmp, 'nope') } });
    expect(bad.statusCode).toBe(400);
  });

  it('uploads, previews and commits a book', async () => {
    const original = await makeEpub({ title: 'the final empire (Mistborn, #1)', authors: [], cover: false });
    const up = json(await app.inject({ method: 'POST', url: '/api/ingest/upload', ...multipart('Sanderson - empire.epub', original) }));
    expect(up).toHaveLength(1);
    const id = up[0].id;

    const meta = {
      title: 'The Final Empire', subtitle: 'Mistborn Book One', authors: ['Brandon Sanderson'], series: 'Mistborn', seriesIndex: 1,
      publisher: 'Tor Books', year: 2006, description: 'Um ladrão e um império.', tags: ['Fantasy', 'Epic'], language: 'en',
    };
    const pv = json(await app.inject({ method: 'POST', url: `/api/ingest/${id}/preview`, payload: { meta } }));
    expect(pv.fileName).toBe('Brandon Sanderson - The Final Empire.epub');
    expect(pv.relPath.split(/[\\/]/)).toEqual(['Brandon Sanderson', 'Mistborn', 'Brandon Sanderson - The Final Empire.epub']);
    expect(pv.duplicates).toHaveLength(0);

    const res = await app.inject({ method: 'POST', url: `/api/ingest/${id}/commit`, payload: { meta, sources: { title: 'manual', series: 'gerado' } } });
    expect(res.statusCode).toBe(200);
    const book = json(res);
    bookId = book.id;
    committedPath = book.path;
    expect(fs.existsSync(committedPath)).toBe(true);
    expect(committedPath).toBe(path.join(booksDir, pv.relPath));
    expect(book.organized).toBe(1);
    expect(book.series).toBe('Mistborn');

    const written = await readEpub(fs.readFileSync(committedPath));
    expect(written.meta).toMatchObject({ title: 'The Final Empire: Mistborn Book One', series: 'Mistborn', seriesIndex: 1, publisher: 'Tor Books', year: 2006 });
    expect(json(await app.inject({ method: 'GET', url: '/api/ingest' }))).toHaveLength(0);
  });

  it('warns about duplicates and requires force', async () => {
    const dup = await makeEpub({ title: 'The Final Empire', authors: ['Brandon Sanderson'] });
    const up = json(await app.inject({ method: 'POST', url: '/api/ingest/upload', ...multipart('dup.epub', dup) }));
    const meta = { title: 'The Final Empire', authors: ['Brandon Sanderson'], tags: [] };
    const pv = json(await app.inject({ method: 'POST', url: `/api/ingest/${up[0].id}/preview`, payload: { meta } }));
    expect(pv.duplicates).toHaveLength(1);
    const res = await app.inject({ method: 'POST', url: `/api/ingest/${up[0].id}/commit`, payload: { meta } });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('DUPLICATE');
    await app.inject({ method: 'DELETE', url: `/api/ingest/${up[0].id}` });
  });

  it('undo removes the generated file and the book', async () => {
    const extra = await makeEpub({ title: 'Temp', authors: ['Temp Author'] });
    const up = json(await app.inject({ method: 'POST', url: '/api/ingest/upload', ...multipart('t.epub', extra) }));
    const meta = { title: 'Temp', authors: ['Temp Author'], tags: [] };
    const book = json(await app.inject({ method: 'POST', url: `/api/ingest/${up[0].id}/commit`, payload: { meta } }));
    expect(fs.existsSync(book.path)).toBe(true);
    const hist = json(await app.inject({ method: 'GET', url: '/api/history' }));
    const entry = hist.find((h: any) => h.book_id === book.id);
    expect((await app.inject({ method: 'POST', url: `/api/history/${entry.id}/undo` })).statusCode).toBe(200);
    expect(fs.existsSync(book.path)).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/books/${book.id}` })).statusCode).toBe(404);
  });
});

describe('Kindle import', () => {
  beforeAll(async () => {
    kindleDir = path.join(tmp, 'kindle');
    const docs = path.join(kindleDir, 'documents');
    fs.mkdirSync(docs, { recursive: true });
    const onKindle = path.join(docs, path.basename(committedPath));
    fs.copyFileSync(committedPath, onKindle);
    const md5 = await partialMd5(onKindle);
    const { SAMPLE } = await import('./lua.test.ts');
    fs.mkdirSync(`${onKindle.replace(/\.epub$/, '')}.epub.sdr`, { recursive: true });
    fs.writeFileSync(path.join(`${onKindle}.sdr`, 'metadata.epub.lua'), SAMPLE.replace('abc123', md5).replace('"title"] = "The Final Empire"', '"title"] = "The Final Empire"'));

    // statistics.sqlite3
    const sdir = path.join(kindleDir, 'koreader', 'settings');
    fs.mkdirSync(sdir, { recursive: true });
    const s = new DatabaseSync(path.join(sdir, 'statistics.sqlite3'));
    s.exec(`create table book(id integer primary key, title text, authors text, notes integer, last_open integer, highlights integer, pages integer, series text, language text, md5 text, total_read_time integer, total_read_pages integer);
            create table page_stat_data(id_book integer, page integer, start_time integer, duration integer, total_pages integer);`);
    s.prepare('insert into book(id, title, authors, md5, last_open, pages, total_read_time, total_read_pages) values(1,?,?,?,?,?,?,?)').run('The Final Empire', 'Brandon Sanderson', md5, 1709600000, 300, 5400, 40);
    const ins = s.prepare('insert into page_stat_data values(1, ?, ?, ?, 300)');
    const base = Math.floor(new Date('2024-03-01T20:00:00').getTime() / 1000);
    for (let i = 0; i < 20; i++) ins.run(i + 1, base + i * 60, 90); // day 1: 20 pages, 30 min
    for (let i = 0; i < 20; i++) ins.run(i + 21, base + 86400 + i * 60, 90); // day 2
    s.close();
  });

  it('imports progress, review, highlights and reading days', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: kindleDir } });
    expect(res.statusCode).toBe(200);
    const sum = json(res);
    expect(sum).toMatchObject({ sidecars: 1, matched: 1, unmatched: 0, highlights: 2, statsBooks: 1, readingDays: 2 });

    const b = json(await app.inject({ method: 'GET', url: `/api/books/${bookId}` }));
    expect(b.status).toBe('reading');
    expect(b.progress).toBeCloseTo(0.42);
    expect(b.rating).toBe(5);
    expect(b.review).toBe('Ótimo livro');
    expect(b.sent_to_kindle).toBe(1);
    expect(b.read_time).toBe(5400);
    expect(b.highlights).toHaveLength(2);
    expect(b.days).toHaveLength(2);
  });

  it('reimport is idempotent and keeps user edits', async () => {
    let b = json(await app.inject({ method: 'GET', url: `/api/books/${bookId}` }));
    const h = b.highlights.find((x: any) => x.note === 'Minha nota');
    await app.inject({ method: 'PATCH', url: `/api/highlights/${h.id}`, payload: { text: h.text, note: 'Nota editada por mim' } });
    const gone = b.highlights.find((x: any) => x.note === null);
    await app.inject({ method: 'DELETE', url: `/api/highlights/${gone.id}` });
    await app.inject({ method: 'PATCH', url: `/api/books/${bookId}`, payload: { rating: 4, review: 'Revisei minha opinião' } });

    await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: kindleDir } });
    b = json(await app.inject({ method: 'GET', url: `/api/books/${bookId}` }));
    expect(b.highlights).toHaveLength(1);
    expect(b.highlights[0].note).toBe('Nota editada por mim');
    expect(b.rating).toBe(4);
    expect(b.review).toBe('Revisei minha opinião');
    expect(b.progress).toBeCloseTo(0.42);
  });

  it('puts books it cannot match into the unmatched queue', async () => {
    const docs = path.join(kindleDir, 'documents');
    fs.mkdirSync(path.join(docs, 'Livro Fantasma.epub.sdr'), { recursive: true });
    fs.writeFileSync(path.join(docs, 'Livro Fantasma.epub.sdr', 'metadata.epub.lua'), 'return { ["doc_props"] = { ["title"] = "Livro Fantasma" }, ["percent_finished"] = 0.2 }');
    const sum = json(await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: kindleDir } }));
    expect(sum.unmatched).toBe(1);
    const list = json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }));
    expect(list[0].title).toBe('Livro Fantasma');
  });

  it('warns before reorganizing a book already on the Kindle', async () => {
    const st = json(await app.inject({ method: 'POST', url: `/api/ingest/from-library/${bookId}` }));
    const meta = { title: 'The Final Empire', authors: ['Brandon Sanderson'], series: 'Mistborn', seriesIndex: 1, tags: [] };
    const pv = json(await app.inject({ method: 'POST', url: `/api/ingest/${st.id}/preview`, payload: { meta } }));
    expect(pv.sentToKindle).toBe(true);
    const res = await app.inject({ method: 'POST', url: `/api/ingest/${st.id}/commit`, payload: { meta } });
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('KINDLE_SENT');
    await app.inject({ method: 'DELETE', url: `/api/ingest/${st.id}` });
    expect(fs.existsSync(committedPath)).toBe(true);
  });
});

describe('search, filters, home and dashboard', () => {
  it('finds books by accent-free prefixes of metadata and notes', async () => {
    const q = async (s: string) => json(await app.inject({ method: 'GET', url: `/api/books?${s}` }));
    expect((await q('q=sande')).total).toBe(1);
    expect((await q('q=ladrao imp')).total).toBe(1); // description, no accents
    expect((await q('q=editada')).total).toBe(1); // text of my own note
    expect((await q('q=zzzz')).total).toBe(0);
  });

  it('combines filters', async () => {
    const q = async (s: string) => json(await app.inject({ method: 'GET', url: `/api/books?${s}` }));
    expect((await q('status=reading&series=Mistborn&tags=Fantasy&hasNotes=1&format=epub&year=2006&sent=1&complete=1')).total).toBe(1);
    expect((await q('status=read')).total).toBe(0);
    expect((await q('author=Brandon%20Sanderson&rating=5')).total).toBe(0);
    expect((await q('rating=4&progressMin=0.4&progressMax=0.5')).total).toBe(1);
    expect((await q('tags=Fantasy,Nope')).total).toBe(0);
  });

  it('exposes facets, home rows and exports', async () => {
    const f = json(await app.inject({ method: 'GET', url: '/api/facets' }));
    expect(f.series[0]).toMatchObject({ value: 'Mistborn', count: 1 });
    const home = json(await app.inject({ method: 'GET', url: '/api/home' }));
    expect(home.rows.find((r: any) => r.id === 'continue').items[0].id).toBe(bookId);
    const md = await app.inject({ method: 'GET', url: `/api/books/${bookId}/export.md` });
    expect(md.body).toContain('Nota editada por mim');
  });

  it('computes the dashboard', async () => {
    const d = json(await app.inject({ method: 'GET', url: '/api/dashboard?year=2024' }));
    expect(d.totals.books).toBe(1);
    expect(d.totals.pages).toBe(40);
    expect(d.totals.hours).toBeCloseTo(1, 0);
    expect(d.months[2].pages).toBe(40);
    expect(d.goal.target).toBe(12);
  });
});
