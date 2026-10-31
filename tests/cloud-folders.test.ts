import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectCloudFolders } from '../server/cloudFolders.ts';

let tmp: string;
let home: string;
let local: string;
let roaming: string;

const mk = (...p: string[]) => fs.mkdirSync(path.join(...p), { recursive: true });
const writeInfo = (dir: string, content: string) => {
  mk(dir);
  fs.writeFileSync(path.join(dir, 'info.json'), content);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-cloud-'));
  home = path.join(tmp, 'home');
  local = path.join(tmp, 'AppData', 'Local');
  roaming = path.join(tmp, 'AppData', 'Roaming');
  mk(home);
  mk(local);
  mk(roaming);
});
afterAll(() => {
  for (const d of fs.readdirSync(os.tmpdir())) if (d.startsWith('bookflix-cloud-')) fs.rmSync(path.join(os.tmpdir(), d), { recursive: true, force: true });
});

const win = (extra: object = {}) => ({ platform: 'win32' as const, home, env: { LOCALAPPDATA: local, APPDATA: roaming }, driveRoots: [] as string[], ...extra });
const linux = (extra: object = {}) => ({ platform: 'linux' as const, home, env: {}, ...extra });

describe('Dropbox (T10)', () => {
  it('reads personal.path from info.json (Windows, LOCALAPPDATA)', () => {
    const dbx = path.join(tmp, 'D', 'Dropbox');
    mk(dbx);
    writeInfo(path.join(local, 'Dropbox'), JSON.stringify({ personal: { path: dbx } }));
    expect(detectCloudFolders(win()).dropbox).toBe(dbx);
  });

  it('also looks in APPDATA, and uses business.path when there is no personal account', () => {
    const biz = path.join(tmp, 'Dropbox (Empresa)');
    mk(biz);
    writeInfo(path.join(roaming, 'Dropbox'), JSON.stringify({ business: { path: biz } }));
    expect(detectCloudFolders(win()).dropbox).toBe(biz);
  });

  it('reads ~/.dropbox/info.json on Linux', () => {
    const dbx = path.join(tmp, 'meus-arquivos', 'Dropbox');
    mk(dbx);
    writeInfo(path.join(home, '.dropbox'), JSON.stringify({ personal: { path: dbx } }));
    expect(detectCloudFolders(linux()).dropbox).toBe(dbx);
  });

  it('falls back to ~/Dropbox when info.json is missing, and to null when that does not exist either', () => {
    expect(detectCloudFolders(linux()).dropbox).toBeNull();
    mk(home, 'Dropbox');
    expect(detectCloudFolders(linux()).dropbox).toBe(path.join(home, 'Dropbox'));
  });

  it('ignores a corrupted info.json without throwing', () => {
    writeInfo(path.join(home, '.dropbox'), '{ not json');
    expect(() => detectCloudFolders(linux())).not.toThrow();
    expect(detectCloudFolders(linux()).dropbox).toBeNull();
  });

  it('ignores an info.json that points to a folder that no longer exists', () => {
    writeInfo(path.join(home, '.dropbox'), JSON.stringify({ personal: { path: path.join(tmp, 'sumiu') } }));
    expect(detectCloudFolders(linux()).dropbox).toBeNull();
  });
});

describe('POST /api/cloud-folders/library', () => {
  const post = async (cloud: () => { dropbox: string | null; drive: string | null }, service: string) => {
    const { buildApp } = await import('../server/app.ts');
    const app = await buildApp({ cloudFolders: cloud });
    const res = await app.inject({ method: 'POST', url: '/api/cloud-folders/library', payload: { service } });
    await app.close();
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it('creates "Livros" inside the detected folder of the chosen service and returns its path', async () => {
    const dbx = path.join(tmp, 'Dropbox');
    mk(dbx);
    const r = await post(() => ({ dropbox: dbx, drive: null }), 'dropbox');
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(path.join(dbx, 'Livros'));
    expect(fs.statSync(r.body.path).isDirectory()).toBe(true);
  });

  it('is happy when the folder already exists and never touches existing books', async () => {
    const drive = path.join(tmp, 'Meu Drive');
    mk(drive, 'Livros');
    fs.writeFileSync(path.join(drive, 'Livros', 'a.epub'), 'x');
    const r = await post(() => ({ dropbox: null, drive }), 'drive');
    expect(r.status).toBe(200);
    expect(fs.readFileSync(path.join(drive, 'Livros', 'a.epub'), 'utf8')).toBe('x');
  });

  it('refuses unknown services and services that were not detected, creating nothing', async () => {
    expect((await post(() => ({ dropbox: null, drive: null }), 'dropbox')).status).toBe(400);
    expect((await post(() => ({ dropbox: path.join(tmp, 'x'), drive: null }), '../etc')).status).toBe(400);
    expect(fs.existsSync(path.join(tmp, 'x'))).toBe(false);
  });
});

describe('Google Drive (T10)', () => {
  it('finds "Meu Drive" / "My Drive" on a Windows virtual drive', () => {
    const g = path.join(tmp, 'G');
    mk(g, 'Meu Drive');
    expect(detectCloudFolders(win({ driveRoots: [path.join(tmp, 'F'), g] })).drive).toBe(path.join(g, 'Meu Drive'));
    const h = path.join(tmp, 'H');
    mk(h, 'My Drive');
    expect(detectCloudFolders(win({ driveRoots: [h] })).drive).toBe(path.join(h, 'My Drive'));
  });

  it('finds ~/Google Drive on Linux/macOS, preferring the My Drive subfolder', () => {
    mk(home, 'Google Drive', 'My Drive');
    expect(detectCloudFolders(linux()).drive).toBe(path.join(home, 'Google Drive', 'My Drive'));
  });

  it('is null on Linux when there is no client (Google has no official one)', () => {
    expect(detectCloudFolders(linux()).drive).toBeNull();
  });

  it('reports both services independently', () => {
    mk(home, 'Dropbox');
    mk(home, 'Google Drive');
    const r = detectCloudFolders(linux());
    expect(r.dropbox).toBe(path.join(home, 'Dropbox'));
    expect(r.drive).toBe(path.join(home, 'Google Drive'));
  });
});
