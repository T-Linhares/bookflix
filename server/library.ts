import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { COVERS_DIR, BookRow, clean, db, getBook, reindexBook } from './db.ts';
import { Cover, Meta, formatOf, readMeta } from './formats/index.ts';
import { getSettings } from './settings.ts';
import { reconcilePaths, toRel } from './relpath.ts';
import { SYNC_DIRNAME } from './sync.ts';
import { scheduleSync } from './syncService.ts';
import { isBookFile, joinAuthors, now, partialMd5 } from './util.ts';

export async function saveCover(key: string, cover: Cover): Promise<string> {
  const name = `${key}.${cover.ext}`;
  await fs.writeFile(path.join(COVERS_DIR, name), cover.data);
  return name;
}

export async function downloadCover(url: string): Promise<Cover | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : type.includes('jp') ? 'jpg' : null;
    if (!ext) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 2000 || data.length > 8_000_000) return null; // tiny = "image not available" placeholder
    return { data, ext };
  } catch {
    return null;
  }
}

/** Maps editor metadata + provenance to DB columns. */
export function metaColumns(meta: Meta, sources: Record<string, string> = {}) {
  return {
    title: meta.title ?? null,
    subtitle: meta.subtitle ?? null,
    authors: joinAuthors(meta.authors),
    series: meta.series ?? null,
    series_index: meta.seriesIndex ?? null,
    publisher: meta.publisher ?? null,
    year: meta.year ?? null,
    isbn: meta.isbn ?? null,
    language: meta.language ?? null,
    description: meta.description ?? null,
    tags: JSON.stringify(meta.tags ?? []),
    pages: meta.pages ?? null,
    sources: JSON.stringify(sources),
  };
}

export function insertBook(file: string, size: number, hash: string | null, meta: Meta, sources: Record<string, string>, extra: Partial<BookRow> = {}): number {
  const cols = {
    path: file,
    rel_path: toRel(getSettings().booksDir, file),
    filename: path.basename(file),
    format: formatOf(file),
    size,
    hash,
    added_at: now(),
    ...metaColumns(meta, sources),
    ...extra,
  };
  const keys = Object.keys(cols);
  const res = db
    .prepare(`insert into books(${keys.join(',')}) values(${keys.map((k) => `:${k}`).join(',')})`)
    .run(clean(cols as Record<string, unknown>));
  const id = Number(res.lastInsertRowid);
  reindexBook(id);
  return id;
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.sdr')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 8) yield* walk(full, depth + 1);
    } else if (isBookFile(e.name)) yield full;
  }
}

export interface ScanResult {
  added: number;
  moved: number;
  missing: number;
  duplicates: number;
}

let scanning: Promise<ScanResult> | null = null;

/** Registers every book file under booksDir that the app does not know yet. */
export function scanLibrary(): Promise<ScanResult> {
  scanning ??= doScan().finally(() => {
    scanning = null;
  });
  return scanning;
}

async function doScan(): Promise<ScanResult> {
  const res: ScanResult = { added: 0, moved: 0, missing: 0, duplicates: 0 };
  const { booksDir } = getSettings();
  if (!booksDir || !fsSync.existsSync(booksDir)) return res;

  // library folder moved (other drive letter, Drive -> Dropbox, another machine): re-point books by rel_path
  reconcilePaths(booksDir);

  const known = new Map<string, number>(
    (db.prepare('select id, path from books').all() as { id: number; path: string }[]).map((r) => [r.path, r.id]),
  );
  const seen = new Set<string>();

  for await (const file of walk(booksDir)) {
    seen.add(file);
    if (known.has(file)) {
      db.prepare('update books set missing = 0 where id = ? and missing = 1').run(known.get(file)!);
      continue;
    }
    const stat = await fs.stat(file);
    const hash = await partialMd5(file);
    const same = db.prepare('select id, path from books where hash = ?').all(hash) as { id: number; path: string }[];
    const gone = same.find((s) => !fsSync.existsSync(s.path));
    if (gone) {
      db.prepare('update books set path = ?, rel_path = ?, filename = ?, missing = 0 where id = ?').run(file, toRel(booksDir, file), path.basename(file), gone.id);
      res.moved++;
      continue;
    }
    if (same.length) {
      res.duplicates++;
      continue;
    }
    const { meta, cover, sources } = await readMeta(file);
    const id = insertBook(file, stat.size, hash, meta, sources);
    if (cover) db.prepare('update books set cover = ? where id = ?').run(await saveCover(hash, cover), id);
    res.added++;
  }

  for (const [p, id] of known) {
    if (!seen.has(p) && !fsSync.existsSync(p)) {
      db.prepare('update books set missing = 1 where id = ?').run(id);
      res.missing++;
    }
  }
  // new files may be books other devices already have notes for
  if (res.added || res.moved) scheduleSync(2000);
  return res;
}

let watcher: FSWatcher | null = null;

/** Rescans (debounced) whenever the Drive folder changes, e.g. Drive sync brings in new files. */
export function watchLibrary() {
  watcher?.close();
  const { booksDir } = getSettings();
  if (!booksDir || !fsSync.existsSync(booksDir)) return;
  let timer: NodeJS.Timeout | undefined;
  // the sync folder changes every time a device syncs: watching it would rescan the library in a loop
  watcher = chokidar.watch(booksDir, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 2000 }, depth: 8, ignored: (p) => p.includes(SYNC_DIRNAME) });
  watcher.on('all', (_ev, p) => {
    if (!isBookFile(p) && !fsSync.existsSync(p)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scanLibrary().catch(() => {}), 1500);
  });
}

export function bookExists(id: number) {
  return !!getBook(id);
}
