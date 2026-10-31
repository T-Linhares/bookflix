import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmp: string;
let send: typeof import('../server/kindle/send.ts');
let db: typeof import('../server/db.ts').db;

const mk = (...parts: string[]) => fs.mkdirSync(path.join(tmp, ...parts), { recursive: true });

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-detect-'));
  // Linux mounts removable media one level deeper than the base: /media/<user>/<label>
  mk('media', 'user', 'KINDLE', 'documents');
  mk('media', 'user', 'KINDLE', 'system');
  mk('run', 'media', 'user', 'KOBO', 'documents');
  mk('run', 'media', 'user', 'PENDRIVE', 'fotos');
  send = await import('../server/kindle/send.ts');
  db = (await import('../server/db.ts')).db;
  db.prepare("delete from settings where key = 'lastKindleRoot'").run();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('detectKindle on Linux (T9)', () => {
  const bases = () => [path.join(tmp, 'media'), path.join(tmp, 'run', 'media')];

  it('finds /media/<user>/<label> that has documents + system', () => {
    expect(send.detectKindle({ platform: 'linux', bases: bases() })).toBe(path.join(tmp, 'media', 'user', 'KINDLE'));
  });

  it('does not accept a drive that lacks system/koreader, nor a plain pendrive', () => {
    expect(send.detectKindle({ platform: 'linux', bases: [path.join(tmp, 'run', 'media')] })).toBeNull();
  });

  it('accepts /run/media/<user>/<label> when KOReader is installed', () => {
    mk('run', 'media', 'user', 'KOBO', 'koreader');
    expect(send.detectKindle({ platform: 'linux', bases: [path.join(tmp, 'run', 'media')] })).toBe(path.join(tmp, 'run', 'media', 'user', 'KOBO'));
  });

  it('keeps working with a mount directly under the base (macOS /Volumes style)', () => {
    mk('Volumes', 'KINDLE2', 'documents');
    mk('Volumes', 'KINDLE2', 'system');
    expect(send.detectKindle({ platform: 'darwin', bases: [path.join(tmp, 'Volumes')] })).toBe(path.join(tmp, 'Volumes', 'KINDLE2'));
  });

  it('returns null when nothing is mounted', () => {
    expect(send.detectKindle({ platform: 'linux', bases: [path.join(tmp, 'nao-existe')] })).toBeNull();
  });
});
