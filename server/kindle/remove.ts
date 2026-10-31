import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { db, getBook } from '../db.ts';
import { isBookFile, partialMd5 } from '../util.ts';
import { detectKindle, isKindleRoot } from './send.ts';

export interface RemovalItem {
  id: number;
  title: string;
  /** paths on the Kindle that will be deleted, relative to its root */
  targets: string[];
  /** why nothing will be deleted for this item, if so */
  note?: string;
  /** library books only: nothing is touched for this one (its library file is missing, so its Kindle copy cannot be told apart) */
  blocked?: boolean;
}

export interface RemovalResult {
  root: string;
  items: RemovalItem[];
  deleted: number;
  errors: string[];
}

/** Only these places may be touched: the books folder and KOReader's own sidecar folders. */
const allowedRoots = (root: string) => ['documents', 'koreader/docsettings', 'koreader/hashdocsettings'].map((d) => path.resolve(root, d));

function inside(parent: string, child: string) {
  const rel = path.relative(parent, path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function safeTarget(root: string, p: string): boolean {
  return allowedRoots(root).some((a) => inside(a, p));
}

/** partial md5 -> files for every book file under documents/ (KOReader identifies books by it). */
export async function indexBooks(root: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  async function rec(dir: string, depth: number) {
    if (depth > 7) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.endsWith('.sdr')) await rec(full, depth + 1);
      } else if (isBookFile(e.name)) {
        try {
          const md5 = await partialMd5(full);
          out.set(md5, [...(out.get(md5) ?? []), full]);
        } catch {
          // unreadable file: skip it
        }
      }
    }
  }
  await rec(path.join(root, 'documents'), 0);
  return out;
}

function resolveRoot(root?: string): string {
  const r = root || detectKindle();
  if (!r || !isKindleRoot(r)) throw Object.assign(new Error('Kindle não encontrado. Conecte-o por USB e tente de novo.'), { statusCode: 400 });
  return r;
}

/** What deleting these "unmatched" items would remove from the Kindle. Touches nothing. */
export async function planRemoval(ids: number[], root?: string): Promise<{ root: string; items: RemovalItem[] }> {
  const kindle = resolveRoot(root);
  const rows = db.prepare(`select * from unmatched where id in (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
  const needsIndex = rows.some((r) => !r.sdr_path && r.md5);
  const byMd5 = needsIndex ? await indexBooks(kindle) : new Map<string, string[]>();

  const items: RemovalItem[] = rows.map((r) => {
    const item: RemovalItem = { id: r.id, title: r.title, targets: [] };
    const add = (p: string) => {
      if (fsSync.existsSync(p) && safeTarget(kindle, p)) item.targets.push(path.relative(kindle, p));
    };
    if (r.sdr_path) {
      const sdr = String(r.sdr_path);
      // the path was saved when the book was imported: it may belong to another drive letter
      const here = inside(kindle, sdr) ? path.resolve(sdr) : path.join(kindle, path.relative(path.parse(sdr).root, sdr));
      add(here);
      if (here.endsWith('.sdr')) {
        // KOReader names the folder "Livro.sdr" for "Livro.epub" (older versions: "Livro.epub.sdr")
        const base = path.basename(here, '.sdr');
        const dir = path.dirname(here);
        try {
          for (const f of fsSync.readdirSync(dir, { withFileTypes: true })) {
            if (f.isFile() && isBookFile(f.name) && (f.name === base || f.name.replace(/\.[^.]+$/, '') === base)) add(path.join(dir, f.name));
          }
        } catch {
          // folder gone: nothing to add
        }
      }
    } else if (r.md5 && byMd5.has(r.md5)) {
      const file = byMd5.get(r.md5)!.at(-1)!;
      add(file);
      add(`${file.replace(/\.[^.\\/]+$/, '')}.sdr`);
      add(`${file}.sdr`);
    }
    item.targets = [...new Set(item.targets)];
    if (!item.targets.length) item.note = 'não há arquivo desse livro no Kindle (só o histórico de leitura do KOReader)';
    return item;
  });
  return { root: kindle, items };
}

/**
 * Deletes the planned files from the Kindle. Sidecar items disappear from the list; items that only exist in
 * KOReader's statistics are marked ignored, otherwise the next sync would list them again.
 */
export async function removeFromKindle(ids: number[], root?: string): Promise<RemovalResult> {
  const { root: kindle, items } = await planRemoval(ids, root);
  const result: RemovalResult = { root: kindle, items, deleted: 0, errors: [] };
  for (const item of items) {
    let failed = false;
    for (const rel of item.targets) {
      const full = path.join(kindle, rel);
      if (!safeTarget(kindle, full)) {
        failed = true;
        continue;
      }
      try {
        await fs.rm(full, { recursive: true, force: true });
        result.deleted++;
      } catch (e) {
        failed = true;
        result.errors.push(`${rel}: ${(e as Error).message}`);
      }
    }
    if (failed) continue;
    const row = db.prepare('select sdr_path from unmatched where id = ?').get(item.id) as { sdr_path: string | null } | undefined;
    if (row?.sdr_path) db.prepare('delete from unmatched where id = ?').run(item.id);
    else db.prepare('update unmatched set ignored = 1 where id = ?').run(item.id);
  }
  return result;
}

/**
 * What taking these library books off the Kindle would delete. The copy is found by content (the same partial md5
 * KOReader uses), so it is found even if renamed or moved, and a different file that merely has the same name is
 * never a target. Touches nothing.
 */
export async function planBookRemoval(ids: number[], root?: string): Promise<{ root: string; items: RemovalItem[] }> {
  const kindle = resolveRoot(root);
  const books = ids.map((id) => getBook(id)).filter((b): b is NonNullable<ReturnType<typeof getBook>> => !!b);
  const byMd5 = books.length ? await indexBooks(kindle) : new Map<string, string[]>();
  const items: RemovalItem[] = [];
  for (const b of books) {
    const item: RemovalItem = { id: b.id, title: b.title || b.filename, targets: [] };
    items.push(item);
    if (b.missing || !fsSync.existsSync(b.path)) {
      item.blocked = true;
      item.note = 'o arquivo deste livro não está na biblioteca, então não dá para saber qual é a cópia no Kindle';
      continue;
    }
    for (const file of byMd5.get(await partialMd5(b.path)) ?? []) if (safeTarget(kindle, file)) item.targets.push(path.relative(kindle, file));
    if (!item.targets.length) item.note = 'o livro já não está no Kindle; só a marca "No Kindle" será tirada';
  }
  return { root: kindle, items };
}

/**
 * Deletes the Kindle copies of library books and clears their "No Kindle" mark. The book in the library is not touched,
 * and neither are the notes and progress KOReader keeps next to it (.sdr), so sending it again picks up where it was.
 */
export async function removeBooksFromKindle(ids: number[], root?: string): Promise<RemovalResult> {
  const { root: kindle, items } = await planBookRemoval(ids, root);
  const result: RemovalResult = { root: kindle, items, deleted: 0, errors: [] };
  const clear = db.prepare('update books set sent_to_kindle = 0 where id = ?');
  for (const item of items) {
    if (item.blocked) continue;
    let failed = false;
    for (const rel of item.targets) {
      const full = path.join(kindle, rel);
      if (!safeTarget(kindle, full)) {
        failed = true;
        continue;
      }
      try {
        await fs.rm(full, { force: true });
        result.deleted++;
      } catch (e) {
        failed = true;
        result.errors.push(`${rel}: ${(e as Error).message}`);
      }
    }
    if (!failed) clear.run(item.id);
  }
  return result;
}
