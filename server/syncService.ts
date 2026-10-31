import crypto from 'node:crypto';
import fs from 'node:fs';
import { SCREENSAVERS_DIR, db, getSetting, reindexBook, setSetting } from './db.ts';
import { SECRET_KEYS, getSettings, updateSettings } from './settings.ts';
import { SyncEngine, SyncError, SyncSummary, syncDirOf } from './sync.ts';

// Glue between the sync engine and the running app: which folder, which device, when to run, what to tell the UI.

function deviceId(): string {
  let id = getSetting<string>('syncDeviceId');
  if (!id) {
    id = crypto.randomUUID();
    setSetting('syncDeviceId', id);
  }
  return id;
}

/** This computer's API keys as the sync engine sees them; none when the user turned key sharing off. */
function keyStore() {
  if (!getSettings().syncKeys) return undefined;
  return {
    read: () => Object.fromEntries(SECRET_KEYS.map((k) => [k, getSettings()[k]])) as Record<string, string>,
    write: (values: Record<string, string>) => void updateSettings(values as Partial<ReturnType<typeof getSettings>>),
  };
}

function engine(): SyncEngine {
  const { booksDir } = getSettings();
  if (!booksDir) throw Object.assign(new Error('Escolha a pasta da biblioteca em Ajustes antes de ativar a sincronização.'), { statusCode: 400 });
  if (!fs.existsSync(booksDir)) throw Object.assign(new Error(`Pasta não encontrada: ${booksDir}`), { statusCode: 400 });
  return new SyncEngine({ db, dir: syncDirOf(booksDir), deviceId: deviceId(), reindex: (id) => reindexBook(id), screensaverDir: SCREENSAVERS_DIR, secrets: keyStore() });
}

let lastSync: { at: number; summary?: SyncSummary; error?: string } | null = null;
let running = false;

export function syncStatus() {
  const { booksDir } = getSettings();
  const libraryId = getSetting<string>('syncLibraryId') ?? null;
  const found = booksDir ? SyncEngine.libraryIdIn(booksDir) : null;
  let peers: { id: string; writtenAt: number }[] = [];
  if (libraryId && booksDir && fs.existsSync(booksDir)) peers = engine().peers().filter((p) => p.id !== deviceId());
  return {
    booksDir: !!booksDir,
    enabled: !!libraryId,
    libraryId,
    foundInFolder: found,
    mismatch: !!libraryId && !!found && found !== libraryId,
    deviceId: deviceId(),
    peers,
    lastSync,
  };
}

export function enableSync(mode: 'create' | 'join') {
  const libraryId = engine().init(mode);
  scheduleSync(500);
  return { libraryId };
}

export function disableSync() {
  const { booksDir } = getSettings();
  if (booksDir && fs.existsSync(booksDir)) engine().leave();
  else db.prepare("delete from settings where key in ('syncLibraryId', 'syncLastHash')").run();
}

/** One round: reads the other devices' files, merges them, writes this device's file. Never overlaps itself. */
export async function runSync(): Promise<SyncSummary> {
  if (running) return lastSync?.summary ?? { applied: 0, pending: 0, warnings: [], devices: 0, wrote: false };
  running = true;
  try {
    const summary = engine().sync();
    lastSync = { at: Date.now(), summary };
    return summary;
  } catch (e: any) {
    lastSync = { at: Date.now(), error: String(e?.message ?? e) };
    throw e;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | undefined;
/** Debounced: many changes in a row become one sync. A no-op when sync is off. */
export function scheduleSync(delayMs = 5000) {
  if (!getSetting('syncLibraryId')) return;
  clearTimeout(timer);
  timer = setTimeout(() => void runSync().catch(() => {}), delayMs);
  timer.unref?.();
}

let loop: NodeJS.Timeout | undefined;
/** Picks up what other devices wrote while this one stayed open. */
export function startSyncLoop(everyMs = 5 * 60 * 1000) {
  clearInterval(loop);
  loop = setInterval(() => void runSync().catch(() => {}), everyMs);
  loop.unref?.();
  scheduleSync(2000);
}

export { SyncError };
