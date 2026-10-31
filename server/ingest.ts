import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar, { type FSWatcher } from 'chokidar';
import { BookRow, COVERS_DIR, STAGING_DIR, TRASH_DIR, clean, db, getBook, parseBook, reindexBook, tx } from './db.ts';
import { Cover, Meta, WRITABLE, applyMeta, formatOf, readMeta } from './formats/index.ts';
import { buildRelPath } from './naming.ts';
import { getSettings } from './settings.ts';
import { toAbs, toRel } from './relpath.ts';
import { downloadCover, insertBook, metaColumns, saveCover } from './library.ts';
import { isBookFile, norm, now, partialMd5 } from './util.ts';
import { lookupMetadata, LookupResult } from './metadata/index.ts';

export interface StagingItem {
  id: number;
  path: string;
  original_name: string;
  format: string;
  owned: boolean;
  source: 'upload' | 'inbox' | 'library';
  book_id: number | null;
  hash: string | null;
  meta: Meta;
  sources: Record<string, string>;
  cover: string | null;
  created_at: number;
}

function toItem(r: any): StagingItem {
  const ex = JSON.parse(r.extracted || '{}');
  return {
    id: r.id,
    path: r.path,
    original_name: r.original_name,
    format: r.format,
    owned: !!r.owned,
    source: r.source,
    book_id: r.book_id,
    hash: r.hash,
    meta: ex.meta ?? { authors: [], tags: [] },
    sources: ex.sources ?? {},
    cover: ex.cover ?? null,
    created_at: r.created_at,
  };
}

export function listStaging(): StagingItem[] {
  return (db.prepare('select * from staging order by id desc').all() as any[]).map(toItem);
}

export function getStaging(id: number): StagingItem | undefined {
  const r = db.prepare('select * from staging where id = ?').get(id);
  return r ? toItem(r) : undefined;
}

export async function createStaging(opts: { file: string; originalName?: string; owned: boolean; source: StagingItem['source']; bookId?: number }): Promise<StagingItem> {
  const existing = db.prepare('select id from staging where path = ?').get(opts.file) as { id: number } | undefined;
  if (existing) return getStaging(existing.id)!;
  const { meta, cover, sources } = await readMeta(opts.file);
  const hash = await partialMd5(opts.file);
  const res = db
    .prepare('insert into staging(path, original_name, format, owned, source, book_id, extracted, hash, created_at) values(?,?,?,?,?,?,?,?,?)')
    .run(opts.file, opts.originalName ?? path.basename(opts.file), formatOf(opts.file), opts.owned ? 1 : 0, opts.source, opts.bookId ?? null, '{}', hash, now());
  const id = Number(res.lastInsertRowid);
  let coverName: string | null = null;
  if (cover) coverName = await saveCover(`staging-${id}`, cover);
  db.prepare('update staging set extracted = ? where id = ?').run(JSON.stringify({ meta, sources, cover: coverName }), id);
  return getStaging(id)!;
}

export async function stageUpload(name: string, data: Buffer): Promise<StagingItem> {
  const dir = path.join(STAGING_DIR, crypto.randomUUID());
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.basename(name));
  await fs.writeFile(file, data);
  return createStaging({ file, originalName: name, owned: true, source: 'upload' });
}

export async function stageExistingBook(bookId: number): Promise<StagingItem> {
  const b = getBook(bookId);
  if (!b) throw new Error('Livro não encontrado');
  if (!fsSync.existsSync(b.path)) throw new Error('Arquivo do livro não está mais no disco');
  return createStaging({ file: b.path, owned: false, source: 'library', bookId });
}

export async function discardStaging(id: number) {
  const s = getStaging(id);
  if (!s) return;
  await cleanupStaging(s);
}

async function cleanupStaging(s: StagingItem) {
  if (s.owned) await fs.rm(path.dirname(s.path), { recursive: true, force: true });
  if (s.cover) await fs.rm(path.join(COVERS_DIR, s.cover), { force: true });
  db.prepare('delete from staging where id = ?').run(s.id);
}

export async function lookupForStaging(id: number, override?: { title?: string; authors?: string[]; isbn?: string }): Promise<LookupResult> {
  const s = getStaging(id);
  if (!s) throw new Error('Item não encontrado');
  const seed = { title: override?.title ?? s.meta.title, authors: override?.authors ?? s.meta.authors, isbn: override?.isbn ?? s.meta.isbn };
  return lookupMetadata(seed, { meta: s.meta, sources: s.sources });
}

// ---------- preview / commit ----------

function uniquePath(target: string, own?: string): string {
  if (!fsSync.existsSync(target) || (own && path.resolve(own) === path.resolve(target))) return target;
  const { dir, name, ext } = path.parse(target);
  for (let i = 2; i < 100; i++) {
    const t = path.join(dir, `${name} (${i})${ext}`);
    if (!fsSync.existsSync(t)) return t;
  }
  throw new Error('Não foi possível gerar um nome livre');
}

export function normalizeMeta(m: Partial<Meta>): Meta {
  const authors = (m.authors ?? []).map((a) => a.trim()).filter(Boolean);
  const num = (v: unknown) => (v === '' || v == null || Number.isNaN(Number(v)) ? undefined : Number(v));
  return {
    title: m.title?.trim() || undefined,
    subtitle: m.subtitle?.trim() || undefined,
    authors,
    series: m.series?.trim() || undefined,
    seriesIndex: m.series?.trim() ? num(m.seriesIndex) : undefined,
    publisher: m.publisher?.trim() || undefined,
    year: num(m.year),
    isbn: m.isbn?.replace(/[^0-9Xx]/g, '').toUpperCase() || undefined,
    language: m.language?.trim() || undefined,
    description: m.description?.trim() || undefined,
    tags: [...new Set((m.tags ?? []).map((t) => t.trim()).filter(Boolean))],
    pages: num(m.pages),
  };
}

export function findDuplicates(s: StagingItem, meta: Meta): Pick<BookRow, 'id' | 'title' | 'authors' | 'path'>[] {
  const rows = db.prepare('select id, title, authors, path, hash from books where missing = 0').all() as any[];
  const t = norm(meta.title);
  const a = norm(meta.authors[0]);
  return rows.filter((r) => r.id !== s.book_id && ((s.hash && r.hash === s.hash) || (t && norm(r.title) === t && norm(r.authors.split(';')[0]) === a)));
}

export function previewCommit(id: number, rawMeta: Partial<Meta>) {
  const s = getStaging(id);
  if (!s) throw new Error('Item não encontrado');
  const { booksDir, nameTemplate, useFolders } = getSettings();
  if (!booksDir) throw Object.assign(new Error('Defina a pasta Livros em Ajustes antes de salvar.'), { statusCode: 400 });
  const meta = normalizeMeta(rawMeta);
  const rel = buildRelPath(meta, s.format, { template: nameTemplate, useFolders });
  const own = s.book_id ? getBook(s.book_id)?.path : undefined;
  const target = uniquePath(path.join(booksDir, rel), own);
  const warnings: string[] = [];
  const book = s.book_id ? getBook(s.book_id) : undefined;
  if (book?.sent_to_kindle) warnings.push('Este livro já foi enviado ao Kindle: renomear ou editar faz o KOReader tratá-lo como livro novo (notas e progresso ficam no arquivo antigo).');
  if (!WRITABLE.has(s.format)) warnings.push(`Metadados não podem ser gravados dentro de arquivos .${s.format}: só o nome e a organização em pastas serão aplicados.`);
  if (!meta.title) warnings.push('Sem título.');
  if (!meta.authors.length) warnings.push('Sem autor: o arquivo vai para "Autor Desconhecido".');
  return {
    fileName: path.basename(target),
    relPath: path.relative(booksDir, target),
    targetPath: target,
    before: { name: s.original_name, path: s.path },
    duplicates: findDuplicates(s, meta),
    warnings,
    sentToKindle: !!book?.sent_to_kindle,
  };
}

export interface CommitOptions {
  meta: Partial<Meta>;
  sources?: Record<string, string>;
  coverUrl?: string | null;
  moveOriginal?: boolean;
  force?: boolean;
}

export async function commitStaging(id: number, opts: CommitOptions): Promise<BookRow> {
  const s = getStaging(id);
  if (!s) throw new Error('Item não encontrado');
  const { booksDir, moveOriginals } = getSettings();
  const prev = s.book_id ? getBook(s.book_id) : undefined;
  if (prev?.sent_to_kindle && !opts.force) throw new Error('KINDLE_SENT');

  const pv = previewCommit(id, opts.meta);
  if (pv.duplicates.length && !opts.force) throw new Error('DUPLICATE');
  const meta = normalizeMeta(opts.meta);
  const target = pv.targetPath;

  let cover: Cover | undefined;
  if (opts.coverUrl) cover = (await downloadCover(opts.coverUrl)) ?? undefined;

  const original = await fs.readFile(s.path);
  const out = await applyMeta(original, s.format, meta, cover);
  await fs.mkdir(path.dirname(target), { recursive: true });

  // keep a recoverable copy of whatever this replaces
  let backup: string | null = null;
  if (prev && fsSync.existsSync(prev.path)) {
    backup = path.join(TRASH_DIR, `${Date.now()}-${path.basename(prev.path)}`);
    await fs.copyFile(prev.path, backup);
  }
  const tmp = `${target}.bookflix-tmp`;
  await fs.writeFile(tmp, out);
  await fs.rename(tmp, target);
  if (prev && path.resolve(prev.path) !== path.resolve(target)) {
    await fs.rm(prev.path, { force: true });
    await pruneEmptyDirs(path.dirname(prev.path), booksDir);
  }

  const hash = await partialMd5(target);
  const stat = await fs.stat(target);
  const sources = { ...(opts.sources ?? {}) };
  let coverName: string | null = prev?.cover ?? null;
  const finalCover = cover ?? (s.format === 'epub' ? (await readMeta(target)).cover : undefined);
  if (finalCover) coverName = await saveCover(hash, finalCover);
  else if (s.cover) coverName = await saveCover(hash, { data: await fs.readFile(path.join(COVERS_DIR, s.cover)), ext: path.extname(s.cover).slice(1) as Cover['ext'] });

  const bookId = tx(() => {
    let bid: number;
    if (prev) {
      const cols = { ...metaColumns(meta, sources), path: target, rel_path: toRel(booksDir, target), filename: path.basename(target), size: stat.size, hash, cover: coverName, organized: 1, missing: 0 };
      db.prepare(`update books set ${Object.keys(cols).map((k) => `${k} = :${k}`).join(', ')} where id = :id`).run(clean({ ...cols, id: prev.id }));
      bid = prev.id;
      reindexBook(bid);
    } else {
      bid = insertBook(target, stat.size, hash, meta, sources, { organized: 1, cover: coverName } as Partial<BookRow>);
    }
    db.prepare('insert into history(action, book_id, new_path, old_path, backup_path, snapshot, at) values(?,?,?,?,?,?,?)').run(
      prev ? 'reorganize' : 'add',
      bid,
      target,
      prev ? prev.path : s.source === 'library' ? null : s.path,
      backup,
      prev ? JSON.stringify(prev) : null,
      now(),
    );
    db.prepare('delete from recs where book_id = ?').run(bid);
    return bid;
  });

  // original handling
  if (!s.owned && s.source === 'inbox' && (opts.moveOriginal ?? moveOriginals)) await fs.rm(s.path, { force: true });
  await cleanupStaging(s).catch(() => {});
  return getBook(bookId)!;
}

async function pruneEmptyDirs(dir: string, stopAt: string) {
  const root = path.resolve(stopAt);
  let cur = path.resolve(dir);
  while (cur.startsWith(root) && cur !== root) {
    try {
      if ((await fs.readdir(cur)).length) return;
      await fs.rmdir(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

export function listHistory(limit = 50) {
  return db
    .prepare('select h.*, b.title as title from history h left join books b on b.id = h.book_id order by h.id desc limit ?')
    .all(limit);
}

export async function undoHistory(id: number) {
  const h = db.prepare('select * from history where id = ?').get(id) as any;
  if (!h || h.undone) throw new Error('Nada para desfazer');
  const book = h.book_id ? getBook(h.book_id) : undefined;
  if (h.action === 'add') {
    if (book?.sent_to_kindle) throw new Error('Livro já enviado ao Kindle: remova-o manualmente.');
    if (h.new_path) await fs.rm(h.new_path, { force: true });
    if (book?.cover) await fs.rm(path.join(COVERS_DIR, book.cover), { force: true });
    if (book) db.prepare('delete from books where id = ?').run(book.id);
    db.prepare('delete from books_fts where rowid = ?').run(h.book_id);
  } else if (h.action === 'reorganize') {
    const snap = JSON.parse(h.snapshot) as BookRow;
    if (!h.backup_path || !fsSync.existsSync(h.backup_path)) throw new Error('Backup do arquivo anterior não existe mais.');
    // the snapshot may predate a move of the library folder: prefer its folder-relative path
    const root = getSettings().booksDir;
    const snapPath = snap.rel_path && root ? toAbs(root, snap.rel_path) : snap.path;
    if (h.new_path && path.resolve(h.new_path) !== path.resolve(snapPath)) await fs.rm(h.new_path, { force: true });
    await fs.mkdir(path.dirname(snapPath), { recursive: true });
    await fs.copyFile(h.backup_path, snapPath);
    const cols = {
      ...metaColumns({ title: snap.title ?? undefined, subtitle: snap.subtitle ?? undefined, authors: snap.authors ? snap.authors.split('; ') : [], series: snap.series ?? undefined, seriesIndex: snap.series_index ?? undefined, publisher: snap.publisher ?? undefined, year: snap.year ?? undefined, isbn: snap.isbn ?? undefined, language: snap.language ?? undefined, description: snap.description ?? undefined, tags: snap.tags, pages: snap.pages ?? undefined }, snap.sources),
      path: snapPath, rel_path: toRel(root, snapPath) ?? snap.rel_path ?? null, filename: snap.filename, size: snap.size, hash: snap.hash, cover: snap.cover, organized: snap.organized,
    };
    db.prepare(`update books set ${Object.keys(cols).map((k) => `${k} = :${k}`).join(', ')} where id = :id`).run(clean({ ...cols, id: snap.id }));
    reindexBook(snap.id);
  }
  db.prepare('update history set undone = 1 where id = ?').run(id);
}

// ---------- inbox watcher ----------

let inboxWatcher: FSWatcher | null = null;

export function watchInbox() {
  inboxWatcher?.close();
  const { inboxDir } = getSettings();
  if (!inboxDir || !fsSync.existsSync(inboxDir)) return;
  const handled = (p: string) => !!db.prepare("select 1 from history where action = 'add' and old_path = ?").get(p);
  inboxWatcher = chokidar.watch(inboxDir, { ignoreInitial: false, depth: 3, awaitWriteFinish: { stabilityThreshold: 1500 } });
  inboxWatcher.on('add', (p) => {
    if (!isBookFile(p) || handled(p)) return;
    void createStaging({ file: p, owned: false, source: 'inbox' }).catch(() => {});
  });
  inboxWatcher.on('unlink', (p) => {
    const s = db.prepare("select id from staging where path = ? and source = 'inbox'").get(p) as { id: number } | undefined;
    if (s) void discardStaging(s.id);
  });
}
