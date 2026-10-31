import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Finds the folders that the Dropbox and Google Drive desktop apps already keep in sync on this computer.
 * It only looks at local files (Dropbox's own info.json, well-known folder names): no login, no API, no network.
 */
export interface CloudFolders {
  dropbox: string | null;
  drive: string | null;
}

export interface CloudOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Record<string, string | undefined>;
  /** roots to look for "My Drive" in (Windows virtual drives); defaults to D:\ ... Z:\ */
  driveRoots?: string[];
}

const isDir = (p: string | undefined): p is string => {
  try {
    return !!p && fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function dropboxFromInfo(file: string): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const account of [info.personal, info.business, ...Object.values(info)]) {
      const p = account && typeof account === 'object' ? (account as { path?: unknown }).path : undefined;
      if (typeof p === 'string' && isDir(p)) return p;
    }
  } catch {
    // missing or corrupted: fall back to the default folder
  }
  return null;
}

export function detectCloudFolders({ platform = process.platform, home = os.homedir(), env = process.env, driveRoots }: CloudOptions = {}): CloudFolders {
  const infos =
    platform === 'win32'
      ? [env.LOCALAPPDATA, env.APPDATA].filter((d): d is string => !!d).map((d) => path.join(d, 'Dropbox', 'info.json'))
      : [path.join(home, '.dropbox', 'info.json')];
  let dropbox: string | null = null;
  for (const f of infos) dropbox ??= dropboxFromInfo(f);
  if (!dropbox && isDir(path.join(home, 'Dropbox'))) dropbox = path.join(home, 'Dropbox');

  const roots = driveRoots ?? (platform === 'win32' ? Array.from({ length: 23 }, (_, i) => `${String.fromCharCode(68 + i)}:\\`) : []);
  let drive: string | null = null;
  for (const r of roots) {
    drive ??= [path.join(r, 'Meu Drive'), path.join(r, 'My Drive')].find(isDir) ?? null;
  }
  if (!drive) {
    // Drive for desktop on macOS mounts under ~/Library/CloudStorage/GoogleDrive-<account>/My Drive
    let cloud: string[] = [];
    try {
      cloud = fs.readdirSync(path.join(home, 'Library', 'CloudStorage')).filter((d) => d.startsWith('GoogleDrive-'));
    } catch {
      // not macOS
    }
    const candidates = [
      ...cloud.flatMap((d) => [path.join(home, 'Library', 'CloudStorage', d, 'My Drive'), path.join(home, 'Library', 'CloudStorage', d)]),
      path.join(home, 'Google Drive', 'My Drive'),
      path.join(home, 'Google Drive', 'Meu Drive'),
      path.join(home, 'Google Drive'),
    ];
    drive = candidates.find(isDir) ?? null;
  }
  return { dropbox, drive };
}
