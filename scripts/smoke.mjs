// Starts the desktop app headless-ish in smoke mode with a throw-away data folder and prints its self-check.
// Usage: node scripts/smoke.mjs [path-to-packaged-executable]   (default: electron from node_modules, running this folder)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const exe = process.argv[2] ?? require('electron');
// CI containers cannot use Chromium's sandbox (no setuid helper); everywhere else it stays on
const args = [...(process.argv[2] ? [] : ['.']), ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : [])];
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bookflix-smoke-'));

const child = spawn(exe, args, { env: { ...process.env, BOOKFLIX_SMOKE: '1', BOOKFLIX_DATA: data, ELECTRON_ENABLE_LOGGING: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const timer = setTimeout(() => child.kill(), 60_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const line = out.split(/\r?\n/).find((l) => l.startsWith('SMOKE '));
  console.log(line ?? `sem resultado (código ${code})\n${out.slice(-2000)}`);
  fs.rmSync(data, { recursive: true, force: true });
  process.exit(line && code === 0 ? 0 : 1);
});
