import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db } from '../server/db.ts';
import { makePng } from './helpers.ts';

let app: FastifyInstance;
let tmp: string;
const json = (r: { body: string }) => JSON.parse(r.body);

function multipart(files: { name: string; data: Buffer }[]) {
  const boundary = '----bookflixss';
  const parts = files.flatMap((f) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    f.data,
    Buffer.from('\r\n'),
  ]);
  return { payload: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-ssapi-'));
  db.exec('delete from screensavers');
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('screensavers API', () => {
  let ids: string[] = [];

  it('uploads several files at once: images are kept, repeats and non-images are only counted', async () => {
    const one = makePng(6, 8, 1);
    const res = await app.inject({
      method: 'POST',
      url: '/api/screensavers/upload',
      ...multipart([
        { name: 'gato_preto.png', data: one },
        { name: 'copia.png', data: one },
        { name: 'onda.png', data: makePng(6, 9, 2) },
        { name: 'livro.pdf', data: Buffer.from('%PDF-1.4') },
      ]),
    });
    expect(res.statusCode).toBe(200);
    const r = json(res);
    expect(r).toMatchObject({ added: 2, duplicates: 1, skipped: 1 });
    ids = r.items.map((i: any) => i.id);
    expect(ids).toHaveLength(2);
  });

  it('lists with facets and serves the picture itself', async () => {
    const list = json(await app.inject({ method: 'GET', url: '/api/screensavers?per=12' }));
    expect(list.total).toBe(2);
    expect(list.facets.counts).toMatchObject({ all: 2, pending: 2, reviewed: 0 });
    expect(list.items.map((i: any) => i.name).sort()).toEqual(['gato preto', 'onda']);
    const img = await app.inject({ method: 'GET', url: list.items[0].url });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toMatch(/image\/png/);
  });

  it('edits, then reviews (alone or in bulk), then filters by what was set', async () => {
    const [a, b] = ids;
    const patched = await app.inject({ method: 'PATCH', url: `/api/screensavers/${a}`, payload: { name: 'Gato', tags: ['gatos', 'p&b'], device: 'kindle-paperwhite', favorite: true } });
    expect(patched.statusCode).toBe(200);
    expect(json(patched)).toMatchObject({ name: 'Gato', tags: ['gatos', 'p&b'], device: 'kindle-paperwhite', favorite: true, reviewed: false });

    const rev = json(await app.inject({ method: 'POST', url: '/api/screensavers/review', payload: { ids: [a, b] } }));
    expect(rev.reviewed).toBe(2);
    const fav = json(await app.inject({ method: 'GET', url: '/api/screensavers?status=fav&tag=gatos' }));
    expect(fav.items.map((i: any) => i.name)).toEqual(['Gato']);
    expect(fav.items[0].warning).toMatch(/menor/i); // 6x8 px on a Paperwhite
  });

  it('rejects bad input with a clear message', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/screensavers/naoexiste', payload: { name: 'x' } })).statusCode).toBe(404);
    const bad = await app.inject({ method: 'PATCH', url: `/api/screensavers/${ids[0]}`, payload: { device: 'geladeira' } });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toMatch(/dispositivo/i);
  });

  it('describes the devices it knows, with their resolution', async () => {
    const devices = json(await app.inject({ method: 'GET', url: '/api/screensavers/devices' }));
    expect(devices.find((d: any) => d.id === 'kindle-paperwhite')).toMatchObject({ label: 'Kindle Paperwhite', width: 1072, height: 1448 });
  });

  it('sends to koreader/screensavers on a Kindle and imports from the same folder', async () => {
    const kindle = path.join(tmp, 'kindle');
    fs.mkdirSync(path.join(kindle, 'documents'), { recursive: true });
    fs.mkdirSync(path.join(kindle, 'koreader'), { recursive: true });

    const info = json(await app.inject({ method: 'GET', url: `/api/screensavers/kindle?path=${encodeURIComponent(kindle)}` }));
    expect(info).toMatchObject({ root: kindle, exists: false, dir: path.join(kindle, 'koreader', 'screensavers'), count: 0 });

    const sent = json(await app.inject({ method: 'POST', url: '/api/screensavers/send', payload: { all: true, path: kindle } }));
    expect(sent.copied.sort()).toEqual(['Gato.png', 'onda.png']);
    expect(fs.readdirSync(path.join(kindle, 'koreader', 'screensavers')).sort()).toEqual(['Gato.png', 'onda.png']);

    fs.writeFileSync(path.join(kindle, 'koreader', 'screensavers', 'nova.png'), makePng(6, 8, 77));
    const imp = json(await app.inject({ method: 'POST', url: '/api/screensavers/import-folder', payload: { path: path.join(kindle, 'koreader', 'screensavers') } }));
    expect(imp).toMatchObject({ added: 1, duplicates: 2 }); // the two sent ones are already here
    expect(json(await app.inject({ method: 'GET', url: '/api/screensavers?status=pending' })).items.map((i: any) => i.name)).toEqual(['nova']);
  });

  it('asks for a Kindle when there is none to detect', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/screensavers/send', payload: { all: true, path: path.join(tmp, 'nada') } });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toMatch(/Kindle/);
  });

  it('deletes: gone from the list and from disk', async () => {
    const [a] = ids;
    expect((await app.inject({ method: 'DELETE', url: `/api/screensavers/${a}` })).statusCode).toBe(200);
    expect(json(await app.inject({ method: 'GET', url: '/api/screensavers' })).items.map((i: any) => i.id)).not.toContain(a);
    expect((await app.inject({ method: 'GET', url: `/screensavers/${a}.png` })).statusCode).toBe(404);
  });
});
