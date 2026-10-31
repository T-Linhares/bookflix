import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../server/db.ts';
import { SyncEngine } from '../server/sync.ts';
import { makePng } from './helpers.ts';

// Two computers = two databases + two local image folders. They only share the sync folder, like Drive/Dropbox would.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-sssync-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let shared: string;
const clock = { t: 1000 };
let n = 0;

interface Dev {
  id: string;
  db: DatabaseSync;
  dir: string;
  engine: SyncEngine;
}
const device = (id: string): Dev => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const dir = path.join(root, `${id}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return { id, db, dir, engine: new SyncEngine({ db, dir: shared, deviceId: id, now: () => clock.t, screensaverDir: dir }) };
};

const sha1 = (b: Buffer) => crypto.createHash('sha1').update(b).digest('hex');
/** What the app does when a picture is added: bytes in the local folder + a row. */
function addPic(d: Dev, png: Buffer, o: { name?: string; tags?: string[]; reviewed?: boolean; device?: string } = {}) {
  const id = sha1(png);
  fs.writeFileSync(path.join(d.dir, `${id}.png`), png);
  d.db
    .prepare('insert into screensavers(id, ext, name, tags, device, width, height, size, reviewed, source, added_at) values(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, 'png', o.name ?? 'sem nome', JSON.stringify(o.tags ?? []), o.device ?? null, 6, 8, png.length, o.reviewed === false ? 0 : 1, 'upload', 1);
  return id;
}
const row = (d: Dev, id: string) => d.db.prepare('select * from screensavers where id = ?').get(id) as any;
const edit = (d: Dev, id: string, patch: Record<string, unknown>) => {
  const keys = Object.keys(patch);
  d.db.prepare(`update screensavers set ${keys.map((k) => `${k} = :${k}`).join(', ')} where id = :__id`).run({ ...patch, __id: id } as any);
};
const sharedFile = (id: string) => path.join(shared, 'screensavers', `${id}.png`);

let A: Dev;
let B: Dev;
beforeEach(() => {
  shared = fs.mkdtempSync(path.join(root, 'shared-'));
  clock.t = 1000;
  A = device('aaa');
  B = device('bbb');
  A.engine.init('create');
  B.engine.init('join');
});

describe('screensavers travel through the sync folder', () => {
  it('a reviewed picture reaches the other computer with its data and exact bytes, under the same id', () => {
    const png = makePng(6, 8, 1);
    const id = addPic(A, png, { name: 'Onda', tags: ['japão', 'p&b'], device: 'kindle-paperwhite' });
    A.engine.sync();
    expect(fs.readFileSync(sharedFile(id))).toEqual(png);

    const s = B.engine.sync();
    expect(s.applied).toBeGreaterThan(0);
    expect(row(B, id)).toMatchObject({ id, name: 'Onda', device: 'kindle-paperwhite', reviewed: 1, deleted: 0, ext: 'png' });
    expect(JSON.parse(row(B, id).tags)).toEqual(['japão', 'p&b']);
    expect(fs.readFileSync(path.join(B.dir, `${id}.png`))).toEqual(png);
  });

  it('a picture still "to review" stays on its computer: nothing is written to the shared folder', () => {
    const id = addPic(A, makePng(6, 8, 2), { reviewed: false });
    A.engine.sync();
    B.engine.sync();
    expect(fs.existsSync(sharedFile(id))).toBe(false);
    expect(row(B, id)).toBeUndefined();
  });

  it('reviewing it later is what makes it travel', () => {
    const id = addPic(A, makePng(6, 8, 3), { reviewed: false, name: 'Rascunho' });
    A.engine.sync();
    B.engine.sync();
    clock.t = 2000;
    edit(A, id, { reviewed: 1, name: 'Final' });
    A.engine.sync();
    B.engine.sync();
    expect(row(B, id)).toMatchObject({ name: 'Final', reviewed: 1 });
  });

  it('the newest edit wins, in both directions', () => {
    const id = addPic(A, makePng(6, 8, 4), { name: 'Original' });
    A.engine.sync();
    B.engine.sync();
    clock.t = 2000;
    edit(B, id, { name: 'Editado no B', favorite: 1 });
    B.engine.sync();
    A.engine.sync();
    expect(row(A, id)).toMatchObject({ name: 'Editado no B', favorite: 1 });
    clock.t = 3000;
    edit(A, id, { name: 'Editado no A depois' });
    A.engine.sync();
    B.engine.sync();
    expect(row(B, id).name).toBe('Editado no A depois');
    expect(row(B, id).favorite).toBe(1);
  });

  it('a reviewed copy beats a copy still waiting for review on the other computer', () => {
    const png = makePng(6, 8, 5);
    const id = addPic(A, png, { name: 'Revisada no A', tags: ['x'] });
    addPic(B, png, { reviewed: false, name: 'arquivo_bruto' });
    A.engine.sync();
    B.engine.sync();
    expect(row(B, id)).toMatchObject({ name: 'Revisada no A', reviewed: 1 });
    expect(B.db.prepare('select count(*) c from screensavers').get()).toEqual({ c: 1 });
  });

  it('deleting on one computer removes it from the others and from the shared folder', () => {
    const id = addPic(A, makePng(6, 8, 6), { name: 'Vai embora' });
    A.engine.sync();
    B.engine.sync();
    expect(fs.existsSync(path.join(B.dir, `${id}.png`))).toBe(true);

    clock.t = 2000;
    edit(A, id, { deleted: 1 });
    fs.rmSync(path.join(A.dir, `${id}.png`));
    A.engine.sync();
    expect(fs.existsSync(sharedFile(id))).toBe(false);
    B.engine.sync();
    expect(row(B, id).deleted).toBe(1);
    expect(fs.existsSync(path.join(B.dir, `${id}.png`))).toBe(false);
  });

  it('a delete does not create the picture on a computer that never had it', () => {
    const id = addPic(A, makePng(6, 8, 7));
    A.engine.sync();
    clock.t = 2000;
    edit(A, id, { deleted: 1 });
    A.engine.sync();
    B.engine.sync();
    expect(fs.existsSync(path.join(B.dir, `${id}.png`))).toBe(false);
  });
});

describe('when the cloud has not finished', () => {
  it('waits (pending) while the image file has not arrived, then applies it', () => {
    const png = makePng(6, 8, 8);
    const id = addPic(A, png, { name: 'Demora' });
    A.engine.sync();
    const hold = fs.readFileSync(sharedFile(id));
    fs.rmSync(sharedFile(id)); // metadata arrived first
    const s1 = B.engine.sync();
    expect(s1.pending).toBeGreaterThan(0);
    expect(row(B, id)).toBeUndefined();

    fs.writeFileSync(sharedFile(id), hold);
    const s2 = B.engine.sync();
    expect(row(B, id)).toMatchObject({ name: 'Demora' });
    expect(s2.pending).toBe(0);
  });

  it('never accepts a half-downloaded or altered file: the bytes must hash to the id', () => {
    const id = addPic(A, makePng(6, 8, 9), { name: 'Cortada' });
    A.engine.sync();
    fs.writeFileSync(sharedFile(id), makePng(6, 8, 99)); // another picture under this id
    const s = B.engine.sync();
    expect(s.pending).toBeGreaterThan(0);
    expect(row(B, id)).toBeUndefined();
    expect(fs.existsSync(path.join(B.dir, `${id}.png`))).toBe(false);
  });

  it('repairs a missing shared file the next time the owner syncs', () => {
    const png = makePng(6, 8, 10);
    const id = addPic(A, png);
    A.engine.sync();
    fs.rmSync(sharedFile(id));
    A.engine.sync();
    expect(fs.readFileSync(sharedFile(id))).toEqual(png);
  });
});
