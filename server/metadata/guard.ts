import crypto from 'node:crypto';
import { db } from '../db.ts';
import { fetchRaw } from '../util.ts';

/**
 * Everything between the app and Google Books, to spend as little of Google's quota as possible:
 *  - a local cache (a repeated search costs nothing and even works while Google is blocking us),
 *  - a minimum gap between requests (Google also limits per minute),
 *  - one retry after a short wait when Google says "slow down" (429/503),
 *  - a pause (breaker): after a second refusal the app stops asking Google for a while instead of making it worse,
 *    and the other sources (Open Library, BrasilAPI) carry on.
 * Nothing leaves the computer except the same requests as before; the cache is a table in the local database.
 */

export interface GoogleRes {
  status: number;
  json: any;
  error?: any;
  retryAfter?: number;
  /** answered from the local cache */
  cached?: boolean;
  /** not sent: Google is paused after refusing us */
  blocked?: boolean;
}

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/** Mutable on purpose: tests replace the clock, the sleep and the network. */
export const guardConfig = {
  minGapMs: 400,
  /** longer waits than this are not worth holding the screen for: pause instead */
  retryMaxWaitMs: 5000,
  retryDefaultWaitMs: 1500,
  breakerMs: 10 * MIN,
  breakerDailyMs: 60 * MIN,
  breakerMinMs: MIN,
  breakerMaxMs: 60 * MIN,
  ttlMs: 30 * DAY,
  /** "no results" may change when Google learns the book */
  ttlEmptyMs: 2 * DAY,
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  fetch: fetchRaw as (url: string) => Promise<GoogleRes>,
};

let blockedUntil = 0;
let lastStart = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Forgets the pause, the spacing and the cache. For tests, and for "start over". */
export function resetGuard() {
  blockedUntil = 0;
  lastStart = 0;
  chain = Promise.resolve();
  db.exec('delete from lookup_cache');
}

/** Milliseconds left of the pause, 0 when Google is open for business. */
export const googleBlockedFor = () => Math.max(0, blockedUntil - guardConfig.now());

/** Google's "too many requests" answers (also how the older API said it, as a 403). */
export const isQuotaError = (res: { status: number; error?: any }) => res.status === 429 || /rateLimitExceeded|RATE_LIMIT|dailyLimitExceeded/.test(JSON.stringify(res.error ?? ''));

const cacheKey = (url: string) => {
  const u = new URL(url);
  u.searchParams.delete('key'); // whose key it was does not change the answer, and it must never be stored
  return crypto.createHash('sha1').update(u.toString()).digest('hex');
};

function fromCache(key: string): GoogleRes | null {
  const row = db.prepare('select json, at from lookup_cache where key = ?').get(key) as { json: string; at: number } | undefined;
  if (!row) return null;
  try {
    const json = JSON.parse(row.json);
    const ttl = json?.items?.length ? guardConfig.ttlMs : guardConfig.ttlEmptyMs;
    return guardConfig.now() - row.at < ttl ? { status: 200, json, cached: true } : null;
  } catch {
    return null;
  }
}

function toCache(key: string, json: unknown) {
  const now = guardConfig.now();
  db.prepare('delete from lookup_cache where at < ?').run(now - guardConfig.ttlMs);
  db.prepare('insert into lookup_cache(key, json, at) values(?,?,?) on conflict(key) do update set json = excluded.json, at = excluded.at').run(key, JSON.stringify(json), now);
}

/** One request at a time, with the minimum gap between their starts. */
function turn<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastStart + guardConfig.minGapMs - guardConfig.now();
    if (wait > 0) await guardConfig.sleep(wait);
    lastStart = guardConfig.now();
    return fn();
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const refusal = (): GoogleRes => ({ status: 429, json: null, error: { errors: [{ reason: 'rateLimitExceeded' }] }, blocked: true });

function openBreaker(res: GoogleRes) {
  const c = guardConfig;
  const daily = /dailyLimitExceeded/.test(JSON.stringify(res.error ?? ''));
  const ms = res.retryAfter ? Math.min(c.breakerMaxMs, Math.max(c.breakerMinMs, res.retryAfter * 1000)) : daily ? c.breakerDailyMs : c.breakerMs;
  blockedUntil = c.now() + ms;
}

export async function googleRequest(url: string): Promise<GoogleRes> {
  const key = cacheKey(url);
  const hit = fromCache(key);
  if (hit) return hit;
  if (googleBlockedFor() > 0) return refusal();

  return turn(async () => {
    if (googleBlockedFor() > 0) return refusal(); // the pause started while this one waited its turn
    let res = await guardConfig.fetch(url);
    if (res.status === 429 || res.status === 503) {
      const wait = res.retryAfter ? res.retryAfter * 1000 : guardConfig.retryDefaultWaitMs;
      if (wait <= guardConfig.retryMaxWaitMs) {
        await guardConfig.sleep(wait);
        lastStart = guardConfig.now();
        res = await guardConfig.fetch(url);
      }
    }
    if (isQuotaError(res)) openBreaker(res);
    else if (res.status === 200 && res.json && typeof res.json === 'object') toCache(key, res.json);
    return res;
  });
}
