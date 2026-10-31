import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BookRow, clean, db, getBook, getSetting, parseBook, reindexBook, setSetting, tx } from '../db.ts';
import { isBookFile, norm, now, partialMd5, sha1 } from '../util.ts';
import { indexBooks } from './remove.ts';

/**
 * Id of a Kindle highlight. Built from the book's file hash, which is the same on every computer, so two devices that
 * import the same Kindle get the same ids (the sync relies on it). A book without a hash yet falls back to its local id.
 */
export function highlightUid(book: { id: number; hash: string | null }, datetime: string | null | undefined, text: string | null | undefined): string {
  return sha1(`${book.hash || book.id}|${datetime}|${text}`);
}
import { Sidecar, parseSidecar, setAnnotationNote, setSummaryNote, setSummaryRating, setSummaryStatus } from './lua.ts';

export interface ImportSummary {
  root: string;
  sidecars: number;
  matched: number;
  unmatched: number;
  highlights: number;
  /** what was edited in Bookflix and written into the Kindle's files */
  pushed: Pushed;
  statsBooks: number;
  readingDays: number;
  errors: string[];
}

const SKIP_DIRS = new Set(['system', '.active_content_sandbox', '.mrch', 'Trash', '$RECYCLE.BIN', 'System Volume Information']);

async function findSdrs(root: string): Promise<string[]> {
  const out: string[] = [];
  let visited = 0;
  async function rec(dir: string, depth: number) {
    if (depth > 7 || visited++ > 30000) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      // KOReader's own quick-start guide is not a book of yours (docsettings next to it can hold real sidecars, so only "help" is skipped)
      if (e.name === 'help' && path.basename(dir) === 'koreader') continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.sdr')) out.push(full);
      else await rec(full, depth + 1);
    }
  }
  await rec(root, 0);
  return out;
}

async function findStatsDb(root: string): Promise<string | null> {
  for (const c of ['koreader/settings/statistics.sqlite3', 'settings/statistics.sqlite3', 'statistics.sqlite3']) {
    const p = path.join(root, c);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

/**
 * Whether a book is physically on the device. A sidecar (.sdr) or a statistics row stays behind when the book is deleted,
 * so by themselves they do not mean "No Kindle". A copy of the folders without documents/ cannot tell, so it counts as yes.
 */
async function bookPresence(root: string): Promise<(md5?: string | null, sdr?: string) => boolean> {
  if (!fsSync.existsSync(path.join(root, 'documents'))) return () => true;
  const md5s = await indexBooks(root);
  return (md5, sdr) => {
    if (md5 && md5s.has(md5)) return true;
    if (!sdr) return false;
    // the book file sits beside its sidecar: "Livro.sdr" for "Livro.epub" (older KOReader: "Livro.epub.sdr")
    const base = path.basename(sdr, '.sdr');
    try {
      return fsSync.readdirSync(path.dirname(sdr)).some((f) => isBookFile(f) && (f === base || f.replace(/\.[^.]+$/, '') === base));
    } catch {
      return false;
    }
  };
}

function matchBook(opts: { md5?: string; fileName?: string; title?: string; authors?: string }): BookRow | undefined {
  if (opts.md5) {
    const r = db.prepare('select * from books where hash = ? or kindle_md5 = ?').get(opts.md5, opts.md5);
    if (r) return parseBook(r);
  }
  if (opts.fileName) {
    const r = db.prepare('select * from books where filename = ?').get(opts.fileName);
    if (r) return parseBook(r);
  }
  const t = norm(opts.title);
  if (t) {
    const a = norm((opts.authors ?? '').split(/[;\n]/)[0]);
    const rows = db.prepare('select * from books').all().map(parseBook);
    return rows.find((b) => norm(b.title) === t && (!a || !b.authors || norm(b.authors.split(';')[0]) === a)) ??
      rows.find((b) => norm(`${b.title} ${b.subtitle ?? ''}`) === t);
  }
  return undefined;
}

const toEpoch = (s?: string | null) => {
  if (!s) return null;
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

export interface Pushed {
  reviews: number;
  ratings: number;
  statuses: number;
  notes: number;
}
const noPush = (): Pushed => ({ reviews: 0, ratings: 0, statuses: 0, notes: 0 });

/** KOReader has no "unread": a book that was never opened simply has no status. */
const KO_STATUS: Partial<Record<BookRow['status'], 'reading' | 'complete' | 'abandoned'>> = { reading: 'reading', read: 'complete', abandoned: 'abandoned' };

const lf = (s: string | null | undefined) => (s ?? '').replace(/\r\n?/g, '\n').trim();

/**
 * What was edited in Bookflix goes into the book's sidecar on the Kindle: review ("Resenha"), stars, status
 * and the text of highlight notes. What Bookflix did not edit is left alone (applySidecar imports it instead).
 * Highlights are never added or removed on the Kindle, and the book's text is never touched.
 * The new file is parsed again and checked before it replaces the old one.
 */
async function pushToSidecar(book: BookRow, sc: Sidecar, luaPath: string): Promise<Pushed> {
  const edited = new Set(book.edited_fields);
  // Bookflix wins when the user edited the field; a Kindle value is also filled in when it has none
  const wins = (field: string, onKindle: unknown) => edited.has(field) || !onKindle;
  const original = await fs.readFile(luaPath, 'utf8');
  let src = original;
  const pushed = noPush();
  const expected: { review?: string; rating?: number; status?: string; notes: Map<string, string> } = { notes: new Map() };

  const review = lf(book.review);
  if (review && review !== lf(sc.review) && wins('review', sc.review)) {
    src = setSummaryNote(src, review);
    expected.review = review;
    pushed.reviews++;
  }
  if (book.rating && book.rating !== sc.rating && wins('rating', sc.rating)) {
    src = setSummaryRating(src, book.rating);
    expected.rating = book.rating;
    pushed.ratings++;
  }
  const status = KO_STATUS[book.status];
  if (status && status !== sc.status && edited.has('status')) {
    src = setSummaryStatus(src, status);
    expected.status = status;
    pushed.statuses++;
  }

  const mine = new Map((db.prepare('select uid, note from highlights where book_id = ? and edited = 1 and deleted = 0').all(book.id) as { uid: string; note: string | null }[]).map((r) => [r.uid, lf(r.note)]));
  for (const a of sc.annotations) {
    const note = mine.get(highlightUid(book, a.datetime, a.text));
    if (!a.key || !note || note === lf(a.note)) continue;
    src = setAnnotationNote(src, a.key, note);
    expected.notes.set(a.key, note);
    pushed.notes++;
  }

  if (src === original) return noPush();
  const check = parseSidecar(src);
  const ok =
    (expected.review === undefined || check.review === expected.review) &&
    (expected.rating === undefined || check.rating === expected.rating) &&
    (expected.status === undefined || check.status === expected.status) &&
    [...expected.notes].every(([k, n]) => check.annotations.find((x) => x.key === k)?.note === n) &&
    check.annotations.length >= sc.annotations.length;
  if (!ok) throw new Error('não foi possível gravar com segurança; o arquivo do Kindle não foi alterado');
  const tmp = `${luaPath}.bookflix-tmp`;
  try {
    await fs.writeFile(tmp, src);
    await fs.rename(tmp, luaPath);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return pushed;
}

function applySidecar(book: BookRow, sc: Sidecar, onDevice: boolean): number {
  const edited = new Set(book.edited_fields);
  const upd: Record<string, unknown> = { id: book.id, progress: sc.percent };
  const cols = ['progress = :progress'];
  if (onDevice) {
    upd.sent_to_kindle = 1;
    cols.push('sent_to_kindle = :sent_to_kindle');
  }
  if (!edited.has('status')) {
    const status = sc.status === 'complete' ? 'read' : sc.status === 'abandoned' ? 'abandoned' : sc.status === 'reading' || sc.percent > 0 ? 'reading' : 'unread';
    upd.status = status === 'reading' && sc.percent >= 0.99 ? 'read' : status;
    cols.push('status = :status');
    if (upd.status === 'read' && !book.finished_at) {
      upd.finished_at = toEpoch(sc.modified) ?? now();
      cols.push('finished_at = :finished_at');
    }
  }
  if (!edited.has('rating') && sc.rating) {
    upd.rating = sc.rating;
    cols.push('rating = :rating');
  }
  if (!edited.has('review') && sc.review) {
    upd.review = sc.review;
    cols.push('review = :review');
  }
  if (sc.docPages && !book.pages) {
    upd.pages = sc.docPages;
    cols.push('pages = :pages');
  }
  const mod = toEpoch(sc.modified);
  if (mod && (!book.last_read || mod > book.last_read)) {
    upd.last_read = mod;
    cols.push('last_read = :last_read');
  }
  db.prepare(`update books set ${cols.join(', ')} where id = :id`).run(clean(upd));

  const ins = db.prepare(
    `insert into highlights(book_id, uid, kind, text, note, chapter, page, color, created_at, source)
     values(:book_id, :uid, :kind, :text, :note, :chapter, :page, :color, :created_at, 'kindle')
     on conflict(uid) do update set text = excluded.text, note = excluded.note, chapter = excluded.chapter,
       page = excluded.page, color = excluded.color, kind = excluded.kind where highlights.edited = 0`,
  );
  for (const a of sc.annotations) {
    ins.run(clean({ book_id: book.id, uid: highlightUid(book, a.datetime, a.text), kind: a.kind, text: a.text, note: a.note, chapter: a.chapter, page: a.page, color: a.color, created_at: a.datetime }));
  }
  reindexBook(book.id);
  return sc.annotations.length;
}

function importStats(statsPath: string, summary: ImportSummary, present: (md5?: string | null) => boolean) {
  const tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bookflix-stats-'));
  const tmp = path.join(tmpDir, 'stats.sqlite3');
  fsSync.copyFileSync(statsPath, tmp);
  for (const ext of ['-wal', '-shm']) if (fsSync.existsSync(statsPath + ext)) fsSync.copyFileSync(statsPath + ext, tmp + ext);
  const sdb = new DatabaseSync(tmp, { readOnly: true });
  try {
    const books = sdb.prepare('select id, title, authors, md5, last_open, total_read_time, pages from book').all() as any[];
    const days = sdb.prepare(
      `select date(start_time, 'unixepoch', 'localtime') as day, sum(duration) as seconds, count(distinct page) as pages
       from page_stat_data where id_book = ? group by day`,
    );
    for (const kb of books) {
      const book = matchBook({ md5: kb.md5, title: kb.title, authors: kb.authors });
      if (!book) {
        const exists = db.prepare('select 1 from unmatched where md5 = ?').get(kb.md5 ?? '');
        if (!exists && (kb.total_read_time ?? 0) > 0) {
          db.prepare('insert into unmatched(title, authors, md5, sdr_path, payload, imported_at) values(?,?,?,?,?,?)').run(kb.title, kb.authors, kb.md5, null, JSON.stringify({ kind: 'stats' }), now());
          summary.unmatched++;
        }
        continue;
      }
      const rows = days.all(kb.id) as { day: string; seconds: number; pages: number }[];
      tx(() => {
        db.prepare('delete from reading_days where book_id = ?').run(book.id);
        const ins = db.prepare('insert into reading_days(book_id, day, seconds, pages) values(?,?,?,?)');
        for (const r of rows) if (r.day) ins.run(book.id, r.day, r.seconds ?? 0, r.pages ?? 0);
        db.prepare('update books set read_time = ?, sent_to_kindle = max(sent_to_kindle, ?), pages = coalesce(pages, ?), last_read = max(coalesce(last_read, 0), ?) where id = ?').run(
          kb.total_read_time ?? 0,
          present(kb.md5) ? 1 : 0,
          kb.pages || null,
          kb.last_open ?? 0,
          book.id,
        );
      });
      summary.statsBooks++;
      summary.readingDays += rows.length;
    }
  } finally {
    sdb.close();
    fsSync.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Reads KOReader data (sidecars + statistics DB) from a mounted Kindle or a copy of its folders. */
export async function importFromKindle(root: string): Promise<ImportSummary> {
  if (!root || !fsSync.existsSync(root)) throw new Error('Pasta do Kindle não encontrada.');
  setSetting('lastKindleRoot', root);
  const summary: ImportSummary = { root, sidecars: 0, matched: 0, unmatched: 0, highlights: 0, pushed: noPush(), statsBooks: 0, readingDays: 0, errors: [] };

  const present = await bookPresence(root);
  for (const sdr of await findSdrs(root)) {
    try {
      const files = await fs.readdir(sdr);
      const lua = files.find((f) => /^metadata\..+\.lua$/.test(f));
      if (!lua) continue;
      summary.sidecars++;
      const sc = parseSidecar(await fs.readFile(path.join(sdr, lua), 'utf8'));
      const bookFile = sdr.slice(0, -'.sdr'.length);
      let md5 = sc.partialMd5;
      if (!md5 && fsSync.existsSync(bookFile) && fsSync.statSync(bookFile).isFile()) md5 = await partialMd5(bookFile);
      const book = matchBook({ md5, fileName: path.basename(bookFile), title: sc.props.title, authors: sc.props.authors });
      if (!book) {
        if (!db.prepare('select 1 from unmatched where sdr_path = ?').get(sdr)) {
          db.prepare('insert into unmatched(title, authors, md5, sdr_path, payload, imported_at) values(?,?,?,?,?,?)').run(sc.props.title ?? path.basename(bookFile), sc.props.authors ?? '', md5 ?? null, sdr, JSON.stringify({ kind: 'sidecar' }), now());
        }
        summary.unmatched++;
        continue;
      }
      summary.highlights += tx(() => applySidecar(book, sc, present(md5, sdr)));
      summary.matched++;
      const p = await pushToSidecar(book, sc, path.join(sdr, lua));
      for (const k of Object.keys(p) as (keyof Pushed)[]) summary.pushed[k] += p[k];
    } catch (e) {
      summary.errors.push(`${path.basename(sdr)}: ${(e as Error).message}`);
    }
  }

  const statsPath = await findStatsDb(root);
  if (statsPath) {
    try {
      importStats(statsPath, summary, present);
    } catch (e) {
      summary.errors.push(`statistics.sqlite3: ${(e as Error).message}`);
    }
  } else summary.errors.push('statistics.sqlite3 não encontrado (sem estatísticas de tempo de leitura).');

  // unmatched rows that now match (e.g. after a library scan) are cleaned up
  for (const u of db.prepare('select * from unmatched').all() as any[]) {
    if (matchBook({ md5: u.md5, title: u.title, authors: u.authors })) db.prepare('delete from unmatched where id = ?').run(u.id);
  }
  return summary;
}

export async function linkUnmatched(unmatchedId: number, bookId: number): Promise<ImportSummary | null> {
  const u = db.prepare('select * from unmatched where id = ?').get(unmatchedId) as any;
  if (!u || !getBook(bookId)) throw new Error('Registro não encontrado');
  if (u.md5) db.prepare('update books set kindle_md5 = ? where id = ?').run(u.md5, bookId);
  db.prepare('delete from unmatched where id = ?').run(unmatchedId);
  const root = getSetting<string>('lastKindleRoot');
  return root && fsSync.existsSync(root) ? importFromKindle(root) : null;
}
