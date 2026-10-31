import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = process.env.BOOKFLIX_DATA ?? path.join(ROOT, 'data');
/** Built web app. The packaged desktop app ships it outside the code archive and says where via BOOKFLIX_WEB_DIST. */
export const WEB_DIST = process.env.BOOKFLIX_WEB_DIST ?? path.join(ROOT, 'web', 'dist');
export const COVERS_DIR = path.join(DATA_DIR, 'covers');
export const STAGING_DIR = path.join(DATA_DIR, 'staging');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');
for (const d of [DATA_DIR, COVERS_DIR, STAGING_DIR, TRASH_DIR]) fs.mkdirSync(d, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'library.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

/** Creates/updates every table. Exported so tests (and the sync engine's tests) can build extra in-memory databases. */
export function initSchema(d: DatabaseSync) {
d.exec(`
create table if not exists settings(key text primary key, value text);

create table if not exists books(
  id integer primary key autoincrement,
  path text unique, filename text, format text, size integer, hash text, kindle_md5 text,
  title text, subtitle text, authors text not null default '',
  series text, series_index real, publisher text, year integer, isbn text, language text,
  description text, tags text not null default '[]', pages integer, cover text,
  status text not null default 'unread', progress real not null default 0,
  rating integer, review text,
  added_at integer, last_read integer, finished_at integer, read_time integer not null default 0,
  organized integer not null default 0, sent_to_kindle integer not null default 0, missing integer not null default 0,
  edited_fields text not null default '[]', sources text not null default '{}'
);
create index if not exists books_hash on books(hash);

create table if not exists highlights(
  id integer primary key autoincrement,
  book_id integer not null references books(id) on delete cascade,
  uid text unique,
  kind text not null default 'highlight',
  text text, note text, chapter text, page text, color text,
  created_at text, source text not null default 'kindle', edited integer not null default 0, deleted integer not null default 0
);
create index if not exists highlights_book on highlights(book_id);

create table if not exists reading_days(
  book_id integer not null references books(id) on delete cascade,
  day text not null, seconds integer not null, pages integer not null,
  primary key(book_id, day)
);

create table if not exists staging(
  id integer primary key autoincrement,
  path text not null, original_name text, format text, owned integer not null default 0,
  source text not null default 'upload', book_id integer, extracted text not null default '{}',
  hash text, created_at integer
);

create table if not exists history(
  id integer primary key autoincrement,
  action text not null, book_id integer, new_path text, old_path text, backup_path text,
  snapshot text, at integer, undone integer not null default 0
);

create table if not exists wishlist(
  id integer primary key autoincrement,
  key text unique, title text, authors text, isbn text, cover_url text, description text, link text, year integer, added_at integer
);

create table if not exists recs(book_id integer primary key references books(id) on delete cascade, json text, fetched_at integer);

create table if not exists rec_dismissed(norm text primary key, title text, at integer);

create table if not exists saved_filters(id integer primary key autoincrement, name text, query text);

create table if not exists unmatched(
  id integer primary key autoincrement,
  title text, authors text, md5 text, sdr_path text, payload text, imported_at integer
);

create virtual table if not exists books_fts using fts5(
  title, authors, series, publisher, tags, description, notes,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- what each synced item looked like the last time it was exchanged, and since when it has been that way (see sync.ts)
create table if not exists sync_state(key text primary key, hash text not null, u integer not null);
`);
const addColumn = (table: string, column: string, ddl: string) => {
  if (!(d.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)) {
    d.exec(`alter table ${table} add column ${column} ${ddl}`);
  }
};
// "ignored" rows stay in the table so the next Kindle import does not bring them back
addColumn('unmatched', 'ignored', 'integer not null default 0');
// path of the file inside the library folder; books.path is derived from it (see relpath.ts)
addColumn('books', 'rel_path', 'text');
}
initSchema(db);

/**
 * Kindle highlight ids used to contain the local book id, which differs between computers. Rewrites them to hash-based ids
 * (see highlightUid in kindle/import.ts). A row whose text was edited cannot be rebuilt and keeps its id. Returns rows changed.
 */
export function migrateHighlightUids(d: DatabaseSync): number {
  const rows = d
    .prepare("select h.id, h.uid, h.text, h.created_at, b.id as book_id, b.hash from highlights h join books b on b.id = h.book_id where h.source = 'kindle' and b.hash is not null")
    .all() as { id: number; uid: string; text: string | null; created_at: string | null; book_id: number; hash: string }[];
  const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
  const taken = d.prepare('select 1 from highlights where uid = ?');
  const set = d.prepare('update highlights set uid = ? where id = ?');
  let n = 0;
  for (const r of rows) {
    if (r.uid !== sha1(`${r.book_id}|${r.created_at}|${r.text}`)) continue; // already migrated, or text was edited
    const next = sha1(`${r.hash}|${r.created_at}|${r.text}`);
    if (next === r.uid || taken.get(next)) continue;
    set.run(next, r.id);
    n++;
  }
  return n;
}
migrateHighlightUids(db);

import type { SQLInputValue } from 'node:sqlite';
type Params = Record<string, unknown>;

/** node:sqlite rejects undefined; normalise to null. */
export function clean<T extends Params>(o: T): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(o)) out[k] = (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v) as SQLInputValue;
  return out;
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function getSetting<T = string>(key: string, fallback?: T): T | undefined {
  const row = db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

export function setSetting(key: string, value: unknown) {
  db.prepare('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export interface BookRow {
  id: number;
  path: string;
  rel_path: string | null;
  filename: string;
  format: string;
  size: number;
  hash: string | null;
  kindle_md5: string | null;
  title: string | null;
  subtitle: string | null;
  authors: string;
  series: string | null;
  series_index: number | null;
  publisher: string | null;
  year: number | null;
  isbn: string | null;
  language: string | null;
  description: string | null;
  tags: string[];
  pages: number | null;
  cover: string | null;
  status: 'unread' | 'reading' | 'read' | 'abandoned';
  progress: number;
  rating: number | null;
  review: string | null;
  added_at: number;
  last_read: number | null;
  finished_at: number | null;
  read_time: number;
  organized: number;
  sent_to_kindle: number;
  missing: number;
  edited_fields: string[];
  sources: Record<string, string>;
}

export function parseBook(row: any): BookRow {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    edited_fields: JSON.parse(row.edited_fields || '[]'),
    sources: JSON.parse(row.sources || '{}'),
  };
}

export function getBook(id: number): BookRow | undefined {
  const row = db.prepare('select * from books where id = ?').get(id);
  return row ? parseBook(row) : undefined;
}

export function isMetadataComplete(b: Pick<BookRow, 'title' | 'authors' | 'publisher' | 'year' | 'description'>): boolean {
  return !!(b.title && b.authors && b.authors !== 'Autor Desconhecido' && b.publisher && b.year && b.description);
}

/** Rebuild the full-text row for a book (metadata + highlights/notes). */
export function reindexBook(id: number) {
  const b = db.prepare('select * from books where id = ?').get(id) as any;
  db.prepare('delete from books_fts where rowid = ?').run(id);
  if (!b) return;
  const notes = (
    db.prepare("select coalesce(text,'') || ' ' || coalesce(note,'') as t from highlights where book_id = ? and deleted = 0").all(id) as {
      t: string;
    }[]
  )
    .map((r) => r.t)
    .join(' ');
  db.prepare(
    'insert into books_fts(rowid, title, authors, series, publisher, tags, description, notes) values (?,?,?,?,?,?,?,?)',
  ).run(
    id,
    `${b.title ?? ''} ${b.subtitle ?? ''}`,
    b.authors ?? '',
    b.series ?? '',
    b.publisher ?? '',
    (JSON.parse(b.tags || '[]') as string[]).join(' '),
    b.description ?? '',
    notes,
  );
}
