import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import crypto from 'node:crypto';
import path from 'node:path';
import { isAllowedExternalUrl } from '../shared/bugReport.ts';

// Desktop shell. The server (server/start.ts) runs inside this process on a random loopback port; every request the window
// makes carries a per-run token, so no web page and no other program can talk to it. Nothing here phones home.

const SMOKE = process.env.BOOKFLIX_SMOKE === '1';
const HOST = '127.0.0.1';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// The server reads these when its modules load, so they are set before the first (dynamic) import of it.
if (!process.env.BOOKFLIX_DATA) process.env.BOOKFLIX_DATA = app.getPath('userData');
if (app.isPackaged) process.env.BOOKFLIX_WEB_DIST = path.join(process.resourcesPath, 'web-dist');

let win: BrowserWindow | null = null;
let server: { port: number; close(): Promise<void> } | null = null;
const token = crypto.randomBytes(24).toString('hex');

function secureStoreAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // on Linux without a keyring Electron falls back to a hard-coded key: that is not protection, so do not claim it
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
}

async function smokeTest(port: number) {
  const out: Record<string, unknown> = { electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec("create virtual table t using fts5(a, tokenize='unicode61 remove_diacritics 2'); insert into t values ('Ação e reação');");
    out.fts5 = (db.prepare("select count(*) n from t where t match 'acao'").get() as { n: number }).n === 1;
    const base = `http://${HOST}:${port}`;
    out.withToken = (await fetch(`${base}/api/facets`, { headers: { 'x-bookflix-token': token } })).status;
    out.withoutToken = (await fetch(`${base}/api/facets`)).status;
    out.foreignOrigin = (await fetch(`${base}/api/settings`, { headers: { origin: 'https://evil.example', 'x-bookflix-token': token } })).status;
    out.index = (await fetch(base, { headers: { 'x-bookflix-token': token } })).status;
    out.secureStore = secureStoreAvailable();
    out.ok = out.fts5 === true && out.withToken === 200 && out.withoutToken === 403 && out.foreignOrigin === 403 && out.index === 200;
  } catch (e: any) {
    out.ok = false;
    out.error = String(e?.message ?? e);
  }
  console.log(`SMOKE ${JSON.stringify(out)}`);
  app.exit(out.ok ? 0 : 1);
}

async function boot() {
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const { startServer } = await import('../server/start.ts');
  const { setCipher } = await import('../server/secrets.ts');
  const { protectStoredSecrets } = await import('../server/settings.ts');
  setCipher({
    available: secureStoreAvailable,
    encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
    decrypt: (e) => safeStorage.decryptString(Buffer.from(e, 'base64')),
  });
  protectStoredSecrets();

  server = await startServer({ port: 0, host: HOST, token });
  const origin = `http://${HOST}:${server.port}`;

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, cb) => {
    details.requestHeaders['X-Bookflix-Token'] = token;
    cb({ requestHeaders: details.requestHeaders });
  });

  if (SMOKE) return smokeTest(server.port);

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#0b0b0f',
    show: false,
    webPreferences: { preload: path.join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = null));

  // links that leave the app go to the default browser, and only to allow-listed hosts
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    }
  });

  await win.loadURL(origin);
}

ipcMain.handle('pick-folder', async (_e, current?: string) => {
  if (!win) return null;
  const r = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: typeof current === 'string' && current ? current : undefined,
  });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});

ipcMain.handle('open-external', async (_e, url: unknown) => {
  if (typeof url !== 'string' || !isAllowedExternalUrl(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('copy-text', (_e, text: unknown) => {
  if (typeof text === 'string') clipboard.writeText(text.slice(0, 200_000));
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => void server?.close());

boot().catch((e) => {
  console.error(e);
  dialog.showErrorBox('Bookflix não conseguiu iniciar', String(e?.message ?? e));
  app.exit(1);
});
