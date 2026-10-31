import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { partialMd5 } from '../server/util.ts';

let tmp: string;
let lib: string;
let kindle: string;
let remove: typeof import('../server/kindle/remove.ts');
let send: typeof import('../server/kindle/send.ts');
let importer: typeof import('../server/kindle/import.ts');
let db: typeof import('../server/db.ts').db;

const json = (r: { body: string }) => JSON.parse(r.body);

function makeKindle(name: string) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'documents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'system'));
  return root;
}

async function addBook(name: string, content: string): Promise<number> {
  const p = path.join(lib, name);
  fs.writeFileSync(p, content);
  const r = db
    .prepare('insert into books(path, filename, format, size, title, organized, hash, added_at) values(?,?,?,?,?,?,?,?)')
    .run(p, name, 'epub', content.length, name, 1, await partialMd5(p), Date.now());
  return Number(r.lastInsertRowid);
}
const flag = (id: number) => (db.prepare('select sent_to_kindle s from books where id = ?').get(id) as { s: number }).s;
const onKindle = (name: string) => path.join(kindle, 'documents', 'Livros', name);

const sidecar = (md5: string, title: string) =>
  `return {\n    ["doc_pages"] = 100,\n    ["doc_props"] = { ["title"] = "${title}" },\n    ["partial_md5_checksum"] = "${md5}",\n    ["percent_finished"] = 0.3,\n    ["summary"] = { ["status"] = "reading" },\n}`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-rm-'));
  lib = path.join(tmp, 'library');
  fs.mkdirSync(lib);
  kindle = makeKindle('kindle');
  remove = await import('../server/kindle/remove.ts');
  send = await import('../server/kindle/send.ts');
  importer = await import('../server/kindle/import.ts');
  db = (await import('../server/db.ts')).db;
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('remove a library book from the Kindle', () => {
  it('finds the Kindle copy by its content, even renamed or moved, and the preview deletes nothing', async () => {
    const id = await addBook('Autor - Achado.epub', 'conteudo do livro achado');
    await send.sendToKindle([id], kindle);
    fs.mkdirSync(path.join(kindle, 'documents', 'Outros'));
    fs.renameSync(onKindle('Autor - Achado.epub'), path.join(kindle, 'documents', 'Outros', 'Renomeado.epub'));

    const plan = await remove.planBookRemoval([id], kindle);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].targets).toEqual([path.join('documents', 'Outros', 'Renomeado.epub')]);
    expect(fs.existsSync(path.join(kindle, 'documents', 'Outros', 'Renomeado.epub'))).toBe(true);
    expect(flag(id)).toBe(1);
  });

  it('deletes only the Kindle copy: the library file stays and the book stops being "No Kindle"', async () => {
    const id = await addBook('Autor - Sai.epub', 'conteudo do livro que sai');
    await send.sendToKindle([id], kindle);
    expect(flag(id)).toBe(1);

    const r = await remove.removeBooksFromKindle([id], kindle);
    expect(r.deleted).toBe(1);
    expect(r.errors).toEqual([]);
    expect(fs.existsSync(onKindle('Autor - Sai.epub'))).toBe(false);
    expect(fs.readFileSync(path.join(lib, 'Autor - Sai.epub'), 'utf8')).toBe('conteudo do livro que sai');
    expect(flag(id)).toBe(0);
    const row = db.prepare('select missing, organized from books where id = ?').get(id) as { missing: number; organized: number };
    expect(row).toEqual({ missing: 0, organized: 1 });
  });

  it('leaves the notes and progress that KOReader keeps in the .sdr folder', async () => {
    const id = await addBook('Autor - Notas.epub', 'conteudo com notas');
    await send.sendToKindle([id], kindle);
    const sdr = path.join(kindle, 'documents', 'Livros', 'Autor - Notas.sdr');
    fs.mkdirSync(sdr);
    fs.writeFileSync(path.join(sdr, 'metadata.epub.lua'), sidecar('x', 'Notas'));

    await remove.removeBooksFromKindle([id], kindle);
    expect(fs.existsSync(onKindle('Autor - Notas.epub'))).toBe(false);
    expect(fs.existsSync(path.join(sdr, 'metadata.epub.lua'))).toBe(true);
  });

  it('removes every copy when the book is on the Kindle twice', async () => {
    const id = await addBook('Autor - Dois.epub', 'conteudo duplicado');
    await send.sendToKindle([id], kindle);
    fs.mkdirSync(path.join(kindle, 'documents', 'Backup'));
    fs.copyFileSync(onKindle('Autor - Dois.epub'), path.join(kindle, 'documents', 'Backup', 'Copia.epub'));

    const r = await remove.removeBooksFromKindle([id], kindle);
    expect(r.deleted).toBe(2);
    expect(fs.existsSync(onKindle('Autor - Dois.epub'))).toBe(false);
    expect(fs.existsSync(path.join(kindle, 'documents', 'Backup', 'Copia.epub'))).toBe(false);
    expect(flag(id)).toBe(0);
  });

  it('a book that is no longer on the Kindle only has its flag cleared', async () => {
    const id = await addBook('Autor - Ja Foi.epub', 'conteudo que ja foi');
    await send.sendToKindle([id], kindle);
    fs.rmSync(onKindle('Autor - Ja Foi.epub'));

    const r = await remove.removeBooksFromKindle([id], kindle);
    expect(r.deleted).toBe(0);
    expect(r.errors).toEqual([]);
    expect(r.items[0].targets).toEqual([]);
    expect(r.items[0].note).toMatch(/já não está/);
    expect(flag(id)).toBe(0);
  });

  it('never deletes a different file that only has the same name', async () => {
    const id = await addBook('Autor - Parecido.epub', 'a versao da biblioteca');
    db.prepare('update books set sent_to_kindle = 1 where id = ?').run(id);
    fs.mkdirSync(path.dirname(onKindle('x')), { recursive: true });
    fs.writeFileSync(onKindle('Autor - Parecido.epub'), 'outra versao, de outra pessoa');

    const r = await remove.removeBooksFromKindle([id], kindle);
    expect(r.deleted).toBe(0);
    expect(fs.readFileSync(onKindle('Autor - Parecido.epub'), 'utf8')).toBe('outra versao, de outra pessoa');
    expect(flag(id)).toBe(0);
  });

  it('deletes nothing when the library file is missing (there is no way to tell which file is the copy)', async () => {
    const id = await addBook('Autor - Sumiu.epub', 'conteudo sumido');
    await send.sendToKindle([id], kindle);
    fs.rmSync(path.join(lib, 'Autor - Sumiu.epub'));

    const r = await remove.removeBooksFromKindle([id], kindle);
    expect(r.deleted).toBe(0);
    expect(r.items[0].blocked).toBe(true);
    expect(r.items[0].note).toMatch(/biblioteca/);
    expect(fs.existsSync(onKindle('Autor - Sumiu.epub'))).toBe(true);
    expect(flag(id)).toBe(1);
  });

  it('ignores ids that are not books and refuses a drive that is not a Kindle', async () => {
    expect((await remove.planBookRemoval([987654], kindle)).items).toEqual([]);
    await expect(remove.planBookRemoval([1], lib)).rejects.toThrow(/Kindle/);
  });
});

describe('importing again after the removal', () => {
  it('the leftover sidecar and the statistics do not mark the book as "No Kindle" again', async () => {
    const k2 = makeKindle('kindle2');
    const id = await addBook('Autor - Volta.epub', 'conteudo que nao deve voltar');
    await send.sendToKindle([id], k2);
    const md5 = await partialMd5(path.join(lib, 'Autor - Volta.epub'));
    const sdr = path.join(k2, 'documents', 'Livros', 'Autor - Volta.sdr');
    fs.mkdirSync(sdr);
    fs.writeFileSync(path.join(sdr, 'metadata.epub.lua'), sidecar(md5, 'Autor - Volta.epub'));
    const sdir = path.join(k2, 'koreader', 'settings');
    fs.mkdirSync(sdir, { recursive: true });
    const s = new DatabaseSync(path.join(sdir, 'statistics.sqlite3'));
    s.exec(`create table book(id integer primary key, title text, authors text, notes integer, last_open integer, highlights integer, pages integer, series text, language text, md5 text, total_read_time integer, total_read_pages integer);
            create table page_stat_data(id_book integer, page integer, start_time integer, duration integer, total_pages integer);`);
    s.prepare('insert into book(id, title, authors, md5, last_open, pages, total_read_time, total_read_pages) values(1,?,?,?,?,?,?,?)').run('Autor - Volta.epub', '', md5, 1709600000, 100, 600, 5);
    s.close();

    db.prepare('update books set sent_to_kindle = 0 where id = ?').run(id);
    await importer.importFromKindle(k2);
    expect(flag(id)).toBe(1); // still on the Kindle: it is flagged

    await remove.removeBooksFromKindle([id], k2);
    expect(flag(id)).toBe(0);
    const again = await importer.importFromKindle(k2);
    expect(again.matched).toBe(1); // the leftover notes still belong to the book
    expect(flag(id)).toBe(0); // but the book is not on the Kindle
    expect((db.prepare('select read_time r from books where id = ?').get(id) as { r: number }).r).toBe(600);
  });

  it('a copy of the Kindle folders without documents/ keeps flagging, as before', async () => {
    const id = await addBook('Autor - Copia.epub', 'conteudo da copia de pastas');
    const md5 = await partialMd5(path.join(lib, 'Autor - Copia.epub'));
    const copy = path.join(tmp, 'only-koreader');
    const sdr = path.join(copy, 'koreader', 'docsettings', 'Autor - Copia.sdr');
    fs.mkdirSync(sdr, { recursive: true });
    fs.writeFileSync(path.join(sdr, 'metadata.epub.lua'), sidecar(md5, 'Autor - Copia.epub'));
    await importer.importFromKindle(copy);
    expect(flag(id)).toBe(1);
  });
});

describe('API', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    const { buildApp } = await import('../server/app.ts');
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app.close());

  it('preview lists what would go; removing needs an explicit confirmation', async () => {
    const id = await addBook('Autor - Api.epub', 'conteudo da api');
    await send.sendToKindle([id], kindle);

    const pv = await app.inject({ method: 'POST', url: '/api/kindle/books/remove-preview', payload: { bookIds: [id], path: kindle } });
    expect(pv.statusCode).toBe(200);
    expect(json(pv).items[0].targets).toEqual([path.join('documents', 'Livros', 'Autor - Api.epub')]);
    expect(fs.existsSync(onKindle('Autor - Api.epub'))).toBe(true);

    const no = await app.inject({ method: 'POST', url: '/api/kindle/books/remove', payload: { bookIds: [id], path: kindle } });
    expect(no.statusCode).toBe(400);
    expect(fs.existsSync(onKindle('Autor - Api.epub'))).toBe(true);
    expect(flag(id)).toBe(1);

    const ok = await app.inject({ method: 'POST', url: '/api/kindle/books/remove', payload: { bookIds: [id], path: kindle, confirm: true } });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).deleted).toBe(1);
    expect(fs.existsSync(onKindle('Autor - Api.epub'))).toBe(false);
    expect(flag(id)).toBe(0);
  });

  it('asks for at least one book', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/kindle/books/remove-preview', payload: { bookIds: [] } });
    expect(res.statusCode).toBe(400);
  });
});
