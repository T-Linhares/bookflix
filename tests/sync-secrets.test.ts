import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from '../server/db.ts';
import { SyncEngine } from '../server/sync.ts';
import { openForLibrary, sealForLibrary } from '../server/syncCrypto.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-sskeys-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('keys encrypted with the library id', () => {
  const id = '3f2a6c1e-8b7d-4c11-9a52-0d9e5b7c1a44';

  it('round-trips, and the stored text does not show the key', () => {
    const token = sealForLibrary('AIzaSyA-segredo-123', id);
    expect(token).not.toContain('segredo');
    expect(token.startsWith('bfk1:')).toBe(true);
    expect(openForLibrary(token, id)).toBe('AIzaSyA-segredo-123');
  });

  it('is the same text every time for the same key, so an unchanged key never rewrites the cloud file', () => {
    expect(sealForLibrary('sk-abc', id)).toBe(sealForLibrary('sk-abc', id));
    expect(sealForLibrary('sk-abc', id)).not.toBe(sealForLibrary('sk-abd', id));
  });

  it('cannot be opened with another library id, nor after being altered', () => {
    const token = sealForLibrary('sk-abc', id);
    expect(openForLibrary(token, 'outra-biblioteca')).toBeNull();
    expect(openForLibrary(token.slice(0, -3) + 'AAA', id)).toBeNull();
    expect(openForLibrary('lixo', id)).toBeNull();
    expect(openForLibrary('', id)).toBeNull();
  });

  it('handles empty keys and accents', () => {
    expect(openForLibrary(sealForLibrary('', id), id)).toBe('');
    expect(openForLibrary(sealForLibrary('chave-ção', id), id)).toBe('chave-ção');
  });
});

// ---------- two computers sharing one folder ----------

let shared: string;
const clock = { t: 1000 };

interface Dev {
  id: string;
  db: DatabaseSync;
  keys: Record<string, string>;
  engine: SyncEngine;
}
const device = (id: string, keys: Record<string, string> = {}, withKeys = true): Dev => {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  const d: Dev = { id, db, keys: { anthropicKey: '', geminiKey: '', openaiKey: '', googleBooksKey: '', ...keys }, engine: undefined as any };
  d.engine = new SyncEngine({
    db,
    dir: shared,
    deviceId: id,
    now: () => clock.t,
    secrets: withKeys ? { read: () => ({ ...d.keys }), write: (v) => Object.assign(d.keys, v) } : undefined,
  });
  return d;
};
const deviceFile = (id: string) => fs.readFileSync(path.join(shared, 'devices', `${id}.json`), 'utf8');

beforeEach(() => {
  shared = fs.mkdtempSync(path.join(root, 'shared-'));
  clock.t = 1000;
});

describe('API keys travel between computers of the same library', () => {
  it('a new computer receives the keys, and the cloud file never holds them in plain text', () => {
    const A = device('aaa', { geminiKey: 'AIza-do-A', openaiKey: 'sk-do-A' });
    A.engine.init('create');
    A.engine.sync();
    expect(deviceFile('aaa')).not.toContain('AIza-do-A');
    expect(deviceFile('aaa')).not.toContain('sk-do-A');

    const B = device('bbb');
    B.engine.init('join');
    B.engine.sync();
    expect(B.keys).toMatchObject({ geminiKey: 'AIza-do-A', openaiKey: 'sk-do-A', anthropicKey: '', googleBooksKey: '' });
  });

  it('the newest change wins in both directions, including clearing a key', () => {
    const A = device('aaa', { geminiKey: 'velha' });
    A.engine.init('create');
    const B = device('bbb');
    B.engine.init('join');
    A.engine.sync();
    B.engine.sync();
    expect(B.keys.geminiKey).toBe('velha');

    clock.t = 2000;
    B.keys.geminiKey = 'nova-do-B';
    B.keys.anthropicKey = 'sk-ant-B';
    B.engine.sync();
    A.engine.sync();
    expect(A.keys).toMatchObject({ geminiKey: 'nova-do-B', anthropicKey: 'sk-ant-B' });

    clock.t = 3000;
    A.keys.geminiKey = ''; // removed on purpose
    A.engine.sync();
    B.engine.sync();
    expect(B.keys.geminiKey).toBe('');
    expect(B.keys.anthropicKey).toBe('sk-ant-B');
  });

  it('a computer that already has keys is not wiped by one that has none', () => {
    const A = device('aaa', { geminiKey: 'so-do-A' });
    A.engine.init('create');
    const B = device('bbb'); // empty
    B.engine.init('join');
    B.engine.sync();
    A.engine.sync();
    B.engine.sync();
    expect(A.keys.geminiKey).toBe('so-do-A');
    expect(B.keys.geminiKey).toBe('so-do-A');
  });

  it('a computer with sync of keys turned off neither shares nor receives them', () => {
    const A = device('aaa', { geminiKey: 'AIza-do-A' });
    A.engine.init('create');
    A.engine.sync();
    const B = device('bbb', {}, false);
    B.engine.init('join');
    B.engine.sync();
    expect(B.keys.geminiKey).toBe('');
    expect(JSON.parse(deviceFile('bbb')).secrets).toBeUndefined();

    B.keys.openaiKey = 'sk-privada-do-B';
    B.engine.sync();
    A.engine.sync();
    expect(A.keys.openaiKey).toBe('');
  });

  it('ignores, with a warning, keys that cannot be opened with this library id', () => {
    const A = device('aaa', { geminiKey: 'AIza-do-A' });
    A.engine.init('create');
    A.engine.sync();
    const file = JSON.parse(deviceFile('aaa'));
    file.secrets.f.geminiKey = sealForLibrary('x', 'outra-biblioteca');
    fs.writeFileSync(path.join(shared, 'devices', 'aaa.json'), JSON.stringify(file));

    const B = device('bbb');
    B.engine.init('join');
    const s = B.engine.sync();
    expect(B.keys.geminiKey).toBe('');
    expect(s.warnings.join(' ')).toMatch(/chaves/i);
  });

  it('does not rewrite the cloud file when nothing changed', () => {
    const A = device('aaa', { geminiKey: 'AIza-do-A' });
    A.engine.init('create');
    expect(A.engine.sync().wrote).toBe(true);
    expect(A.engine.sync().wrote).toBe(false);
  });
});

describe('the preferred AI model also follows the library', () => {
  it('aiOrder is shared like the other settings', () => {
    const A = device('aaa');
    A.engine.init('create');
    const B = device('bbb');
    B.engine.init('join');
    clock.t = 2000;
    A.db.prepare("insert into settings(key, value) values('aiOrder', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify('anthropic'));
    A.engine.sync();
    B.engine.sync();
    expect(JSON.parse((B.db.prepare("select value from settings where key = 'aiOrder'").get() as { value: string }).value)).toBe('anthropic');
  });
});
