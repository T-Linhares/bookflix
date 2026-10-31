import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { db, getBook, getSetting, setSetting } from '../db.ts';

export const KINDLE_BOOKS_DIR = 'Livros';

export interface SendResult {
  root: string;
  dest: string;
  copied: string[];
  already: string[];
  /** same file name already on the Kindle but with a different size: left untouched */
  conflicts: string[];
  /** books that could not be sent, with the reason */
  failed: { id: number; title: string; reason: string }[];
}

/** A mounted Kindle has `documents` plus `system` (stock firmware) or `koreader`; a random USB stick with a `documents` folder does not. */
export function isKindleRoot(root: string): boolean {
  const has = (d: string) => fsSync.existsSync(path.join(root, d));
  return has('documents') && (has('system') || has('koreader'));
}

export interface DetectOptions {
  platform?: NodeJS.Platform;
  /** folders that contain mounted volumes (tests inject a fake tree here); ignored on Windows */
  bases?: string[];
}

const subdirs = (dir: string): string[] => {
  try {
    return fsSync.readdirSync(dir).map((d) => path.join(dir, d));
  } catch {
    return []; // does not exist or is not readable
  }
};

/** Last used Kindle if it is still plugged in, otherwise the first drive that looks like one. */
export function detectKindle({ platform = process.platform, bases }: DetectOptions = {}): string | null {
  const last = getSetting<string>('lastKindleRoot');
  if (last && isKindleRoot(last)) return last;
  const roots: string[] = [];
  if (platform === 'win32') for (let c = 68; c <= 90; c++) roots.push(`${String.fromCharCode(c)}:\\`);
  else {
    // macOS mounts at /Volumes/<label>; Linux desktops at /media/<user>/<label> or /run/media/<user>/<label>
    for (const base of bases ?? (platform === 'darwin' ? ['/Volumes'] : ['/media', '/run/media'])) {
      const level1 = subdirs(base);
      roots.push(...level1);
      if (platform !== 'darwin') for (const user of level1) roots.push(...subdirs(user));
    }
  }
  return roots.find(isKindleRoot) ?? null;
}

/** documents/Livros, matching an existing folder regardless of case; created when missing. */
async function booksDir(root: string): Promise<string> {
  const docs = path.join(root, 'documents');
  const existing = (await fs.readdir(docs, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.toLowerCase() === KINDLE_BOOKS_DIR.toLowerCase());
  const dir = path.join(docs, existing?.name ?? KINDLE_BOOKS_DIR);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function sendToKindle(bookIds: number[], root?: string): Promise<SendResult> {
  const kindle = root || detectKindle();
  if (!kindle) throw Object.assign(new Error('Kindle não encontrado. Conecte-o por USB ou informe a unidade (ex.: E:\\).'), { statusCode: 400 });
  if (!fsSync.existsSync(path.join(kindle, 'documents'))) {
    throw Object.assign(new Error(`A pasta "documents" não existe em ${kindle}: essa unidade não parece ser um Kindle.`), { statusCode: 400 });
  }
  const dest = await booksDir(kindle);
  setSetting('lastKindleRoot', kindle);

  const out: SendResult = { root: kindle, dest, copied: [], already: [], conflicts: [], failed: [] };
  const mark = db.prepare('update books set sent_to_kindle = 1 where id = ?');
  for (const id of bookIds) {
    const book = getBook(id);
    if (!book) continue;
    const title = book.title || book.filename;
    try {
      if (book.missing || !fsSync.existsSync(book.path)) {
        out.failed.push({ id, title, reason: 'arquivo não encontrado na biblioteca' });
        continue;
      }
      const name = path.basename(book.path);
      const target = path.join(dest, name);
      if (fsSync.existsSync(target)) {
        if (fsSync.statSync(target).size === fsSync.statSync(book.path).size) {
          out.already.push(name);
          mark.run(id);
        } else out.conflicts.push(name);
        continue;
      }
      await fs.copyFile(book.path, target);
      out.copied.push(name);
      mark.run(id);
    } catch (e) {
      out.failed.push({ id, title, reason: (e as Error).message });
    }
  }
  return out;
}

/** Books organized in the app that were never sent. */
export function readyBookIds(): number[] {
  return (db.prepare('select id from books where missing = 0 and organized = 1 and sent_to_kindle = 0 order by added_at').all() as { id: number }[]).map((r) => r.id);
}
