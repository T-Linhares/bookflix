import { beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../server/db.ts';
import {
  SCREENSAVERS_DIR,
  addImage,
  imageInfo,
  importFolder,
  listScreensavers,
  removeScreensaver,
  reviewScreensavers,
  screensaverDirOn,
  sendScreensavers,
  sizeWarning,
  updateScreensaver,
} from '../server/screensavers.ts';
import { makePng } from './helpers.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-ss-'));
const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
const jpeg = (w: number, h: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]);
const gif = (w: number, h: number) => Buffer.from([...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b]);
const bmp = (w: number, h: number) => {
  const b = Buffer.alloc(30);
  b.write('BM');
  b.writeInt32LE(w, 18);
  b.writeInt32LE(-h, 22); // top-down bitmaps store a negative height
  return b;
};

beforeEach(() => {
  db.exec('delete from screensavers');
  fs.rmSync(SCREENSAVERS_DIR, { recursive: true, force: true });
  fs.mkdirSync(SCREENSAVERS_DIR, { recursive: true });
});

describe('image detection', () => {
  it('reads type and size from the bytes, whatever the file is called', () => {
    expect(imageInfo(makePng(6, 8))).toEqual({ ext: 'png', width: 6, height: 8 });
    expect(imageInfo(jpeg(300, 400))).toEqual({ ext: 'jpg', width: 300, height: 400 });
    expect(imageInfo(gif(20, 30))).toEqual({ ext: 'gif', width: 20, height: 30 });
    expect(imageInfo(bmp(40, 50))).toEqual({ ext: 'bmp', width: 40, height: 50 });
  });
  it('rejects anything that is not an image', () => {
    expect(imageInfo(Buffer.from('%PDF-1.4 not an image'))).toBeNull();
    expect(imageInfo(Buffer.from('hello'))).toBeNull();
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
  });
});

describe('adding images', () => {
  it('uses the sha1 of the bytes as id, stores the file and starts it as "to review"', () => {
    const png = makePng(6, 8, 1);
    const { item, created } = addImage(png, { name: 'minha_onda.png', source: 'upload' });
    expect(created).toBe(true);
    expect(item.id).toBe(sha1(png));
    expect(item).toMatchObject({ name: 'minha onda', ext: 'png', width: 6, height: 8, reviewed: false, favorite: false, tags: [], size: png.length });
    expect(fs.readFileSync(path.join(SCREENSAVERS_DIR, `${item.id}.png`))).toEqual(png);
  });

  it('never stores the same picture twice, even under another name', () => {
    const png = makePng(6, 8, 2);
    const a = addImage(png, { name: 'a.png', source: 'upload' });
    const b = addImage(png, { name: 'outro nome.png', source: 'folder' });
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.item.name).toBe('a'); // the first name is kept
    expect(listScreensavers({}).total).toBe(1);
  });

  it('trusts the bytes: a PNG named .jpg is stored as png', () => {
    expect(addImage(makePng(6, 8, 3), { name: 'x.jpg', source: 'upload' }).item.ext).toBe('png');
  });

  it('refuses what is not an image', () => {
    expect(() => addImage(Buffer.from('%PDF-1.4'), { name: 'livro.pdf', source: 'upload' })).toThrow(/imagem/i);
  });

  it('a picture that was deleted comes back as a new one to review', () => {
    const png = makePng(6, 8, 4);
    const { item } = addImage(png, { name: 'volta.png', source: 'upload' });
    reviewScreensavers([item.id]);
    removeScreensaver(item.id);
    expect(listScreensavers({}).total).toBe(0);
    const again = addImage(png, { name: 'volta.png', source: 'upload' });
    expect(again.created).toBe(true);
    expect(again.item).toMatchObject({ id: item.id, reviewed: false });
    expect(fs.existsSync(path.join(SCREENSAVERS_DIR, `${item.id}.png`))).toBe(true);
  });
});

describe('listing like the site: search, tags, device, sort, pages', () => {
  const add = (seed: number, name: string, patch: Record<string, unknown> = {}, review = false) => {
    const { item } = addImage(makePng(6 + seed, 8, seed), { name: `${name}.png`, source: 'upload' });
    updateScreensaver(item.id, patch);
    if (review) reviewScreensavers([item.id]);
    return item.id;
  };

  it('filters by tag, device, status, favorites and accent-free search, and counts facets', () => {
    add(1, 'Gatos', { tags: ['Preto e branco', 'gatos'], device: 'kindle-paperwhite', favorite: true }, true);
    add(2, 'Onda de Kanagawa', { tags: ['Preto e branco', 'japão'], device: 'kobo-libra' }, true);
    add(3, 'Floresta', { tags: ['colorido'], device: 'kindle-paperwhite' });

    expect(listScreensavers({}).total).toBe(3);
    expect(listScreensavers({ tag: 'preto e branco' }).total).toBe(2); // case-insensitive
    expect(listScreensavers({ device: 'kindle-paperwhite' }).total).toBe(2);
    expect(listScreensavers({ status: 'pending' }).items.map((i) => i.name)).toEqual(['Floresta']);
    expect(listScreensavers({ status: 'reviewed' }).total).toBe(2);
    expect(listScreensavers({ status: 'fav' }).items.map((i) => i.name)).toEqual(['Gatos']);
    expect(listScreensavers({ q: 'japao' }).items.map((i) => i.name)).toEqual(['Onda de Kanagawa']); // matches tag "japão"
    expect(listScreensavers({ q: 'kanagawa', tag: 'gatos' }).total).toBe(0);

    const { facets } = listScreensavers({});
    expect(facets.tags[0]).toEqual({ name: 'Preto e branco', count: 2 });
    expect(facets.tags.map((t) => t.name)).toEqual(expect.arrayContaining(['gatos', 'japão', 'colorido']));
    expect(facets.devices).toEqual(expect.arrayContaining([{ id: 'kindle-paperwhite', label: 'Kindle Paperwhite', count: 2 }, { id: 'kobo-libra', label: 'Kobo Libra', count: 1 }]));
    expect(facets.counts).toEqual({ all: 3, pending: 1, reviewed: 2, fav: 1 });
  });

  it('sorts and paginates', () => {
    ['c', 'a', 'b', 'd', 'e'].forEach((n, i) => add(i + 1, n));
    expect(listScreensavers({ sort: 'name' }).items.map((i) => i.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const p2 = listScreensavers({ sort: 'name', per: 2, page: 2 });
    expect(p2.items.map((i) => i.name)).toEqual(['c', 'd']);
    expect(p2).toMatchObject({ total: 5, page: 2, pages: 3 });
    expect(listScreensavers({ per: 2, page: 99 }).page).toBe(3); // out-of-range pages are clamped
  });

  it('normalises tags (trim, no repeats ignoring case, no blanks)', () => {
    const id = add(1, 'x');
    updateScreensaver(id, { tags: ['  Gato ', 'gato', '', 'Noite'] });
    expect(listScreensavers({}).items[0].tags).toEqual(['Gato', 'Noite']);
  });
});

describe('review and delete', () => {
  it('review marks as reviewed and can set fields at once', () => {
    const { item } = addImage(makePng(6, 8, 5), { name: 'r.png', source: 'upload' });
    reviewScreensavers([item.id], { name: 'Revisada', tags: ['a', 'b'] });
    expect(listScreensavers({}).items[0]).toMatchObject({ name: 'Revisada', tags: ['a', 'b'], reviewed: true });
  });

  it('an unreviewed picture is removed completely; a reviewed one leaves a mark so other computers delete it too', () => {
    const a = addImage(makePng(6, 8, 6), { name: 'a.png', source: 'upload' }).item;
    const b = addImage(makePng(6, 8, 7), { name: 'b.png', source: 'upload' }).item;
    reviewScreensavers([b.id]);
    removeScreensaver(a.id);
    removeScreensaver(b.id);
    expect(db.prepare('select count(*) c from screensavers where id = ?').get(a.id)).toEqual({ c: 0 });
    expect(db.prepare('select deleted, reviewed from screensavers where id = ?').get(b.id)).toEqual({ deleted: 1, reviewed: 1 });
    expect(fs.readdirSync(SCREENSAVERS_DIR)).toEqual([]);
  });
});

describe('import from a folder (koreader/screensavers)', () => {
  it('adds the images, skips other files, counts repeats and leaves them to review', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'um.png'), makePng(6, 8, 10));
    fs.writeFileSync(path.join(dir, 'dois.PNG'), makePng(6, 8, 11));
    fs.writeFileSync(path.join(dir, 'copia.png'), makePng(6, 8, 10)); // same bytes as um.png
    fs.writeFileSync(path.join(dir, 'leia-me.txt'), 'oi');
    fs.writeFileSync(path.join(dir, 'falso.png'), 'isto nao e uma imagem');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'tres.jpg'), jpeg(30, 40));

    const r = await importFolder(dir);
    expect(r).toMatchObject({ found: 5, added: 3, duplicates: 1, skipped: 1 });
    expect(r.errors).toEqual([]);
    expect(listScreensavers({ status: 'pending' }).total).toBe(3);
    const names = listScreensavers({}).items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['dois', 'tres']));
    expect(names).toHaveLength(3); // the third is "copia" or "um": whichever came first in the folder keeps its name
  });

  it('says clearly when the folder does not exist', async () => {
    await expect(importFolder(path.join(tmp(), 'nao-existe'))).rejects.toThrow(/Pasta não encontrada/);
  });
});

describe('the Kindle folder', () => {
  const kindle = (sub?: string) => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'documents'));
    fs.mkdirSync(path.join(root, 'koreader'));
    if (sub) fs.mkdirSync(path.join(root, 'koreader', sub));
    return root;
  };

  it('prefers koreader/screensavers, accepts the stock koreader/screensaver, and otherwise proposes creating screensavers', () => {
    const a = kindle('screensavers');
    expect(screensaverDirOn(a)).toEqual({ dir: path.join(a, 'koreader', 'screensavers'), exists: true });
    const b = kindle('screensaver');
    expect(screensaverDirOn(b)).toEqual({ dir: path.join(b, 'koreader', 'screensaver'), exists: true });
    const c = kindle();
    expect(screensaverDirOn(c)).toEqual({ dir: path.join(c, 'koreader', 'screensavers'), exists: false });
    const both = kindle('screensaver');
    fs.mkdirSync(path.join(both, 'koreader', 'screensavers'));
    expect(screensaverDirOn(both).dir).toBe(path.join(both, 'koreader', 'screensavers'));
  });

  it('sends the chosen pictures named after their title, once; a second send changes nothing', async () => {
    const root = kindle();
    const x = addImage(makePng(6, 8, 20), { name: 'Onda: Kanagawa?', source: 'upload' }).item;
    const y = addImage(makePng(6, 9, 21), { name: 'Gatos', source: 'upload' }).item;
    const r1 = await sendScreensavers([x.id, y.id], root);
    expect(r1.dest).toBe(path.join(root, 'koreader', 'screensavers'));
    expect(r1.copied.sort()).toEqual(['Gatos.png', 'Onda Kanagawa.png']);
    expect(fs.readFileSync(path.join(r1.dest, 'Gatos.png'))).toEqual(fs.readFileSync(path.join(SCREENSAVERS_DIR, `${y.id}.png`)));
    const r2 = await sendScreensavers([x.id, y.id], root);
    expect(r2.copied).toEqual([]);
    expect(r2.already.sort()).toEqual(['Gatos.png', 'Onda Kanagawa.png']);
  });

  it('two different pictures with the same title both get there (the second gets a short id)', async () => {
    const root = kindle();
    const a = addImage(makePng(6, 8, 22), { name: 'Igual', source: 'upload' }).item;
    const b = addImage(makePng(6, 8, 23), { name: 'Igual', source: 'upload' }).item;
    const r = await sendScreensavers([a.id, b.id], root);
    expect(r.copied).toHaveLength(2);
    expect(new Set(fs.readdirSync(r.dest)).size).toBe(2);
    expect((await sendScreensavers([a.id, b.id], root)).copied).toEqual([]);
  });

  it('refuses a folder that is not a Kindle', async () => {
    await expect(sendScreensavers(['x'], tmp())).rejects.toThrow(/Kindle/);
  });
});

describe('resolution warning for the chosen device', () => {
  const item = (w: number, h: number, device: string | null) => ({ width: w, height: h, device });
  it('is quiet when it fits, speaks when the shape or size is off, and says nothing without a device', () => {
    expect(sizeWarning(item(1072, 1448, 'kindle-paperwhite'))).toBeNull();
    expect(sizeWarning(item(2144, 2896, 'kindle-paperwhite'))).toBeNull(); // bigger, same shape: the device scales it down
    expect(sizeWarning(item(600, 800, 'kindle-paperwhite'))).toMatch(/menor/i);
    expect(sizeWarning(item(1448, 1072, 'kindle-paperwhite'))).toMatch(/horizontal|formato/i);
    expect(sizeWarning(item(1000, 1000, 'kindle-paperwhite'))).toMatch(/formato/i);
    expect(sizeWarning(item(100, 100, null))).toBeNull();
    expect(sizeWarning(item(100, 100, 'other'))).toBeNull();
  });
});
