import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let tmp: string;
let booksDir: string;
let db: typeof import('../server/db.ts').db;
let settings: typeof import('../server/settings.ts');

const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
  const res = await app.inject({ method, url, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) };
};
const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-syncsvc-'));
  booksDir = path.join(tmp, 'Livros');
  fs.mkdirSync(booksDir);
  db = (await import('../server/db.ts')).db;
  settings = await import('../server/settings.ts');
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp();
  await app.ready();
  db.exec('delete from books');
  db.prepare("delete from settings where key in ('syncLibraryId','syncLastHash','booksDir')").run();
});

afterAll(async () => {
  await app.close();
  db.prepare("delete from settings where key in ('syncLibraryId','syncLastHash')").run();
  settings.updateSettings({ booksDir: '' });
  db.exec('delete from books');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sync API', () => {
  it('needs a library folder first', async () => {
    const r = await call('POST', '/api/sync/enable', { mode: 'create' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/pasta/i);
    expect((await call('GET', '/api/sync')).body.enabled).toBe(false);
  });

  it('creates a library with a unique ID inside .bookflix-sync and reports it', async () => {
    settings.updateSettings({ booksDir });
    const before = (await call('GET', '/api/sync')).body;
    expect(before).toMatchObject({ enabled: false, foundInFolder: null });

    const made = await call('POST', '/api/sync/enable', { mode: 'create' });
    expect(made.status).toBe(200);
    expect(made.body.libraryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(fs.readFileSync(path.join(booksDir, '.bookflix-sync', 'library.json'), 'utf8')).id).toBe(made.body.libraryId);

    const after = (await call('GET', '/api/sync')).body;
    expect(after).toMatchObject({ enabled: true, libraryId: made.body.libraryId, foundInFolder: made.body.libraryId });
    expect(after.deviceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('syncs now and writes this device\'s file', async () => {
    const r = await call('POST', '/api/sync/now');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: 0, warnings: [] });
    const files = fs.readdirSync(path.join(booksDir, '.bookflix-sync', 'devices'));
    expect(files).toHaveLength(1);
    expect((await call('GET', '/api/sync')).body.lastSync).toBeTruthy();
  });

  it('will not start a second library over an existing one', async () => {
    const r = await call('POST', '/api/sync/enable', { mode: 'create' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('LIBRARY_EXISTS');
  });

  it('a folder of another library is refused until the person explicitly joins it', async () => {
    fs.writeFileSync(path.join(booksDir, '.bookflix-sync', 'library.json'), JSON.stringify({ id: 'outra-biblioteca', createdAt: 1 }));
    const status = (await call('GET', '/api/sync')).body;
    expect(status).toMatchObject({ enabled: true, mismatch: true, foundInFolder: 'outra-biblioteca' });
    const refused = await call('POST', '/api/sync/now');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('LIBRARY_MISMATCH');
    const joined = await call('POST', '/api/sync/enable', { mode: 'join' });
    expect(joined.status).toBe(200);
    expect(joined.body.libraryId).toBe('outra-biblioteca');
    expect((await call('POST', '/api/sync/now')).status).toBe(200);
  });

  it('disabling stops syncing and leaves the files alone', async () => {
    const r = await call('POST', '/api/sync/disable');
    expect(r.status).toBe(200);
    expect((await call('GET', '/api/sync')).body.enabled).toBe(false);
    expect(fs.existsSync(path.join(booksDir, '.bookflix-sync', 'library.json'))).toBe(true);
    expect((await call('POST', '/api/sync/now')).status).toBe(409);
  });

  it('the scanner never mistakes the sync folder for books', async () => {
    fs.writeFileSync(path.join(booksDir, '.bookflix-sync', 'devices', 'fake.epub'), 'x');
    const { scanLibrary } = await import('../server/library.ts');
    expect((await scanLibrary()).added).toBe(0);
  });
});

describe('highlight identity across devices', () => {
  it('the Kindle import derives the highlight id from the file hash, not from the local book id', async () => {
    const { highlightUid } = await import('../server/kindle/import.ts');
    expect(highlightUid({ id: 7, hash: 'abc' }, '2026-01-01 10:00:00', 'texto')).toBe(sha1('abc|2026-01-01 10:00:00|texto'));
    expect(highlightUid({ id: 99, hash: 'abc' }, '2026-01-01 10:00:00', 'texto')).toBe(highlightUid({ id: 7, hash: 'abc' }, '2026-01-01 10:00:00', 'texto'));
    expect(highlightUid({ id: 7, hash: null }, 'd', 't')).toBe(sha1('7|d|t')); // no hash yet: the old scheme
  });

  it('migrates old ids once, keeps edited-text rows, and leaves user highlights alone', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { initSchema, migrateHighlightUids } = await import('../server/db.ts');
    const d = new DatabaseSync(':memory:');
    initSchema(d);
    d.prepare("insert into books(id, path, hash, authors) values(7, '/a.epub', 'h7', 'x')").run();
    const ins = d.prepare("insert into highlights(book_id, uid, text, created_at, source) values(7,?,?,?,?)");
    ins.run(sha1('7|2026-01-01|um trecho'), 'um trecho', '2026-01-01', 'kindle'); // old scheme, text untouched
    ins.run(sha1('7|2026-01-02|original'), 'texto que eu editei', '2026-01-02', 'kindle'); // text edited: old id cannot be rebuilt
    ins.run('uuid-do-usuario', 'minha nota', '2026-01-03', 'user');

    expect(migrateHighlightUids(d)).toBe(1);
    const uids = (d.prepare('select uid from highlights order by created_at').all() as { uid: string }[]).map((r) => r.uid);
    expect(uids).toEqual([sha1('h7|2026-01-01|um trecho'), sha1('7|2026-01-02|original'), 'uuid-do-usuario']);
    expect(migrateHighlightUids(d)).toBe(0); // idempotent
  });

  it('deleting any highlight hides it instead of erasing it, so the deletion can sync', async () => {
    db.exec('delete from books');
    const b = Number(db.prepare("insert into books(path, hash, authors, title) values('/h.epub','hh','x','H')").run().lastInsertRowid);
    const created = await call('POST', `/api/books/${b}/highlights`, { text: 'minha anotação', note: 'n' });
    expect(created.status).toBe(200);
    expect((await call('POST', `/api/books/${b}/highlights`, { text: 'outra' })).status).toBe(200);
    const id = created.body.id;
    const del = await app.inject({ method: 'DELETE', url: `/api/highlights/${id}` });
    expect(del.statusCode).toBe(200);
    expect(db.prepare('select deleted from highlights where id = ?').get(id)).toEqual({ deleted: 1 });
    const detail = await call('GET', `/api/books/${b}`);
    expect(detail.body.highlights).toHaveLength(1);
  });
});
