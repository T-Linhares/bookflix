import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Device-to-device sync through a plain folder (inside Dropbox / Google Drive / anything that syncs files).
 *
 *   <booksDir>/.bookflix-sync/library.json          the library's unique ID
 *   <booksDir>/.bookflix-sync/devices/<id>.json     one file per device, written only by that device
 *   <booksDir>/.bookflix-sync/screensavers/<id>.<ext>  the screensaver pictures themselves, named by the sha1 of their bytes
 *
 * The live SQLite database never goes in the shared folder (cloud clients corrupt WAL files). Each device writes a
 * snapshot of the things the user created (progress, ratings, notes, highlights, reading days, wishlist, a few settings)
 * and merges the snapshots of the others into its own database. Books themselves are never read, written or deleted here.
 *
 * Merge rule, per item: the newest change wins. Two devices that never edited an item both report "since forever" (u = 0);
 * then the one holding real data beats the one holding scanned defaults, and finally the lower device id wins, so every
 * device converges to the same result no matter the order they sync in.
 */

export const SYNC_DIRNAME = '.bookflix-sync';
export const syncDirOf = (booksDir: string) => path.join(booksDir, SYNC_DIRNAME);
const FORMAT = 1;

export type SyncErrorCode = 'NOT_ENABLED' | 'NO_LIBRARY' | 'LIBRARY_EXISTS' | 'LIBRARY_MISMATCH';
export class SyncError extends Error {
  constructor(
    public code: SyncErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

// What travels. Anything not listed here (paths, covers, API keys, Kindle location...) stays on the device.
const META = ['title', 'subtitle', 'authors', 'series', 'series_index', 'publisher', 'year', 'isbn', 'language', 'description', 'tags', 'pages', 'organized', 'edited_fields'];
const STATE = ['status', 'progress', 'rating', 'review', 'last_read', 'finished_at', 'read_time', 'sent_to_kindle'];
const HL = ['kind', 'text', 'note', 'chapter', 'page', 'color', 'created_at', 'source', 'edited', 'deleted'];
const SHARED = ['nameTemplate', 'useFolders', 'yearlyGoal'];
// screensavers: the data about a picture; its bytes go to <sync folder>/screensavers/<id>.<ext>
const SS = ['ext', 'name', 'tags', 'device', 'note', 'favorite', 'deleted', 'width', 'height', 'size', 'added_at'];

type Fields = Record<string, unknown>;
interface BookEntry {
  hash: string | null;
  rel: string | null;
  u: number;
  f: Fields;
}
interface HlEntry {
  book: string | null;
  rel: string | null;
  u: number;
  f: Fields;
}
interface DayRow {
  hash: string | null;
  rel: string | null;
  day: string;
  seconds: number;
  pages: number;
}
interface SsEntry {
  u: number;
  f: Fields;
}
interface DeviceFile {
  v: number;
  libraryId: string;
  deviceId: string;
  writtenAt: number;
  meta: Record<string, BookEntry>;
  state: Record<string, BookEntry>;
  highlights: Record<string, HlEntry>;
  days: DayRow[];
  wishlist: Fields[];
  dismissed: Fields[];
  filters: Fields[];
  settings: { u: number; f: Fields };
  /** reviewed screensavers only (older files do not have this) */
  screensavers?: Record<string, SsEntry>;
}

export interface SyncSummary {
  /** items changed in this device's database */
  applied: number;
  /** items from other devices that cannot be applied yet (book file not here yet, or a file still downloading) */
  pending: number;
  warnings: string[];
  devices: number;
  /** this device's own file was rewritten */
  wrote: boolean;
}

const sha = (s: string) => crypto.createHash('sha1').update(s).digest('hex');
const canon = (f: Fields) => JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k] ?? null]));
const CONFLICT_COPY = /conflict|conflito|conflicto|\(1\)\.json$/i;

const isBlank = (v: unknown) => v === null || v === undefined || v === '' || v === 0 || v === '[]' || v === 'unread';
/** state that only holds what a freshly scanned book has */
const stateIsDefault = (f: Fields) => STATE.every((k) => isBlank(f[k]));
const never = () => false;

export class SyncEngine {
  private db: DatabaseSync;
  private dir: string;
  private deviceId: string;
  private now: () => number;
  private reindex: (bookId: number) => void;
  /** this computer's folder of screensaver pictures; without it the pictures are not synced */
  private ssDir?: string;

  constructor(o: { db: DatabaseSync; dir: string; deviceId: string; now?: () => number; reindex?: (bookId: number) => void; screensaverDir?: string }) {
    this.db = o.db;
    this.dir = o.dir;
    this.deviceId = o.deviceId;
    this.now = o.now ?? Date.now;
    this.reindex = o.reindex ?? (() => {});
    this.ssDir = o.screensaverDir;
  }

  // ---------- library identity ----------

  private libraryFile = () => path.join(this.dir, 'library.json');
  private devicesDir = () => path.join(this.dir, 'devices');

  private readLibraryId(): string | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.libraryFile(), 'utf8'));
      return typeof j.id === 'string' && j.id ? j.id : null;
    } catch {
      return null;
    }
  }

  private getSetting(key: string): any {
    const r = this.db.prepare('select value from settings where key = ?').get(key) as { value: string } | undefined;
    if (!r) return undefined;
    try {
      return JSON.parse(r.value);
    } catch {
      return r.value;
    }
  }
  private setSetting(key: string, value: unknown) {
    this.db.prepare('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(key, JSON.stringify(value));
  }

  /** The library ID this device is part of, or null. */
  get libraryId(): string | null {
    return this.getSetting('syncLibraryId') ?? null;
  }

  /** "create" starts a new library in this folder; "join" accepts the one already there (also how a device switches libraries). */
  init(mode: 'create' | 'join'): string {
    const existing = this.readLibraryId();
    if (mode === 'create') {
      if (existing || fs.existsSync(this.libraryFile())) throw new SyncError('LIBRARY_EXISTS', 'Já existe uma biblioteca sincronizada nesta pasta. Use "Entrar" para participar dela.');
      fs.mkdirSync(this.devicesDir(), { recursive: true });
      const id = crypto.randomUUID();
      fs.writeFileSync(this.libraryFile(), JSON.stringify({ id, createdAt: this.now() }, null, 2));
      this.setSetting('syncLibraryId', id);
      this.build(); // baseline: what exists now counts as "since forever", so only later edits are timestamped
      return id;
    }
    if (!existing) throw new SyncError('NO_LIBRARY', 'Não há uma biblioteca sincronizada nesta pasta (ainda). Se acabou de escolher a pasta, espere o Dropbox/Google Drive terminar de baixar e tente de novo.');
    fs.mkdirSync(this.devicesDir(), { recursive: true });
    this.setSetting('syncLibraryId', existing);
    this.build(); // baseline, see above: edits made between joining and the first sync must still beat older remote data
    return existing;
  }

  /** Stops syncing on this device. Files in the folder are left alone. */
  leave() {
    this.db.prepare("delete from settings where key in ('syncLibraryId', 'syncLastHash')").run();
  }

  // ---------- change tracking ----------

  /** Remembers when an item last changed on this device. First time seen = "since forever" (0), so scanning never looks like an edit. */
  private touch(key: string, fields: Fields): number {
    const h = sha(canon(fields));
    const row = this.db.prepare('select hash, u from sync_state where key = ?').get(key) as { hash: string; u: number } | undefined;
    if (!row) {
      this.db.prepare('insert into sync_state(key, hash, u) values(?,?,0)').run(key, h);
      return 0;
    }
    if (row.hash !== h) {
      const u = this.now();
      this.db.prepare('update sync_state set hash = ?, u = ? where key = ?').run(h, u, key);
      return u;
    }
    return row.u;
  }
  private remember(key: string, fields: Fields, u: number) {
    this.db
      .prepare('insert into sync_state(key, hash, u) values(?,?,?) on conflict(key) do update set hash = excluded.hash, u = excluded.u')
      .run(key, sha(canon(fields)), u);
  }

  private pick(row: Record<string, unknown>, cols: string[]): Fields {
    const f: Fields = {};
    for (const c of cols) f[c] = row[c] ?? null;
    return f;
  }

  // ---------- local state ----------

  private localBooks() {
    return this.db.prepare('select * from books').all() as Record<string, any>[];
  }
  private keyOf(b: Record<string, any>) {
    return b.hash || `p:${b.rel_path ?? b.path}`;
  }

  private sharedSettings(): Fields {
    const f: Fields = {};
    for (const k of SHARED) {
      const r = this.db.prepare('select value from settings where key = ?').get(k) as { value: string } | undefined;
      f[k] = r?.value ?? null;
    }
    return f;
  }

  private build(): DeviceFile {
    const file: DeviceFile = {
      v: FORMAT,
      libraryId: this.libraryId!,
      deviceId: this.deviceId,
      writtenAt: 0,
      meta: {},
      state: {},
      highlights: {},
      days: [],
      wishlist: this.db.prepare('select key, title, authors, isbn, cover_url, description, link, year, added_at from wishlist order by key').all() as Fields[],
      dismissed: this.db.prepare('select norm, title, at from rec_dismissed order by norm').all() as Fields[],
      filters: this.db.prepare('select name, query from saved_filters order by name, query').all() as Fields[],
      settings: { u: 0, f: {} },
      screensavers: {},
    };
    const byId = new Map<number, Record<string, any>>();
    for (const b of this.localBooks()) {
      byId.set(b.id, b);
      const key = this.keyOf(b);
      const meta = this.pick(b, META);
      const state = this.pick(b, STATE);
      file.meta[key] = { hash: b.hash ?? null, rel: b.rel_path ?? null, u: this.touch(`b:${b.id}:meta`, meta), f: meta };
      file.state[key] = { hash: b.hash ?? null, rel: b.rel_path ?? null, u: this.touch(`b:${b.id}:state`, state), f: state };
    }
    for (const h of this.db.prepare('select * from highlights').all() as Record<string, any>[]) {
      const b = byId.get(h.book_id);
      if (!b || !h.uid) continue;
      const f = this.pick(h, HL);
      file.highlights[h.uid] = { book: b.hash ?? null, rel: b.rel_path ?? null, u: this.touch(`h:${h.id}`, f), f };
    }
    for (const d of this.db.prepare('select book_id, day, seconds, pages from reading_days order by book_id, day').all() as Record<string, any>[]) {
      const b = byId.get(d.book_id);
      if (b) file.days.push({ hash: b.hash ?? null, rel: b.rel_path ?? null, day: d.day, seconds: d.seconds, pages: d.pages });
    }
    const sf = this.sharedSettings();
    file.settings = { u: this.touch('settings', sf), f: sf };
    for (const r of this.db.prepare('select * from screensavers where reviewed = 1').all() as Record<string, any>[]) {
      const f = this.pick(r, SS);
      file.screensavers![r.id] = { u: this.touch(`s:${r.id}`, f), f };
    }
    return file;
  }

  // ---------- remote files ----------

  private readRemotes(summary: SyncSummary): DeviceFile[] {
    const out: DeviceFile[] = [];
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.devicesDir());
    } catch {
      return out;
    }
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      if (CONFLICT_COPY.test(name)) continue; // a cloud client's stale copy: never merge it
      if (name === `${this.deviceId}.json`) continue;
      const full = path.join(this.devicesDir(), name);
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (!text.trim()) {
          summary.pending++; // still downloading
          continue;
        }
        const j = JSON.parse(text) as DeviceFile;
        if (j.v !== FORMAT) {
          summary.warnings.push(`${name}: foi escrito por uma versão ${j.v > FORMAT ? 'mais nova' : 'antiga'} do Bookflix e foi ignorado.`);
          continue;
        }
        if (j.libraryId !== this.libraryId) {
          summary.warnings.push(`${name}: pertence a outra biblioteca e foi ignorado.`);
          continue;
        }
        if (!j.deviceId) j.deviceId = name.replace(/\.json$/, '');
        out.push(j);
      } catch {
        summary.warnings.push(`${name}: arquivo ilegível (ainda sincronizando ou corrompido) e foi ignorado.`);
      }
    }
    return out;
  }

  // ---------- applying ----------

  private findBook(hash: string | null, rel: string | null): number | undefined {
    if (hash) {
      const r = this.db.prepare('select id from books where hash = ?').get(hash) as { id: number } | undefined;
      if (r) return r.id;
    }
    // a metadata edit rewrites the EPUB (new hash) but usually keeps its place in the folder
    if (rel) return (this.db.prepare('select id from books where rel_path = ?').get(rel) as { id: number } | undefined)?.id;
    return undefined;
  }

  private remoteWins(r: { u: number; f: Fields; dev: string }, l: { u: number; f: Fields }, isDefault: (f: Fields) => boolean): boolean {
    if (canon(r.f) === canon(l.f)) return false;
    if (r.u !== l.u) return r.u > l.u;
    const rd = isDefault(r.f);
    const ld = isDefault(l.f);
    if (rd !== ld) return ld;
    return r.dev < this.deviceId;
  }

  private setColumns(table: string, idCol: string, id: number | string, cols: string[], f: Fields) {
    const present = cols.filter((c) => c in f);
    if (!present.length) return;
    const params: Record<string, any> = { __id: id };
    for (const c of present) params[c] = f[c] ?? null;
    this.db.prepare(`update ${table} set ${present.map((c) => `${c} = :${c}`).join(', ')} where ${idCol} = :__id`).run(params);
  }

  private mergeBooks(remotes: DeviceFile[], summary: SyncSummary) {
    for (const file of remotes) {
      for (const [group, cols, dflt] of [['meta', META, never], ['state', STATE, stateIsDefault]] as const) {
        for (const e of Object.values(file[group] ?? {})) {
          const id = this.findBook(e.hash ?? null, e.rel ?? null);
          if (id === undefined) {
            summary.pending++;
            continue;
          }
          const row = this.db.prepare('select * from books where id = ?').get(id) as Record<string, any>;
          const localF = this.pick(row, cols);
          const key = `b:${id}:${group}`;
          const local = { u: this.touch(key, localF), f: localF };
          if (!this.remoteWins({ u: e.u, f: e.f, dev: file.deviceId }, local, dflt)) continue;
          this.setColumns('books', 'id', id, cols, e.f);
          this.remember(key, this.pick(this.db.prepare('select * from books where id = ?').get(id) as Record<string, any>, cols), e.u);
          if (group === 'meta') this.reindex(id);
          summary.applied++;
        }
      }
    }
  }

  private mergeHighlights(remotes: DeviceFile[], summary: SyncSummary) {
    for (const file of remotes) {
      for (const [uid, e] of Object.entries(file.highlights ?? {})) {
        const row = this.db.prepare('select * from highlights where uid = ?').get(uid) as Record<string, any> | undefined;
        if (!row) {
          const bookId = this.findBook(e.book ?? null, e.rel ?? null);
          if (bookId === undefined) {
            summary.pending++;
            continue;
          }
          const f = e.f;
          const res = this.db
            .prepare('insert into highlights(book_id, uid, kind, text, note, chapter, page, color, created_at, source, edited, deleted) values(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(bookId, uid, (f.kind as string) ?? 'highlight', (f.text as string) ?? null, (f.note as string) ?? null, (f.chapter as string) ?? null, (f.page as string) ?? null, (f.color as string) ?? null, (f.created_at as string) ?? null, (f.source as string) ?? 'kindle', Number(f.edited ?? 0), Number(f.deleted ?? 0));
          this.remember(`h:${Number(res.lastInsertRowid)}`, this.pick(this.db.prepare('select * from highlights where id = ?').get(Number(res.lastInsertRowid)) as Record<string, any>, HL), e.u);
          this.reindex(bookId);
          summary.applied++;
          continue;
        }
        const localF = this.pick(row, HL);
        const key = `h:${row.id}`;
        const local = { u: this.touch(key, localF), f: localF };
        if (!this.remoteWins({ u: e.u, f: e.f, dev: file.deviceId }, local, never)) continue;
        this.setColumns('highlights', 'id', row.id, HL, e.f);
        this.remember(key, this.pick(this.db.prepare('select * from highlights where id = ?').get(row.id) as Record<string, any>, HL), e.u);
        this.reindex(row.book_id);
        summary.applied++;
      }
    }
  }

  private mergeRest(remotes: DeviceFile[], summary: SyncSummary) {
    for (const file of remotes) {
      for (const d of file.days ?? []) {
        const id = this.findBook(d.hash ?? null, d.rel ?? null);
        if (id === undefined) {
          summary.pending++;
          continue;
        }
        const cur = this.db.prepare('select seconds, pages from reading_days where book_id = ? and day = ?').get(id, d.day) as { seconds: number; pages: number } | undefined;
        const seconds = Math.max(cur?.seconds ?? 0, d.seconds ?? 0);
        const pages = Math.max(cur?.pages ?? 0, d.pages ?? 0);
        if (cur && cur.seconds === seconds && cur.pages === pages) continue;
        this.db
          .prepare('insert into reading_days(book_id, day, seconds, pages) values(?,?,?,?) on conflict(book_id, day) do update set seconds = excluded.seconds, pages = excluded.pages')
          .run(id, d.day, seconds, pages);
        summary.applied++;
      }
      for (const w of file.wishlist ?? []) {
        const r = this.db
          .prepare('insert or ignore into wishlist(key, title, authors, isbn, cover_url, description, link, year, added_at) values(?,?,?,?,?,?,?,?,?)')
          .run((w.key as string) ?? null, (w.title as string) ?? null, (w.authors as string) ?? null, (w.isbn as string) ?? null, (w.cover_url as string) ?? null, (w.description as string) ?? null, (w.link as string) ?? null, (w.year as number) ?? null, (w.added_at as number) ?? null);
        if (r.changes) summary.applied++;
      }
      for (const x of file.dismissed ?? []) {
        const r = this.db.prepare('insert or ignore into rec_dismissed(norm, title, at) values(?,?,?)').run((x.norm as string) ?? null, (x.title as string) ?? null, (x.at as number) ?? null);
        if (r.changes) summary.applied++;
      }
      for (const x of file.filters ?? []) {
        const has = this.db.prepare('select 1 from saved_filters where name = ? and query = ?').get((x.name as string) ?? null, (x.query as string) ?? null);
        if (!has) {
          this.db.prepare('insert into saved_filters(name, query) values(?,?)').run((x.name as string) ?? null, (x.query as string) ?? null);
          summary.applied++;
        }
      }
      if (file.settings) {
        const localF = this.sharedSettings();
        const local = { u: this.touch('settings', localF), f: localF };
        if (this.remoteWins({ u: file.settings.u, f: file.settings.f, dev: file.deviceId }, local, (f) => SHARED.every((k) => f[k] == null))) {
          for (const k of SHARED) {
            const v = file.settings.f[k];
            if (typeof v === 'string') this.db.prepare('insert into settings(key, value) values(?, ?) on conflict(key) do update set value = excluded.value').run(k, v);
          }
          this.remember('settings', this.sharedSettings(), file.settings.u);
          summary.applied++;
        }
      }
    }
  }

  // ---------- screensavers ----------

  private sharedImage = (id: string, ext: string) => path.join(this.dir, 'screensavers', `${id}.${ext}`);

  /** The bytes of a picture from the shared folder, only when they really are that picture (a half-downloaded file hashes differently). */
  private readShared(id: string, ext: string): Buffer | null {
    try {
      const b = fs.readFileSync(this.sharedImage(id, ext));
      return b.length && crypto.createHash('sha1').update(b).digest('hex') === id ? b : null;
    } catch {
      return null;
    }
  }

  private mergeScreensavers(remotes: DeviceFile[], summary: SyncSummary) {
    if (!this.ssDir) return;
    const local = (id: string, ext: string) => path.join(this.ssDir!, `${id}.${ext}`);
    for (const file of remotes) {
      for (const [id, e] of Object.entries(file.screensavers ?? {})) {
        const ext = String(e.f.ext ?? '');
        if (!/^[0-9a-f]{40}$/.test(id) || !/^[a-z0-9]{2,4}$/.test(ext)) continue;
        const row = this.db.prepare('select * from screensavers where id = ?').get(id) as Record<string, any> | undefined;
        // a picture that should exist here but has no file yet needs its bytes first; if the cloud has not finished, wait
        const needsFile = !e.f.deleted && (!row || !!row.deleted || !fs.existsSync(local(id, ext)));
        const bytes = needsFile ? this.readShared(id, ext) : null;
        if (needsFile && !bytes) {
          summary.pending++;
          continue;
        }
        if (!row) {
          if (bytes) (fs.mkdirSync(this.ssDir, { recursive: true }), fs.writeFileSync(local(id, ext), bytes));
          this.db.prepare('insert into screensavers(id, ext, reviewed, source) values(?,?,1,?)').run(id, ext, 'sync');
          this.setColumns('screensavers', 'id', id, SS, e.f);
          summary.applied++;
        } else {
          const localF = this.pick(row, SS);
          const mine = { u: this.touch(`s:${id}`, localF), f: localF };
          // a copy still waiting for review here always yields to a reviewed one
          if (row.reviewed && !this.remoteWins({ u: e.u, f: e.f, dev: file.deviceId }, mine, never)) continue;
          if (bytes) (fs.mkdirSync(this.ssDir, { recursive: true }), fs.writeFileSync(local(id, ext), bytes));
          this.setColumns('screensavers', 'id', id, SS, e.f);
          this.db.prepare('update screensavers set reviewed = 1 where id = ?').run(id);
          summary.applied++;
        }
        if (e.f.deleted) fs.rmSync(local(id, ext), { force: true });
        this.remember(`s:${id}`, this.pick(this.db.prepare('select * from screensavers where id = ?').get(id) as Record<string, any>, SS), e.u);
      }
    }
  }

  /** Puts this computer's reviewed pictures in the shared folder (once) and takes deleted ones out of it. */
  private publishScreensavers() {
    if (!this.ssDir) return;
    for (const r of this.db.prepare('select id, ext, deleted from screensavers where reviewed = 1').all() as { id: string; ext: string; deleted: number }[]) {
      const shared = this.sharedImage(r.id, r.ext);
      if (r.deleted) {
        fs.rmSync(shared, { force: true });
        continue;
      }
      if (this.readShared(r.id, r.ext)) continue;
      const src = path.join(this.ssDir, `${r.id}.${r.ext}`);
      if (!fs.existsSync(src)) continue;
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      const tmp = path.join(path.dirname(shared), `.${r.id}.tmp`);
      fs.copyFileSync(src, tmp);
      fs.renameSync(tmp, shared);
    }
  }

  // ---------- the whole round ----------

  sync(): SyncSummary {
    const id = this.libraryId;
    if (!id) throw new SyncError('NOT_ENABLED', 'A sincronização não está ativada neste aparelho.');
    const onDisk = this.readLibraryId();
    if (!onDisk) throw new SyncError('NO_LIBRARY', 'A pasta de sincronização não tem mais o arquivo da biblioteca. Se ela ainda está baixando, tente de novo em instantes.');
    if (onDisk !== id) throw new SyncError('LIBRARY_MISMATCH', 'Esta pasta pertence a outra biblioteca sincronizada. Entre nela explicitamente ou desative a sincronização.');

    const summary: SyncSummary = { applied: 0, pending: 0, warnings: [], devices: 0, wrote: false };
    fs.mkdirSync(this.devicesDir(), { recursive: true });

    this.build(); // notice local edits first, so they are timestamped before anything is applied
    const remotes = this.readRemotes(summary);
    summary.devices = remotes.length + 1;

    this.db.exec('BEGIN');
    try {
      this.mergeBooks(remotes, summary);
      this.mergeHighlights(remotes, summary);
      this.mergeRest(remotes, summary);
      this.mergeScreensavers(remotes, summary);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }

    this.publishScreensavers();
    const file = this.build();
    const body = JSON.stringify(file);
    const digest = sha(body);
    const target = path.join(this.devicesDir(), `${this.deviceId}.json`);
    if (this.getSetting('syncLastHash') !== digest || !fs.existsSync(target)) {
      file.writtenAt = this.now();
      const tmp = path.join(this.devicesDir(), `.${this.deviceId}.json.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(file));
      fs.renameSync(tmp, target);
      this.setSetting('syncLastHash', digest);
      summary.wrote = true;
    }
    return summary;
  }

  /** For the status panel: who else has written here and when. */
  peers(): { id: string; writtenAt: number }[] {
    const out: { id: string; writtenAt: number }[] = [];
    try {
      for (const name of fs.readdirSync(this.devicesDir())) {
        if (!name.endsWith('.json') || name.startsWith('.') || CONFLICT_COPY.test(name)) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.devicesDir(), name), 'utf8'));
          if (j?.deviceId) out.push({ id: String(j.deviceId), writtenAt: Number(j.writtenAt) || 0 });
        } catch {
          // being downloaded
        }
      }
    } catch {
      // folder missing
    }
    return out;
  }

  /** ID of the library found in the folder, for "join?" prompts. */
  static libraryIdIn(booksDir: string): string | null {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(syncDirOf(booksDir), 'library.json'), 'utf8'));
      return typeof j.id === 'string' ? j.id : null;
    } catch {
      return null;
    }
  }
}
