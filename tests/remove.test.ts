import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SAMPLE as BASE } from './lua.test.ts';

// own title/md5 so the book never pairs with one left in the shared test database by another test file
const SAMPLE = BASE.replace('The Final Empire', 'Livro Fantasma de Teste').replace('Brandon Sanderson', 'Autor Fantasma').replace('abc123', 'fantasma-md5-unico');
import { partialMd5 } from '../server/util.ts';

let app: FastifyInstance;
let tmp: string;
let db: typeof import('../server/db.ts').db;
let remove: typeof import('../server/kindle/remove.ts');
const json = (r: { body: string }) => JSON.parse(r.body);
const p = (...s: string[]) => path.join(tmp, ...s);
const exists = (...s: string[]) => fs.existsSync(p(...s));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-remove-'));
  fs.mkdirSync(p('system', 'keep.sdr'), { recursive: true });
  fs.mkdirSync(p('documents', 'Livros', 'Fantasma.sdr'), { recursive: true });
  fs.writeFileSync(p('documents', 'Livros', 'Fantasma.epub'), 'fantasma');
  fs.writeFileSync(p('documents', 'Livros', 'Fantasma.sdr', 'metadata.epub.lua'), SAMPLE);
  fs.writeFileSync(p('documents', 'Livros', 'Outro.epub'), 'outro');
  fs.writeFileSync(p('documents', 'Livros', 'SoStats.epub'), 'so stats book');
  db = (await import('../server/db.ts')).db;
  db.exec('delete from unmatched');
  remove = await import('../server/kindle/remove.ts');
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  db.exec('delete from unmatched');
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('delete unmatched items from the Kindle', () => {
  it('refuses to delete without confirmation and leaves the files alone', async () => {
    await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: tmp } });
    const [row] = json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }));
    const res = await app.inject({ method: 'POST', url: '/api/kindle/unmatched/remove', payload: { ids: [row.id] } });
    expect(res.statusCode).toBe(400);
    expect(exists('documents', 'Livros', 'Fantasma.epub')).toBe(true);
  });

  it('previews, then deletes the book and its .sdr, and nothing else', async () => {
    const [row] = json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }));
    const plan = json(await app.inject({ method: 'POST', url: '/api/kindle/unmatched/remove-preview', payload: { ids: [row.id] } }));
    expect(plan.items[0].targets.map((t: string) => t.split(path.sep).join('/')).sort()).toEqual(['documents/Livros/Fantasma.epub', 'documents/Livros/Fantasma.sdr']);
    expect(exists('documents', 'Livros', 'Fantasma.epub')).toBe(true);

    const res = json(await app.inject({ method: 'POST', url: '/api/kindle/unmatched/remove', payload: { ids: [row.id], confirm: true } }));
    expect(res.deleted).toBe(2);
    expect(exists('documents', 'Livros', 'Fantasma.epub')).toBe(false);
    expect(exists('documents', 'Livros', 'Fantasma.sdr')).toBe(false);
    expect(exists('documents', 'Livros', 'Outro.epub')).toBe(true);
    expect(json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }))).toHaveLength(0);
  });

  it('finds a stats-only book by its md5, deletes it, and hides the row so a sync does not list it again', async () => {
    const md5 = await partialMd5(p('documents', 'Livros', 'SoStats.epub'));
    const id = Number(db.prepare("insert into unmatched(title, authors, md5, sdr_path, payload, imported_at) values('SoStats','', ?, null, '{}', 0)").run(md5).lastInsertRowid);
    const res = await remove.removeFromKindle([id], tmp);
    expect(res.deleted).toBe(1);
    expect(exists('documents', 'Livros', 'SoStats.epub')).toBe(false);
    expect((db.prepare('select ignored i from unmatched where id = ?').get(id) as { i: number }).i).toBe(1);
  });

  it('never touches anything outside documents/ and the KOReader sidecar folders', async () => {
    const id = Number(db.prepare("insert into unmatched(title, authors, md5, sdr_path, payload, imported_at) values('Sistema','', null, ?, '{}', 0)").run(p('system', 'keep.sdr')).lastInsertRowid);
    const plan = await remove.planRemoval([id], tmp);
    expect(plan.items[0].targets).toEqual([]);
    await remove.removeFromKindle([id], tmp);
    expect(exists('system', 'keep.sdr')).toBe(true);
  });

  it('refuses a drive that is not a Kindle', async () => {
    await expect(remove.planRemoval([1], os.tmpdir())).rejects.toThrow(/Kindle/);
  });
});
