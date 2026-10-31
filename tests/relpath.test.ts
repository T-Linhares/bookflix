import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let oldRoot: string;
let newRoot: string;
let db: typeof import('../server/db.ts').db;
let relpath: typeof import('../server/relpath.ts');
let lib: typeof import('../server/library.ts');
let settings: typeof import('../server/settings.ts');

const FILES = ['Autor/Serie/Autor - Um.epub', 'Autor/Autor - Dois.epub', 'Outro/Outro - Tres.epub'];

function addRow(file: string, content: string): number {
  const r = db
    .prepare('insert into books(path, filename, format, size, hash, title, added_at) values(?,?,?,?,?,?,?)')
    .run(file, path.basename(file), 'epub', content.length, `hash-${content}`, content, Date.now());
  return Number(r.lastInsertRowid);
}
const row = (id: number) => db.prepare('select path, rel_path from books where id = ?').get(id) as { path: string; rel_path: string | null };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-relpath-'));
  oldRoot = path.join(tmp, 'Meu Drive', 'Livros');
  newRoot = path.join(tmp, 'Dropbox', 'Livros');
  fs.mkdirSync(oldRoot, { recursive: true });
  fs.mkdirSync(newRoot, { recursive: true });
  db = (await import('../server/db.ts')).db;
  relpath = await import('../server/relpath.ts');
  lib = await import('../server/library.ts');
  settings = await import('../server/settings.ts');
  db.exec('delete from books');
});

afterAll(() => {
  db.exec('delete from books');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('relative paths (T1)', () => {
  let ids: number[];
  let outside: number;

  it('fills rel_path with forward slashes for books under booksDir, leaving others alone', () => {
    ids = FILES.map((f, i) => {
      const abs = path.join(oldRoot, ...f.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `book${i}`);
      return addRow(abs, `book${i}`);
    });
    const elsewhere = path.join(tmp, 'fora', 'Solto.epub');
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, 'solto');
    outside = addRow(elsewhere, 'solto');
    const before = (db.prepare('select count(*) n from books').get() as { n: number }).n;

    relpath.reconcilePaths(oldRoot);

    ids.forEach((id, i) => expect(row(id).rel_path).toBe(FILES[i]));
    expect(row(outside).rel_path).toBeNull();
    expect(row(outside).path).toBe(elsewhere);
    expect((db.prepare('select count(*) n from books').get() as { n: number }).n).toBe(before);
  });

  it('is idempotent', () => {
    const snapshot = JSON.stringify(db.prepare('select id, path, rel_path from books order by id').all());
    relpath.reconcilePaths(oldRoot);
    relpath.reconcilePaths(oldRoot);
    expect(JSON.stringify(db.prepare('select id, path, rel_path from books order by id').all())).toBe(snapshot);
  });

  it('keeps a book whose file is gone instead of deleting the row', async () => {
    fs.rmSync(path.join(oldRoot, 'Outro', 'Outro - Tres.epub'));
    settings.updateSettings({ booksDir: oldRoot });
    const r = await lib.scanLibrary();
    expect(r.missing).toBeGreaterThanOrEqual(1);
    expect(db.prepare('select missing from books where id = ?').get(ids[2])).toEqual({ missing: 1 });
    fs.writeFileSync(path.join(oldRoot, 'Outro', 'Outro - Tres.epub'), 'book2');
  });
});

describe('library moved to another folder (T2)', () => {
  it('re-points every book by rel_path: nothing added, moved, missing or duplicated', async () => {
    settings.updateSettings({ booksDir: oldRoot });
    await lib.scanLibrary();
    fs.cpSync(oldRoot, newRoot, { recursive: true });
    fs.rmSync(oldRoot, { recursive: true, force: true });
    fs.mkdirSync(oldRoot, { recursive: true });

    settings.updateSettings({ booksDir: newRoot });
    const r = await lib.scanLibrary();

    expect(r).toEqual({ added: 0, moved: 0, missing: 0, duplicates: 0 });
    const rows = db.prepare("select path, rel_path, missing from books where rel_path is not null").all() as { path: string; rel_path: string; missing: number }[];
    expect(rows.length).toBe(FILES.length);
    for (const b of rows) {
      expect(b.missing).toBe(0);
      expect(fs.existsSync(b.path)).toBe(true);
      expect(b.path.startsWith(newRoot)).toBe(true);
    }
    expect((db.prepare('select count(*) n from books').get() as { n: number }).n).toBe(FILES.length + 1);
  });
});
