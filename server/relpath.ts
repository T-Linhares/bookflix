import path from 'node:path';
import { db } from './db.ts';
import { getSettings } from './settings.ts';

/**
 * `books.rel_path` is the stable identity of a file inside the library folder ("Autor/Série/Autor - Título.epub",
 * always with "/"). `books.path` stays the absolute path the rest of the server uses, but it is only a cache:
 * reconcilePaths() rebuilds it from rel_path when the library folder moves (new drive letter, another machine,
 * Drive -> Dropbox) and fills rel_path for books that were registered before it existed.
 */

/** Path of `file` relative to `root` with "/" separators, or null when it is not inside `root`. */
export function toRel(root: string, file: string): string | null {
  if (!root) return null;
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

export function toAbs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

/** Idempotent. Books outside the library folder keep rel_path null and their absolute path untouched. */
export function reconcilePaths(root: string = getSettings().booksDir): void {
  if (!root) return;
  const rows = db.prepare('select id, path, rel_path from books').all() as { id: number; path: string; rel_path: string | null }[];
  const setRel = db.prepare('update books set rel_path = ? where id = ?');
  const setPath = db.prepare('update books set path = ? where id = ?');
  for (const b of rows) {
    const rel = toRel(root, b.path);
    if (rel !== null) {
      if (rel !== b.rel_path) setRel.run(rel, b.id);
    } else if (b.rel_path) {
      setPath.run(toAbs(root, b.rel_path), b.id);
    }
  }
}
