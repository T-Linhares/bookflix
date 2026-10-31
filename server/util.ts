import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const now = () => Math.floor(Date.now() / 1000);

/** Lowercase, accent-free, alphanumeric-only form used for comparisons. */
export const norm = (s?: string | null) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function splitAuthors(s?: string | null): string[] {
  return (s ?? '')
    .split(/\s*(?:;|\s&\s|\sand\s|\se\s)\s*/i)
    .map((a) => a.trim())
    .filter(Boolean);
}

export const joinAuthors = (a: string[]) => a.join('; ');

/** Token-overlap similarity in [0,1]: how much of the shorter title is in the longer, penalising very different lengths. */
export function similarity(a?: string | null, b?: string | null): number {
  const ta = new Set(norm(a).split(' ').filter(Boolean));
  const tb = new Set(norm(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const contain = inter / Math.min(ta.size, tb.size);
  const jaccard = inter / (ta.size + tb.size - inter);
  return Math.min(contain, jaccard * 1.6);
}

/** Same algorithm as KOReader's util.partialMD5, so hashes match the sidecar files. */
export async function partialMd5(file: string): Promise<string> {
  const fh = await fs.open(file, 'r');
  try {
    const md5 = crypto.createHash('md5');
    const buf = Buffer.alloc(1024);
    const offsets = [0, ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i)];
    for (const off of offsets) {
      const { bytesRead } = await fh.read(buf, 0, 1024, off);
      if (!bytesRead) break;
      md5.update(buf.subarray(0, bytesRead));
    }
    return md5.digest('hex');
  } finally {
    await fh.close();
  }
}

export function partialMd5OfBuffer(data: Buffer): string {
  const md5 = crypto.createHash('md5');
  for (const off of [0, ...Array.from({ length: 11 }, (_, i) => 1024 * 4 ** i)]) {
    if (off >= data.length) break;
    md5.update(data.subarray(off, Math.min(off + 1024, data.length)));
  }
  return md5.digest('hex');
}

export const sha1 = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export async function fetchJson<T = any>(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchRaw(url: string, timeoutMs = 8000): Promise<{ status: number; json: any; error?: any; retryAfter?: number }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json().catch(() => null);
    if (res.ok) return { status: res.status, json: body };
    const wait = Number(res.headers.get('retry-after'));
    return { status: res.status, json: null, error: body?.error, retryAfter: Number.isFinite(wait) && wait > 0 ? wait : undefined };
  } catch {
    return { status: 0, json: null };
  }
}

export const SUPPORTED_EXT = ['.epub', '.pdf', '.mobi', '.azw3', '.azw', '.fb2', '.cbz', '.djvu'];
export const isBookFile = (name: string) => SUPPORTED_EXT.some((e) => name.toLowerCase().endsWith(e));
