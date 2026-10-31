import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initSchema } from '../server/db.ts';
import { SyncEngine, SyncError, syncDirOf } from '../server/sync.ts';

// Each "device" is its own in-memory database + engine; they only share the synced folder, like two computers sharing Drive/Dropbox.

let tmp: string;
let books: string;
let dir: string;
const clock = { t: 1000 };

interface Dev {
  id: string;
  db: DatabaseSync;
  engine: SyncEngine;
}
const device = (id: string): Dev => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return { id, db, engine: new SyncEngine({ db, dir, deviceId: id, now: () => clock.t }) };
};

let seq = 0;
const addBook = (d: Dev, hash: string, title = hash, rel: string | null = `Autor/${title}.epub`) =>
  Number(
    d.db
      .prepare('insert into books(path, rel_path, filename, format, size, hash, title, authors, added_at) values(?,?,?,?,?,?,?,?,?)')
      .run(`/x/${d.id}/${++seq}.epub`, rel, `${title}.epub`, 'epub', 10, hash, title, 'Autor', 1).lastInsertRowid,
  );
const setBook = (d: Dev, hash: string, patch: Record<string, unknown>) => {
  const keys = Object.keys(patch);
  d.db.prepare(`update books set ${keys.map((k) => `${k} = :${k}`).join(', ')} where hash = :__where`).run({ ...patch, __where: hash } as any);
};
const book = (d: Dev, hash: string) => d.db.prepare('select * from books where hash = ?').get(hash) as any;
const addHl = (d: Dev, hash: string, uid: string, text: string, extra: Record<string, unknown> = {}) => {
  const b = book(d, hash);
  d.db
    .prepare("insert into highlights(book_id, uid, kind, text, note, created_at, source, edited, deleted) values(?,?,?,?,?,?,?,?,?)")
    .run(b.id, uid, 'highlight', text, (extra.note as string) ?? null, '2026-01-01 10:00:00', (extra.source as string) ?? 'kindle', 0, 0);
};
const hls = (d: Dev, hash: string) =>
  d.db.prepare('select uid, note, deleted from highlights where book_id = ? order by uid').all(book(d, hash).id) as { uid: string; note: string | null; deleted: number }[];
const addDay = (d: Dev, hash: string, day: string, seconds: number, pages: number) =>
  d.db.prepare('insert or replace into reading_days(book_id, day, seconds, pages) values(?,?,?,?)').run(book(d, hash).id, day, seconds, pages);
const days = (d: Dev, hash: string) => d.db.prepare('select day, seconds, pages from reading_days where book_id = ? order by day').all(book(d, hash).id);

/** A, B, A again: enough for any state to reach every device */
const converge = (...devs: Dev[]) => {
  for (let round = 0; round < 2; round++) for (const d of devs) d.engine.sync();
};
const dump = (d: Dev) =>
  JSON.stringify({
    books: d.db.prepare('select hash, title, status, progress, rating, review, tags from books order by hash').all(),
    hl: d.db.prepare('select uid, note, deleted from highlights order by uid').all(),
    days: d.db.prepare('select day, seconds, pages from reading_days order by book_id, day').all(),
    settings: d.db.prepare("select key, value from settings where key in ('nameTemplate','useFolders','yearlyGoal') order by key").all(),
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-sync-'));
  books = path.join(tmp, 'Livros');
  dir = syncDirOf(books);
  fs.mkdirSync(books, { recursive: true });
  clock.t = 1000;
});
afterAll(() => {
  for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('bookflix-sync-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
});

/** two devices that both know books X and Y (same files in the shared folder), A created the library, B joined */
function pair() {
  const A = device('dev-a');
  const B = device('dev-b');
  for (const d of [A, B]) {
    addBook(d, 'hx', 'X');
    addBook(d, 'hy', 'Y');
  }
  A.engine.init('create');
  A.engine.sync();
  B.engine.init('join');
  return { A, B };
}

describe('merging two devices (T11-T14)', () => {
  it('T11: edits made on different books on different devices end up on both', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5 });
    A.engine.sync();
    clock.t = 3000;
    setBook(B, 'hy', { status: 'read', progress: 1 });
    converge(A, B);
    for (const d of [A, B]) {
      expect(book(d, 'hx').rating).toBe(5);
      expect(book(d, 'hy').status).toBe('read');
    }
    expect(dump(A)).toBe(dump(B));
  });

  it('T11b: a device that just scanned the file (defaults) never overrides data the other one already had', () => {
    const A = device('dev-a');
    const B = device('dev-b');
    addBook(A, 'hx', 'X');
    addBook(B, 'hx', 'X');
    setBook(A, 'hx', { rating: 5, status: 'read', progress: 1, review: 'Ótimo' }); // history from before sync existed
    A.engine.init('create');
    clock.t = 5000; // B syncs later: its "unread" defaults get a newer timestamp than A's untouched data
    A.engine.sync();
    B.engine.init('join');
    converge(A, B);
    for (const d of [A, B]) expect(book(d, 'hx')).toMatchObject({ rating: 5, status: 'read', review: 'Ótimo' });
  });

  it('T11c: shared settings and wishlist travel; keys, folders and Kindle paths do not', () => {
    const { A, B } = pair();
    clock.t = 2000;
    A.db.prepare("insert or replace into settings(key, value) values('yearlyGoal', '40')").run();
    A.db.prepare("insert or replace into settings(key, value) values('openaiKey', '\"sk-never\"')").run();
    A.db.prepare("insert or replace into settings(key, value) values('booksDir', '\"/minha/pasta\"')").run();
    A.db.prepare("insert into wishlist(key, title, authors, added_at) values('k1','Duna','Frank Herbert',1)").run();
    A.db.prepare("insert into rec_dismissed(norm, title, at) values('ruim','Livro Ruim',1)").run();
    converge(A, B);
    expect(B.db.prepare("select value from settings where key = 'yearlyGoal'").get()).toEqual({ value: '40' });
    expect(B.db.prepare("select 1 from settings where key in ('openaiKey','booksDir')").get()).toBeUndefined();
    expect((B.db.prepare("select title from wishlist where key = 'k1'").get() as any).title).toBe('Duna');
    expect(B.db.prepare("select 1 from rec_dismissed where norm = 'ruim'").get()).toBeTruthy();
    const files = fs.readdirSync(path.join(dir, 'devices')).map((f) => fs.readFileSync(path.join(dir, 'devices', f), 'utf8')).join('');
    expect(files).not.toContain('sk-never');
    expect(files).not.toContain('/minha/pasta');
  });

  it('T12: the later edit of the same field wins on both devices', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 4 });
    A.engine.sync();
    clock.t = 3000;
    setBook(B, 'hx', { rating: 2 });
    converge(A, B);
    expect(book(A, 'hx').rating).toBe(2);
    expect(book(B, 'hx').rating).toBe(2);
  });

  it('T12b: a later edit that clears a value also wins (nothing is "stuck" on a non-default value)', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 4, status: 'read' });
    converge(A, B);
    clock.t = 3000;
    setBook(B, 'hx', { rating: null, status: 'unread' });
    converge(A, B);
    for (const d of [A, B]) expect(book(d, 'hx')).toMatchObject({ rating: null, status: 'unread' });
  });

  it('T12c: exactly simultaneous edits resolve the same way on both devices (lower device id wins)', () => {
    const { A, B } = pair();
    clock.t = 4000;
    setBook(A, 'hx', { rating: 1 });
    setBook(B, 'hx', { rating: 3 });
    converge(A, B);
    expect(book(A, 'hx').rating).toBe(1);
    expect(book(B, 'hx').rating).toBe(1);
  });

  it('T13: highlights are united without duplicates, edits and deletions propagate, reading days keep the larger value', () => {
    const { A, B } = pair();
    clock.t = 2000;
    addHl(A, 'hx', 'hl-a', 'trecho A');
    addHl(B, 'hx', 'hl-b', 'trecho B');
    addHl(A, 'hx', 'hl-shared', 'trecho comum');
    addHl(B, 'hx', 'hl-shared', 'trecho comum'); // both imported the same Kindle highlight
    addDay(A, 'hx', '2026-01-01', 600, 10);
    addDay(B, 'hx', '2026-01-01', 900, 5);
    converge(A, B);
    expect(hls(A, 'hx').map((h) => h.uid)).toEqual(['hl-a', 'hl-b', 'hl-shared']);
    expect(hls(B, 'hx').map((h) => h.uid)).toEqual(['hl-a', 'hl-b', 'hl-shared']);
    expect(days(A, 'hx')).toEqual([{ day: '2026-01-01', seconds: 900, pages: 10 }]);
    expect(days(B, 'hx')).toEqual(days(A, 'hx'));

    clock.t = 3000;
    A.db.prepare("update highlights set note = 'minha nota', edited = 1 where uid = 'hl-b'").run();
    A.db.prepare("update highlights set deleted = 1, edited = 1 where uid = 'hl-shared'").run();
    converge(A, B);
    expect(hls(B, 'hx')).toEqual([
      { uid: 'hl-a', note: null, deleted: 0 },
      { uid: 'hl-b', note: 'minha nota', deleted: 0 },
      { uid: 'hl-shared', note: null, deleted: 1 },
    ]);
  });

  it('T14: syncing again with nothing new changes nothing and rewrites no file', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5 });
    addHl(B, 'hy', 'hl-1', 'x');
    converge(A, B);
    const before = [dump(A), dump(B)];
    const fileA = path.join(dir, 'devices', 'dev-a.json');
    const stamp = fs.statSync(fileA).mtimeMs;
    const content = fs.readFileSync(fileA, 'utf8');
    clock.t = 9000;
    const r1 = A.engine.sync();
    const r2 = B.engine.sync();
    expect([dump(A), dump(B)]).toEqual(before);
    expect(r1).toMatchObject({ applied: 0, wrote: false });
    expect(r2).toMatchObject({ applied: 0, wrote: false });
    expect(fs.statSync(fileA).mtimeMs).toBe(stamp);
    expect(fs.readFileSync(fileA, 'utf8')).toBe(content);
  });

  it('keeps the data when a metadata edit rewrote the file (new hash, same place)', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5 });
    converge(A, B);
    clock.t = 3000;
    setBook(A, 'hx', { hash: 'hx-v2', title: 'X editado' }); // the app rewrote the EPUB: new hash, same rel_path
    A.engine.sync();
    B.engine.sync();
    expect(book(B, 'hx')).toMatchObject({ title: 'X editado', rating: 5 });
    expect(book(A, 'hx-v2')).toMatchObject({ title: 'X editado', rating: 5 });
  });
});

describe('damaged or half-synced folders (T15)', () => {
  it('ignores corrupted files and conflicted copies, waits on empty ones, and still merges the good ones', () => {
    const { A, B } = pair();
    const C = device('dev-c');
    addBook(C, 'hx', 'X');
    addBook(C, 'hy', 'Y');
    C.engine.init('join');
    clock.t = 2000;
    setBook(C, 'hx', { rating: 3 });
    C.engine.sync();

    const devices = path.join(dir, 'devices');
    fs.writeFileSync(path.join(devices, 'dev-bad.json'), '{ not json');
    fs.writeFileSync(path.join(devices, 'dev-zero.json'), '');
    const good = JSON.parse(fs.readFileSync(path.join(devices, 'dev-c.json'), 'utf8'));
    good.state.hx.u = 99999;
    good.state.hx.f.rating = 1; // a stale copy that must never win
    fs.writeFileSync(path.join(devices, 'dev-c (conflicted copy 2026-01-01).json'), JSON.stringify(good));
    fs.writeFileSync(path.join(devices, 'dev-c (cópia em conflito).json'), JSON.stringify(good));

    clock.t = 3000;
    const r = A.engine.sync();
    expect(book(A, 'hx').rating).toBe(3);
    expect(r.pending).toBeGreaterThanOrEqual(1);
    expect(r.warnings.join(' ')).toMatch(/dev-bad/);
    expect(r.warnings.join(' ')).not.toMatch(/conflicted|conflito/);
    expect(B.engine.sync().applied).toBeGreaterThanOrEqual(1);
    expect(book(B, 'hx').rating).toBe(3);
  });

  it('refuses a file written by a newer, incompatible version', () => {
    const { A } = pair();
    fs.writeFileSync(path.join(dir, 'devices', 'dev-z.json'), JSON.stringify({ v: 99, libraryId: 'x', deviceId: 'dev-z' }));
    const r = A.engine.sync();
    expect(r.warnings.join(' ')).toMatch(/dev-z/);
  });
});

describe('library identity (T16)', () => {
  it('refuses to merge when the folder belongs to another library, leaving the database untouched', () => {
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5 });
    A.engine.sync();
    const before = dump(B);
    const lib = path.join(dir, 'library.json');
    fs.writeFileSync(lib, JSON.stringify({ id: 'outra-biblioteca', createdAt: 1 }));
    expect(() => B.engine.sync()).toThrowError(SyncError);
    try {
      B.engine.sync();
    } catch (e) {
      expect((e as SyncError).code).toBe('LIBRARY_MISMATCH');
    }
    expect(dump(B)).toBe(before);
  });

  it('joining is the explicit way to accept the folder\'s library', () => {
    const { A, B } = pair();
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ id: 'outra-biblioteca', createdAt: 1 }));
    expect(() => B.engine.sync()).toThrow();
    expect(B.engine.init('join')).toBe('outra-biblioteca');
    expect(() => B.engine.sync()).not.toThrow();
    expect(A).toBeTruthy();
  });

  it('cannot join a folder with no library, nor create over an existing one', () => {
    const lonely = device('dev-l');
    expect(() => lonely.engine.init('join')).toThrowError(/NO_LIBRARY|biblioteca/i);
    const { B } = pair();
    expect(() => B.engine.init('create')).toThrowError(/LIBRARY_EXISTS|já existe/i);
  });

  it('syncing before enabling is an error, not a silent no-op', () => {
    const d = device('dev-q');
    expect(() => d.engine.sync()).toThrowError(SyncError);
  });
});

describe('the books folder is never touched (T17)', () => {
  const snapshot = () => {
    const out: string[] = [];
    const walk = (p: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (full === dir) continue;
        if (e.isDirectory()) walk(full);
        else out.push(`${path.relative(books, full)}|${fs.statSync(full).size}|${fs.statSync(full).mtimeMs}`);
      }
    };
    walk(books);
    return out.sort();
  };

  it('writes only inside .bookflix-sync, leaves no temp files, and changes no book', () => {
    fs.mkdirSync(path.join(books, 'Autor'), { recursive: true });
    fs.writeFileSync(path.join(books, 'Autor', 'X.epub'), 'conteudo');
    fs.writeFileSync(path.join(books, 'Y.pdf'), 'outro');
    const before = snapshot();
    const { A, B } = pair();
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5 });
    converge(A, B);
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(dir).sort()).toEqual(['devices', 'library.json']);
    expect(fs.readdirSync(path.join(dir, 'devices')).sort()).toEqual(['dev-a.json', 'dev-b.json']);
  });
});

describe('a new device joining (T18)', () => {
  it('receives progress, notes and highlights for the books it has, and the rest as soon as those files arrive', () => {
    const { A, B } = pair();
    addBook(A, 'hz', 'Z');
    clock.t = 2000;
    setBook(A, 'hx', { rating: 5, status: 'read', progress: 1, review: 'Gostei' });
    setBook(A, 'hz', { rating: 2 });
    addHl(A, 'hx', 'hl-1', 'um trecho', { note: 'nota' });
    addDay(A, 'hx', '2026-02-02', 300, 12);
    converge(A, B);

    const D = device('dev-d');
    addBook(D, 'hx', 'X');
    addBook(D, 'hy', 'Y'); // hz has not reached this device yet
    D.engine.init('join');
    clock.t = 3000;
    const r = D.engine.sync();
    expect(book(D, 'hx')).toMatchObject({ rating: 5, status: 'read', review: 'Gostei' });
    expect(hls(D, 'hx')).toEqual([{ uid: 'hl-1', note: 'nota', deleted: 0 }]);
    expect(days(D, 'hx')).toEqual([{ day: '2026-02-02', seconds: 300, pages: 12 }]);
    expect((D.db.prepare('select count(*) n from books').get() as any).n).toBe(2); // nothing is invented for hz
    expect(r.pending).toBeGreaterThanOrEqual(1);

    addBook(D, 'hz', 'Z'); // the file finally arrives and gets scanned
    clock.t = 4000;
    D.engine.sync();
    expect(book(D, 'hz').rating).toBe(2);
    expect((D.db.prepare('select count(*) n from books').get() as any).n).toBe(3);
  });
});
