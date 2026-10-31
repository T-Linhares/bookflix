import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SAMPLE as BASE } from './lua.test.ts';

// own title/md5 so the book never pairs with one left in the shared test database by another test file
const SAMPLE = BASE.replace('The Final Empire', 'Livro Fantasma de Teste').replace('Brandon Sanderson', 'Autor Fantasma').replace('abc123', 'fantasma-md5-unico');

let app: FastifyInstance;
let tmp: string;
const json = (r: { body: string }) => JSON.parse(r.body);

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-unmatched-'));
  const sdr = path.join(tmp, 'documents', 'Livros', 'Autor - Fantasma.epub.sdr');
  fs.mkdirSync(sdr, { recursive: true });
  fs.writeFileSync(path.join(sdr, 'metadata.epub.lua'), SAMPLE);
  (await import('../server/db.ts')).db.exec('delete from unmatched');
  const { buildApp } = await import('../server/app.ts');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('unmatched Kindle items', () => {
  it('hides items so the next import does not bring them back, and can restore them', async () => {
    await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: tmp } });
    let list = json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }));
    expect(list).toHaveLength(1);

    const hide = await app.inject({ method: 'POST', url: '/api/kindle/unmatched/ignore', payload: { ids: [list[0].id] } });
    expect(json(hide).hidden).toBe(1);
    expect(json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }))).toHaveLength(0);
    expect(json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched/ignored-count' })).count).toBe(1);

    await app.inject({ method: 'POST', url: '/api/kindle/import', payload: { path: tmp } });
    expect(json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }))).toHaveLength(0);

    await app.inject({ method: 'POST', url: '/api/kindle/unmatched/restore', payload: {} });
    list = json(await app.inject({ method: 'GET', url: '/api/kindle/unmatched' }));
    expect(list).toHaveLength(1);
  });

  it('rejects an empty selection', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/kindle/unmatched/ignore', payload: { ids: [] } });
    expect(res.statusCode).toBe(400);
  });
});
