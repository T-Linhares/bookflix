import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { SCREENSAVERS_DIR, db } from './db.ts';
import { detectKindle, isKindleRoot } from './kindle/send.ts';
import { norm, now } from './util.ts';

export { SCREENSAVERS_DIR };

/** Pictures for e-reader screensavers (KOReader's koreader/screensavers folder and the like). */

export const MAX_IMAGE_BYTES = 60 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp)$/i;
const fail = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

export interface Device {
  id: string;
  label: string;
  /** typical screen in pixels, portrait; none for "Other" */
  width?: number;
  height?: number;
}
export const DEVICES: Device[] = [
  { id: 'kindle-paperwhite', label: 'Kindle Paperwhite', width: 1072, height: 1448 },
  { id: 'kindle-oasis', label: 'Kindle Oasis', width: 1264, height: 1680 },
  { id: 'kindle-scribe', label: 'Kindle Scribe', width: 1860, height: 2480 },
  { id: 'kindle', label: 'Kindle (básico)', width: 1072, height: 1448 },
  { id: 'kobo-libra', label: 'Kobo Libra', width: 1264, height: 1680 },
  { id: 'kobo-clara', label: 'Kobo Clara', width: 1072, height: 1448 },
  { id: 'kobo-sage', label: 'Kobo Sage', width: 1440, height: 1920 },
  { id: 'boox-note', label: 'Boox Note', width: 1404, height: 1872 },
  { id: 'boox-nova', label: 'Boox Nova', width: 1404, height: 1872 },
  { id: 'pocketbook', label: 'PocketBook', width: 1072, height: 1448 },
  { id: 'remarkable', label: 'reMarkable', width: 1404, height: 1872 },
  { id: 'other', label: 'Outro' },
];
const deviceOf = (id: string | null | undefined) => DEVICES.find((d) => d.id === id);

// ---------- reading the picture itself ----------

export interface ImageInfo {
  ext: 'png' | 'jpg' | 'gif' | 'bmp';
  width: number;
  height: number;
}

/** Type and size from the bytes; the file name is never trusted. */
export function imageInfo(b: Buffer): ImageInfo | null {
  const ok = (ext: ImageInfo['ext'], width: number, height: number) => (width > 0 && height > 0 ? { ext, width, height } : null);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return ok('png', b.readUInt32BE(16), b.readUInt32BE(20));
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return ok('gif', b.readUInt16LE(6), b.readUInt16LE(8));
  if (b.length >= 26 && b.toString('latin1', 0, 2) === 'BM') return ok('bmp', Math.abs(b.readInt32LE(18)), Math.abs(b.readInt32LE(22)));
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok('jpg', b.readUInt16BE(i + 7), b.readUInt16BE(i + 5));
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) i += marker === 0xff ? 1 : 2;
      else i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Says so when the picture will not fill the chosen device's screen well. */
export function sizeWarning(it: { width: number | null; height: number | null; device: string | null }): string | null {
  const d = deviceOf(it.device);
  if (!d?.width || !d.height || !it.width || !it.height) return null;
  const screen = `${d.width}×${d.height}`;
  if (it.width > it.height !== d.width > d.height) return `Imagem na horizontal: a tela deste dispositivo é vertical (${screen}), vai ficar com bordas ou cortada.`;
  const ratio = d.width / d.height;
  if (Math.abs(it.width / it.height - ratio) / ratio > 0.08) return `Formato diferente da tela (${screen}): vai ficar com bordas ou cortada.`;
  if (it.width < d.width || it.height < d.height) return `Resolução menor que a tela (${screen}): pode ficar com baixa nitidez.`;
  return null;
}

// ---------- the collection ----------

export interface Screensaver {
  id: string;
  name: string;
  ext: string;
  tags: string[];
  device: string | null;
  note: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  favorite: boolean;
  reviewed: boolean;
  added_at: number | null;
  source: string | null;
  url: string;
  warning: string | null;
}

const toItem = (r: any): Screensaver => {
  const item = {
    id: r.id,
    name: r.name ?? '',
    ext: r.ext,
    tags: JSON.parse(r.tags || '[]') as string[],
    device: r.device ?? null,
    note: r.note ?? null,
    width: r.width ?? null,
    height: r.height ?? null,
    size: r.size ?? null,
    favorite: !!r.favorite,
    reviewed: !!r.reviewed,
    added_at: r.added_at ?? null,
    source: r.source ?? null,
    url: `/screensavers/${r.id}.${r.ext}`,
  };
  return { ...item, warning: sizeWarning(item) };
};

const getRow = (id: string) => db.prepare('select * from screensavers where id = ?').get(id) as any;
const fileOf = (id: string, ext: string) => path.join(SCREENSAVERS_DIR, `${id}.${ext}`);

export function getScreensaver(id: string): Screensaver | undefined {
  const r = getRow(id);
  return r && !r.deleted ? toItem(r) : undefined;
}

/** Tags are trimmed, blanks dropped and repeats (ignoring case) kept once. */
export function cleanTagList(tags: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of Array.isArray(tags) ? tags : []) {
    const t = String(raw ?? '').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** "minha_onda.png" -> "minha onda" */
const cleanName = (file: string) => path.basename(file).replace(IMAGE_EXT, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || 'Sem nome';

export function addImage(buf: Buffer, o: { name?: string; source: string }): { item: Screensaver; created: boolean } {
  if (buf.length > MAX_IMAGE_BYTES) throw fail('Imagem grande demais (limite de 60 MB).', 400);
  const info = imageInfo(buf);
  if (!info) throw fail('O arquivo não é uma imagem PNG, JPEG, GIF ou BMP.', 400);
  const id = crypto.createHash('sha1').update(buf).digest('hex');
  const prev = getRow(id);
  if (prev && !prev.deleted) return { item: toItem(prev), created: false };

  fsSync.mkdirSync(SCREENSAVERS_DIR, { recursive: true });
  fsSync.writeFileSync(fileOf(id, info.ext), buf);
  if (prev) {
    // deleted before: it comes back as something new to review
    db.prepare('update screensavers set deleted = 0, reviewed = 0, ext = ?, width = ?, height = ?, size = ?, added_at = ?, source = ? where id = ?').run(info.ext, info.width, info.height, buf.length, now(), o.source, id);
  } else {
    db.prepare('insert into screensavers(id, ext, name, width, height, size, reviewed, source, added_at) values(?,?,?,?,?,?,0,?,?)').run(id, info.ext, cleanName(o.name ?? id.slice(0, 8)), info.width, info.height, buf.length, o.source, now());
  }
  return { item: toItem(getRow(id)), created: true };
}

export interface ListQuery {
  q?: string;
  tag?: string;
  device?: string;
  status?: 'all' | 'pending' | 'reviewed' | 'fav';
  sort?: 'recent' | 'name' | 'size';
  page?: number;
  per?: number;
}

export function listScreensavers(query: ListQuery) {
  const all = (db.prepare('select rowid as rid, * from screensavers where deleted = 0').all() as any[]).map((r) => ({ r, item: toItem(r) }));

  const tagCount = new Map<string, { name: string; count: number }>();
  const deviceCount = new Map<string, number>();
  for (const { item } of all) {
    for (const t of item.tags) {
      const k = norm(t);
      const e = tagCount.get(k);
      e ? e.count++ : tagCount.set(k, { name: t, count: 1 });
    }
    if (item.device) deviceCount.set(item.device, (deviceCount.get(item.device) ?? 0) + 1);
  }
  const facets = {
    tags: [...tagCount.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt')),
    devices: DEVICES.filter((d) => deviceCount.has(d.id)).map((d) => ({ id: d.id, label: d.label, count: deviceCount.get(d.id)! })),
    counts: {
      all: all.length,
      pending: all.filter((x) => !x.item.reviewed).length,
      reviewed: all.filter((x) => x.item.reviewed).length,
      fav: all.filter((x) => x.item.favorite).length,
    },
  };

  const words = norm(query.q).split(' ').filter(Boolean);
  const tag = query.tag ? norm(query.tag) : '';
  let rows = all.filter(({ item }) => {
    if (query.status === 'pending' && item.reviewed) return false;
    if (query.status === 'reviewed' && !item.reviewed) return false;
    if (query.status === 'fav' && !item.favorite) return false;
    if (query.device && item.device !== query.device) return false;
    if (tag && !item.tags.some((t) => norm(t) === tag)) return false;
    if (words.length) {
      const hay = norm(`${item.name} ${item.tags.join(' ')} ${item.note ?? ''}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const sort = query.sort ?? 'recent';
  rows = rows.sort((a, b) =>
    sort === 'name'
      ? a.item.name.localeCompare(b.item.name, 'pt', { sensitivity: 'base' })
      : sort === 'size'
        ? (b.item.size ?? 0) - (a.item.size ?? 0)
        : (b.item.added_at ?? 0) - (a.item.added_at ?? 0) || b.r.rid - a.r.rid,
  );

  const per = Math.min(100, Math.max(1, Math.floor(query.per ?? 24) || 24));
  const pages = Math.max(1, Math.ceil(rows.length / per));
  const page = Math.min(pages, Math.max(1, Math.floor(query.page ?? 1) || 1));
  return { items: rows.slice((page - 1) * per, page * per).map((x) => x.item), total: rows.length, page, pages, per, facets };
}

export interface Patch {
  name?: string;
  tags?: string[];
  device?: string | null;
  note?: string | null;
  favorite?: boolean;
}

function applyPatch(id: string, patch: Patch) {
  const sets: string[] = [];
  const p: Record<string, unknown> = { id };
  if (patch.name !== undefined && patch.name.trim()) (sets.push('name = :name'), (p.name = patch.name.trim()));
  if (patch.tags !== undefined) (sets.push('tags = :tags'), (p.tags = JSON.stringify(cleanTagList(patch.tags))));
  if (patch.device !== undefined) {
    if (patch.device && !deviceOf(patch.device)) throw fail('Dispositivo desconhecido.', 400);
    sets.push('device = :device');
    p.device = patch.device || null;
  }
  if (patch.note !== undefined) (sets.push('note = :note'), (p.note = patch.note?.trim() || null));
  if (patch.favorite !== undefined) (sets.push('favorite = :favorite'), (p.favorite = patch.favorite ? 1 : 0));
  if (sets.length) db.prepare(`update screensavers set ${sets.join(', ')} where id = :id`).run(p as any);
}

export function updateScreensaver(id: string, patch: Patch): Screensaver {
  if (!getScreensaver(id)) throw fail('Imagem não encontrada.', 404);
  applyPatch(id, patch);
  return getScreensaver(id)!;
}

/** Marks pictures as reviewed (the moment they start to sync), optionally setting fields on all of them. */
export function reviewScreensavers(ids: string[], patch: Patch = {}): number {
  let n = 0;
  for (const id of ids) {
    if (!getScreensaver(id)) continue;
    applyPatch(id, patch);
    n += Number(db.prepare('update screensavers set reviewed = 1 where id = ?').run(id).changes);
  }
  return n;
}

export function removeScreensaver(id: string): boolean {
  const r = getRow(id);
  if (!r || r.deleted) return false;
  fsSync.rmSync(fileOf(id, r.ext), { force: true });
  // a reviewed picture leaves a mark: that is how the other computers learn to delete it too
  if (r.reviewed) db.prepare('update screensavers set deleted = 1 where id = ?').run(id);
  else db.prepare('delete from screensavers where id = ?').run(id);
  return true;
}

// ---------- folders: importing from and sending to the e-reader ----------

async function imagesIn(dir: string, depth = 0): Promise<string[]> {
  const out: string[] = [];
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 2 && !e.name.startsWith('.')) out.push(...(await imagesIn(full, depth + 1)));
    } else if (IMAGE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

export interface FolderImport {
  folder: string;
  found: number;
  added: number;
  duplicates: number;
  skipped: number;
  errors: string[];
}

/** Brings every picture of a folder in. They start as "to review". */
export async function importFolder(dir: string): Promise<FolderImport> {
  if (!dir || !fsSync.existsSync(dir) || !fsSync.statSync(dir).isDirectory()) throw fail(`Pasta não encontrada: ${dir}`, 400);
  const files = await imagesIn(dir);
  const r: FolderImport = { folder: dir, found: files.length, added: 0, duplicates: 0, skipped: 0, errors: [] };
  for (const f of files) {
    try {
      const { created } = addImage(await fs.readFile(f), { name: path.basename(f), source: 'folder' });
      created ? r.added++ : r.duplicates++;
    } catch (e: any) {
      if (e?.statusCode === 400) r.skipped++;
      else r.errors.push(`${path.basename(f)}: ${e?.message ?? e}`);
    }
  }
  return r;
}

/** koreader/screensavers on a Kindle (also the stock "screensaver" when that is the one that exists). */
export function screensaverDirOn(root: string): { dir: string; exists: boolean } {
  const base = path.join(root, 'koreader');
  let names: string[] = [];
  try {
    names = fsSync.readdirSync(base);
  } catch {
    // no koreader folder
  }
  const find = (want: string) => names.find((n) => n.toLowerCase() === want && fsSync.statSync(path.join(base, n)).isDirectory());
  const found = find('screensavers') ?? find('screensaver');
  return found ? { dir: path.join(base, found), exists: true } : { dir: path.join(base, 'screensavers'), exists: false };
}

function kindleRoot(root?: string): string {
  const kindle = root || detectKindle();
  if (!kindle) throw fail('Kindle não encontrado. Conecte-o por USB ou informe a unidade (ex.: E:\\).', 400);
  if (!isKindleRoot(kindle)) throw fail(`${kindle} não parece ser um Kindle.`, 400);
  return kindle;
}

/** Where the Kindle keeps its screensavers, for the page ("Importar da pasta do Kindle"). root is null when no Kindle is plugged in. */
export async function kindleFolderInfo(root?: string) {
  const kindle = root || detectKindle();
  if (!kindle || !isKindleRoot(kindle)) return { root: null as string | null, dir: null as string | null, exists: false, count: 0, hasKoreader: false };
  const { dir, exists } = screensaverDirOn(kindle);
  return { root: kindle, dir, exists, count: exists ? (await imagesIn(dir)).length : 0, hasKoreader: fsSync.existsSync(path.join(kindle, 'koreader')) };
}

const fileSafe = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Sem nome';

export interface SendResult {
  root: string;
  dest: string;
  copied: string[];
  already: string[];
  failed: { id: string; name: string; reason: string }[];
}

/** Copies the pictures into the Kindle's screensaver folder, named after their title. Never overwrites a different file. */
export async function sendScreensavers(ids: string[], root?: string): Promise<SendResult> {
  const kindle = kindleRoot(root);
  if (!fsSync.existsSync(path.join(kindle, 'koreader'))) throw fail('Este Kindle não tem a pasta "koreader": os protetores de tela são do KOReader.', 400);
  const dest = screensaverDirOn(kindle).dir;
  await fs.mkdir(dest, { recursive: true });
  const out: SendResult = { root: kindle, dest, copied: [], already: [], failed: [] };
  for (const id of ids) {
    const item = getScreensaver(id);
    if (!item) continue;
    try {
      const bytes = await fs.readFile(fileOf(id, item.ext));
      const base = fileSafe(item.name);
      let done = false;
      for (const name of [`${base}.${item.ext}`, `${base} (${id.slice(0, 6)}).${item.ext}`]) {
        const target = path.join(dest, name);
        if (!fsSync.existsSync(target)) {
          await fs.writeFile(target, bytes);
          out.copied.push(name);
          done = true;
        } else if ((await fs.readFile(target)).equals(bytes)) {
          out.already.push(name);
          done = true;
        }
        if (done) break;
      }
      if (!done) out.failed.push({ id, name: item.name, reason: 'já existe um arquivo diferente com esse nome' });
    } catch (e: any) {
      out.failed.push({ id, name: item.name, reason: String(e?.message ?? e) });
    }
  }
  return out;
}

/** Ids that "send all" means: everything that is reviewed. */
export const reviewedIds = () => (db.prepare('select id from screensavers where deleted = 0 and reviewed = 1 order by added_at, rowid').all() as { id: string }[]).map((r) => r.id);
